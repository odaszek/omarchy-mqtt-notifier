import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1"
import { brokersForFile, saveBrokers, validateBrokers } from "../helper/settings.ts"

const broker = (over: Record<string, unknown> = {}) => ({
  id: "home",
  name: "Home",
  host: "192.168.1.10",
  port: 1883,
  subscriptions: [{ id: "all", topic: "home/#", qos: 1, parserScript: "" }],
  ...over,
})

Deno.test("settings: validation reports field paths", () => {
  assertEquals(validateBrokers([broker()]), [])
  const errors = validateBrokers([
    broker({ id: "bad id", host: "", port: 70000 }),
    broker({ id: "dup" }),
    broker({
      id: "dup",
      subscriptions: [{ id: "s", topic: "a/#/b" }, {
        id: "s",
        topic: "x",
        qos: 3,
      }],
    }),
  ])
  const paths = errors.map((e) => e.path)
  assert(paths.includes("brokers[0].id"))
  assert(paths.includes("brokers[0].host"))
  assert(paths.includes("brokers[0].port"))
  assert(paths.includes("brokers[2].id"))
  assert(paths.includes("brokers[2].subscriptions[0].topic"))
  assert(paths.includes("brokers[2].subscriptions[1].id"))
  assert(paths.includes("brokers[2].subscriptions[1].qos"))
  assertEquals(validateBrokers("nope")[0].path, "brokers")
})

Deno.test("settings: file form keeps known fields and drops runtime ones", () => {
  const [b] = brokersForFile([{
    ...broker(),
    problems: ["x"],
    tls: { rejectUnauthorized: false, ca: "ca.pem" },
  }])
  assertEquals(b.id, "home")
  assertEquals(b.tls, { rejectUnauthorized: false, ca: "ca.pem" })
  assertEquals("problems" in b, false)
  assertEquals(b.subscriptions[0].parserScript, "")
  const [withFile] = brokersForFile([
    broker({
      subscriptions: [{
        id: "f",
        topic: "t",
        parserFile: "f.js",
        parserScript: "ignored",
      }],
    }),
  ])
  assertEquals(withFile.subscriptions[0].parserFile, "f.js")
  assertEquals("parserScript" in withFile.subscriptions[0], false)
})

Deno.test("settings: save keeps other keys, writes parser files, reports removed brokers", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqttn-settings-" })
  await Deno.writeTextFile(
    dir + "/config.json",
    JSON.stringify({
      version: 1,
      advanced: { parserTimeoutMs: 500 },
      custom: true,
      brokers: [broker(), broker({ id: "old" })],
    }),
  )
  const { removedBrokerIds } = await saveBrokers(dir, [
    broker({ name: "Renamed" }),
  ], { "climate.js": "msgout = msgin" })
  assertEquals(removedBrokerIds, ["old"])
  const saved = JSON.parse(await Deno.readTextFile(dir + "/config.json"))
  assertEquals(saved.advanced, { parserTimeoutMs: 500 })
  assertEquals(saved.custom, true)
  assertEquals(saved.brokers.length, 1)
  assertEquals(saved.brokers[0].name, "Renamed")
  assertEquals(
    await Deno.readTextFile(dir + "/parsers/climate.js"),
    "msgout = msgin",
  )
  await assertRejects(
    () => saveBrokers(dir, [broker()], { "../escape.js": "x" }),
    Error,
    "inside",
  )
})

Deno.test("settings: a hand-edited file with a syntax error is never overwritten", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqttn-settings-" })
  await Deno.writeTextFile(dir + "/config.json", '{ "brokers": [ oops')
  await assertRejects(
    () => saveBrokers(dir, [broker()]),
    Error,
    "syntax error",
  )
  assertEquals(
    await Deno.readTextFile(dir + "/config.json"),
    '{ "brokers": [ oops',
  )
})
