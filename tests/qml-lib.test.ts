// lib/format.mjs is the logic the QML views run; it is plain JS so it is tested here.
import { assert, assertEquals } from "jsr:@std/assert@1"
import * as Format from "../lib/format.mjs"

Deno.test("safeLink: second check before opening a URL", () => {
  assertEquals(Format.safeLink("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c")
  assertEquals(Format.safeLink("http://192.168.1.10:8123/lovelace"), "http://192.168.1.10:8123/lovelace")
  assertEquals(Format.safeLink("javascript:alert(1)"), "")
  assertEquals(Format.safeLink("file:///etc/passwd"), "")
  assertEquals(Format.safeLink("https://user:pw@example.com/"), "")
  assertEquals(Format.safeLink("https://example.com/\nX-Header: 1"), "")
  assertEquals(Format.safeLink("https://exa mple.com"), "")
  assertEquals(Format.safeLink(null), "")
  assertEquals(Format.linkHost("https://example.com:8443/x"), "example.com")
  assertEquals(Format.linkHost("ftp://example.com"), "")
})

Deno.test("broker warnings: down or failing brokers only", () => {
  const brokers = [
    { id: "a", enabled: true, state: "connected", error: null },
    { id: "b", enabled: true, state: "connecting", error: null }, // first attempt: no warning yet
    { id: "c", enabled: true, state: "connecting", error: "Connection refused" }, // retrying after failure
    { id: "d", enabled: true, state: "disconnected", error: "Connection lost" },
    { id: "e", enabled: true, state: "error", error: "Invalid configuration" },
    { id: "f", enabled: false, state: "disabled", error: null },
  ]
  assertEquals(Format.brokerWarnings(brokers).map((b: { id: string }) => b.id), ["c", "d", "e"])
  assertEquals(Format.brokerWarnings(null), [])
})

Deno.test("settings: entry lookup and clamping", () => {
  const bar = { layout: { left: [{ id: "omarchy.menu" }], right: [{ id: "odach.mqtt-notifier", initialMessageCount: 5 }] } }
  assertEquals(Format.findEntrySettings(bar, "odach.mqtt-notifier").initialMessageCount, 5)
  assertEquals(Format.findEntrySettings(bar, "missing"), {})
  assertEquals(Format.findEntrySettings(null, "x"), {})
  assertEquals(Format.clampInt("7", 10, 1, 200), 7)
  assertEquals(Format.clampInt(9999, 10, 1, 200), 200)
  assertEquals(Format.clampInt("junk", 10, 1, 200), 10)
})

Deno.test("rows: helper notifications become typed ListModel rows", () => {
  const row = Format.toRow({
    seq: 3,
    id: "550e8400-e29b-41d4-a716-446655440000",
    timestamp: "2026-11-13T05:51:04.123Z",
    broker: "HomeMQTT",
    brokerId: "home",
    topic: "home/garage",
    text: "<b>x</b>",
    icon: null,
    link: "javascript:x",
    read: false,
  })
  assertEquals(row.icon, "")
  assertEquals(row.link, "")
  assertEquals(row.body, "<b>x</b>") // kept verbatim; the view renders it as plain text
  assertEquals(row.read, false)
  for (const value of Object.values(row)) assert(value !== null && value !== undefined)
})

Deno.test("icons: every constant has a glyph and a tone", () => {
  for (const icon of ["ICON_QUESTION", "ICON_WARN", "ICON_ERROR", "ICON_OK"]) {
    assert(Format.iconGlyph(icon).length > 0)
  }
  assertEquals(Format.iconGlyph("nope"), Format.iconGlyph(""))
  assertEquals(Format.iconTone("ICON_ERROR"), "urgent")
  assertEquals(Format.iconTone("ICON_WARN"), "accent")
})
