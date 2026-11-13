import { assert, assertEquals } from "jsr:@std/assert@1"
import { NotificationStore } from "../helper/store.ts"

const input = (text: string) => ({
  brokerId: "b",
  broker: "B",
  subscriptionId: "s",
  topic: "t/x",
  text,
  icon: null,
  link: null,
})

async function tempStore(retention = 1000): Promise<NotificationStore> {
  const dir = await Deno.makeTempDir({ prefix: "mqttn-store-" })
  const store = new NotificationStore(dir)
  await store.open(retention)
  return store
}

Deno.test("store: append, page newest first, cursor pagination without duplicates", async () => {
  const store = await tempStore()
  for (let i = 1; i <= 25; i++) await store.add(input("m" + i))
  const p1 = store.page(10)
  assertEquals(p1.items.map((n) => n.text), [
    "m25",
    "m24",
    "m23",
    "m22",
    "m21",
    "m20",
    "m19",
    "m18",
    "m17",
    "m16",
  ])
  assert(p1.hasMore)
  // A message arriving between pages must not shift the next page.
  await store.add(input("m26"))
  const p2 = store.page(10, p1.items[p1.items.length - 1].seq)
  assertEquals(p2.items[0].text, "m15")
  const p3 = store.page(10, p2.items[p2.items.length - 1].seq)
  assertEquals(p3.items.map((n) => n.text), ["m5", "m4", "m3", "m2", "m1"])
  assertEquals(p3.hasMore, false)
})

Deno.test("store: history survives reopen; read cursor semantics", async () => {
  const store = await tempStore()
  await store.add(input("old1"))
  await store.add(input("old2"))
  assertEquals(store.unread, 2)
  await store.markAllRead()
  assertEquals(store.unread, 0)
  await store.add(input("new"))
  assertEquals(store.unread, 1)
  await store.flush()

  const again = new NotificationStore(store.dir)
  await again.open()
  const page = again.page(10)
  assertEquals(page.items.map((n) => [n.text, n.read]), [["new", false], [
    "old2",
    true,
  ], ["old1", true]])
  assertEquals(again.unread, 1)
})

Deno.test("store: retention trims oldest and compacts the file", async () => {
  const store = await tempStore(5)
  for (let i = 1; i <= 40; i++) await store.add(input("m" + i))
  await store.flush()
  assertEquals(store.total, 5)
  assertEquals(store.page(10).items.map((n) => n.text), [
    "m40",
    "m39",
    "m38",
    "m37",
    "m36",
  ])
  const lines = (await Deno.readTextFile(store.file)).trim().split("\n")
  assert(
    lines.length <= 5 + 20,
    "file is compacted with bounded slack (" + lines.length + " lines)",
  )

  await store.setRetention(2)
  assertEquals(store.page(10).items.map((n) => n.text), ["m40", "m39"])
  assertEquals(
    (await Deno.readTextFile(store.file)).trim().split("\n").length,
    2,
  )
})

Deno.test("store: corrupted lines do not prevent loading valid records", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqttn-store-" })
  const good = (id: string, text: string) =>
    JSON.stringify({
      id,
      timestamp: "2026-11-13T05:51:04.123Z",
      brokerId: "b",
      broker: "B",
      topic: "t",
      text,
    })
  await Deno.writeTextFile(
    dir + "/notifications.jsonl",
    [
      good("550e8400-e29b-41d4-a716-446655440000", "first"),
      "{not json",
      JSON.stringify({ id: "nope", text: "bad id" }),
      good("550e8400-e29b-41d4-a716-446655440001", "second"),
      '{"id":"550e8400-e29b-41d4-a716-44665544', // truncated last line (crash mid-append)
    ].join("\n"),
  )
  const store = new NotificationStore(dir)
  await store.open()
  assertEquals(store.skippedOnLoad, 3)
  assertEquals(store.page(10).items.map((n) => n.text), ["second", "first"])
  // The file was rewritten without the bad lines.
  assertEquals(
    (await Deno.readTextFile(store.file)).trim().split("\n").length,
    2,
  )
})

Deno.test("store: clear removes history and resets unread; seq keeps growing", async () => {
  const store = await tempStore()
  await store.add(input("a"))
  const before = await store.add(input("b"))
  await store.clear()
  assertEquals(store.total, 0)
  assertEquals(store.unread, 0)
  assertEquals(store.page(10).items.length, 0)
  const after = await store.add(input("c"))
  assert(after.seq > before.seq)
  assertEquals(after.read, false)
})

Deno.test("store: export and import round-trip", async () => {
  const store = await tempStore()
  await store.add(input("a"))
  await store.add(input("b"))
  const path = store.dir + "/export.json"
  assertEquals(await store.exportTo(path), 2)
  const other = await tempStore()
  await other.add(input("local"))
  const result = await other.importFrom(path)
  assertEquals(result, { imported: 2, skipped: 0 })
  assertEquals(other.total, 3)
  // Importing the same file again skips known ids.
  assertEquals((await other.importFrom(path)).imported, 0)
})

Deno.test("store: unsafe links in stored records are dropped on load", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqttn-store-" })
  await Deno.writeTextFile(
    dir + "/notifications.jsonl",
    JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440009",
      timestamp: "2026-11-13T05:51:04Z",
      text: "x",
      link: "javascript:alert(1)",
      icon: "ICON_NOPE",
    }) + "\n",
  )
  const store = new NotificationStore(dir)
  await store.open()
  const [n] = store.page(1).items
  assertEquals(n.link, null)
  assertEquals(n.icon, null)
})
