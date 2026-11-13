import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1"
import { isValidFilter, matchTopic } from "../helper/topic.ts"
import { decodePayload, escapeMarkup, toString, validateLink, validateOutput } from "../helper/validate.ts"
import { normalizeConfig, resolveInside } from "../helper/config.ts"
import { backoffDelay } from "../helper/mqtt_manager.ts"
import { matchingSubscriptions } from "../helper/processor.ts"
import { notifyArgs } from "../helper/notifier.ts"
import { parseXml } from "../helper/worker/xml.js"

Deno.test("topic filters: wildcards", () => {
  assert(matchTopic("home/#", "home/garage/door"))
  assert(matchTopic("home/#", "home"))
  assert(matchTopic("home/+/door", "home/garage/door"))
  assertFalse(matchTopic("home/+/door", "home/garage/side/door"))
  assertFalse(matchTopic("home/+", "home"))
  assert(matchTopic("#", "anything/at/all"))
  assertFalse(matchTopic("#", "$SYS/broker/uptime"))
  assertFalse(matchTopic("+/broker/uptime", "$SYS/broker/uptime"))
  assert(matchTopic("$SYS/#", "$SYS/broker/uptime"))
  assert(matchTopic("a//b", "a//b"))
  assertFalse(matchTopic("a/b", "a/b/c"))
})

Deno.test("topic filters: validity", () => {
  assert(isValidFilter("a/+/b/#"))
  assertFalse(isValidFilter("a/#/b"))
  assertFalse(isValidFilter("a/b#"))
  assertFalse(isValidFilter("a+/b"))
  assertFalse(isValidFilter(""))
})

Deno.test("payload: invalid UTF-8 becomes U+FFFD", () => {
  assertEquals(decodePayload(new Uint8Array([0x48, 0x69, 0xff, 0xfe, 0x21])), "Hi��!")
  assertEquals(decodePayload(new TextEncoder().encode("Zażółć 29.5 °C")), "Zażółć 29.5 °C")
})

Deno.test("to_string is deterministic", () => {
  assertEquals(toString("x"), "x")
  assertEquals(toString(29.5), "29.5")
  assertEquals(toString(true), "true")
  assertEquals(toString(null), "")
  assertEquals(toString({ a: [1, 2] }), '{"a":[1,2]}')
})

Deno.test("links: only absolute http(s) without credentials", () => {
  assertEquals(validateLink("https://example.com/x?y=1"), "https://example.com/x?y=1")
  assertEquals(validateLink("http://192.168.1.10:8123"), "http://192.168.1.10:8123/")
  assertEquals(validateLink("javascript:alert(1)"), null)
  assertEquals(validateLink("file:///etc/passwd"), null)
  assertEquals(validateLink("https://user:pw@example.com"), null)
  assertEquals(validateLink("/relative"), null)
  assertEquals(validateLink(42), null)
})

Deno.test("parser output validation", () => {
  const ok = validateOutput({ msgout: "  hi  ", msgicon: "ICON_WARN", msglink: "https://a.b" })
  assert(ok.ok)
  if (ok.ok) {
    assertEquals(ok.value.text, "hi")
    assertEquals(ok.value.icon, "ICON_WARN")
    assertEquals(ok.value.link, "https://a.b/")
  }
  const badIcon = validateOutput({ msgout: "x", msgicon: "ICON_FIRE", msglink: "ftp://x" })
  assert(badIcon.ok)
  if (badIcon.ok) {
    assertEquals(badIcon.value.icon, null)
    assertEquals(badIcon.value.link, null)
    assertEquals(badIcon.value.warnings.length, 2)
  }
  assertFalse(validateOutput({ msgout: "" }).ok)
  assertFalse(validateOutput({ msgout: 42 }).ok)
})

Deno.test("markup escaping for desktop notification bodies", () => {
  assertEquals(
    escapeMarkup('<img src="https://example.invalid/t"> & <b>'),
    "&lt;img src=&quot;https://example.invalid/t&quot;&gt; &amp; &lt;b&gt;",
  )
  const args = notifyArgs(
    {
      seq: 1,
      id: "x",
      timestamp: "",
      brokerId: "b",
      broker: "B",
      subscriptionId: "s",
      topic: "t",
      text: "-x <i>",
      icon: "ICON_ERROR",
      link: null,
      read: false,
    },
    "--help",
    true,
  )
  const dd = args.indexOf("--")
  assert(dd > 0)
  assertEquals(args.slice(dd + 1), ["--help", "-x &lt;i&gt;"])
  assert(args.includes("--urgency=critical"))
})

Deno.test("backoff: exponential, capped, jittered", () => {
  const mid = () => 0.5
  assertEquals(backoffDelay(0, 2, 60, mid), 2)
  assertEquals(backoffDelay(1, 2, 60, mid), 4)
  assertEquals(backoffDelay(5, 2, 60, mid), 60)
  assertEquals(backoffDelay(50, 2, 60, mid), 60)
  assert(backoffDelay(0, 2, 60, () => 0) >= 1.6)
  assert(backoffDelay(0, 2, 60, () => 0.999) <= 2.4)
})

Deno.test("config normalization", () => {
  const c = normalizeConfig({
    version: 1,
    brokers: [
      { id: "a", name: "A", host: "localhost", subscriptions: [{ id: "s", topic: "x/#", qos: 7 }, { topic: "bad/#/x" }] },
      { id: "a", host: "" },
    ],
  })
  assertEquals(c.brokers.length, 2)
  assertEquals(c.brokers[0].subscriptions[0].qos, 2)
  assertEquals(c.brokers[0].port, 1883)
  assertFalse(c.brokers[0].subscriptions[1].enabled)
  assert(c.problems.some((p) => p.includes("invalid topic filter")))
  assert(c.brokers[1].id !== "a")
  assert(c.brokers[1].problems.some((p) => p.includes("host")))
  assertEquals(normalizeConfig({ brokers: [{ id: "t", host: "h", protocol: "mqtts" }] }).brokers[0].port, 8883)
})

Deno.test("paths stay inside their base directory", () => {
  assertEquals(resolveInside("/c/certs", "ca.pem"), "/c/certs/ca.pem")
  assertEquals(resolveInside("/c/certs", "sub/../ca.pem"), "/c/certs/ca.pem")
  assertEquals(resolveInside("/c/certs", "../config.json"), null)
  assertEquals(resolveInside("/c/certs", "/etc/passwd"), null)
  assertEquals(resolveInside("/c/certs", "/c/certs/x.pem"), "/c/certs/x.pem")
  assertEquals(resolveInside("/c/certs", "/c/certsX/x.pem"), null)
})

Deno.test("every matching subscription is selected; retained replays are skipped", () => {
  const broker = normalizeConfig({
    brokers: [{
      id: "b",
      host: "h",
      subscriptions: [
        { id: "all", topic: "home/#" },
        { id: "garage", topic: "home/garage/+" },
        { id: "off", topic: "home/#", enabled: false },
        { id: "keep", topic: "home/#", ignoreRetained: false },
      ],
    }],
  }).brokers[0]
  const ids = (topic: string, retain = false, filters: string[] | null = null) =>
    matchingSubscriptions(broker, { topic, retain, filters }).map((s) => s.id)
  assertEquals(ids("home/garage/door"), ["all", "garage", "keep"])
  assertEquals(ids("home/kitchen"), ["all", "keep"])
  assertEquals(ids("home/garage/door", true), ["keep"])
  // MQTT 5 subscription identifiers decide which filters a delivery belongs to.
  assertEquals(ids("home/garage/door", false, ["home/garage/+"]), ["garage"])
})

Deno.test("xml parser", () => {
  assertEquals(parseXml('<?xml version="1.0"?><sensor><temperature>29.5</temperature><status>warning</status></sensor>'), {
    sensor: { temperature: "29.5", status: "warning" },
  })
  assertEquals(parseXml("<a id=\"1\" kind='x'><b>1</b><b>2</b><c/><!-- note --><d><![CDATA[<raw>]]></d></a>"), {
    a: { "@_id": "1", "@_kind": "x", b: ["1", "2"], c: "", d: "<raw>" },
  })
  assertEquals(parseXml("<t>Tom &amp; Jerry &#x263A;</t>"), { t: "Tom & Jerry ☺" })
  // DOCTYPE entities are never expanded.
  assertEquals(parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>'), { x: "&e;" })
  assertThrows(() => parseXml("<a><b></a>"), SyntaxError)
  assertThrows(() => parseXml("just text"), SyntaxError)
  assertThrows(() => parseXml("<a>".repeat(100) + "</a>".repeat(100)), SyntaxError)
})
