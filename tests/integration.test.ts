// End-to-end: real helper process (started through helper/start.sh, with
// production permissions) against in-process aedes MQTT brokers.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1"
import aedes from "npm:aedes@0.51.3"
import net from "node:net"
import { Buffer } from "node:buffer"

const START = new URL("../helper/start.sh", import.meta.url).pathname

// ---------- test broker ----------
class TestBroker {
  // deno-lint-ignore no-explicit-any
  broker: any
  server!: net.Server
  sockets = new Set<net.Socket>()
  constructor(public port: number) {}

  async start(): Promise<void> {
    this.broker = await aedes.createBroker()
    this.server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.on("close", () => this.sockets.delete(socket))
      this.broker.handle(socket)
    })
    await new Promise<void>((r) => this.server.listen(this.port, "127.0.0.1", () => r()))
  }

  publish(
    topic: string,
    payload: string | Uint8Array,
    retain = false,
  ): Promise<void> {
    return new Promise((resolve, reject) =>
      this.broker.publish(
        {
          cmd: "publish",
          topic,
          payload: Buffer.from(payload),
          qos: 0,
          retain,
          dup: false,
        },
        (err: unknown) => err ? reject(err) : resolve(),
      )
    )
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((r) => this.server.close(() => r()))
    await new Promise<void>((r) => this.broker.close(() => r()))
  }
}

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 })
  const port = (l.addr as Deno.NetAddr).port
  l.close()
  return port
}

// ---------- helper process ----------
// deno-lint-ignore no-explicit-any
type Msg = Record<string, any>

class Helper {
  proc!: Deno.ChildProcess
  events: Msg[] = []
  #waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = []
  #nextId = 1
  #writer!: WritableStreamDefaultWriter<Uint8Array>
  stderr = ""

  constructor(public configDir: string, public stateDir: string) {}

  start(): void {
    this.proc = new Deno.Command("bash", {
      args: [
        START,
        this.configDir,
        this.stateDir,
        "--no-desktop-notifications",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
    this.#writer = this.proc.stdin.getWriter()
    ;(async () => {
      let buf = ""
      for await (
        const chunk of this.proc.stdout.pipeThrough(new TextDecoderStream())
      ) {
        buf += chunk
        let nl
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let msg: Msg
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          this.events.push(msg)
          this.#waiters = this.#waiters.filter((w) => {
            if (!w.pred(msg)) return true
            w.resolve(msg)
            return false
          })
        }
      }
    })()
    ;(async () => {
      for await (
        const chunk of this.proc.stderr.pipeThrough(new TextDecoderStream())
      ) this.stderr += chunk
    })()
  }

  waitFor(
    pred: (m: Msg) => boolean,
    timeoutMs = 15000,
    what = "event",
  ): Promise<Msg> {
    const seen = this.events.find(pred)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              "timed out waiting for " + what + "\nstderr:\n" +
                this.stderr.slice(-3000),
            ),
          ),
        timeoutMs,
      )
      this.#waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t)
          resolve(m)
        },
      })
    })
  }

  /** Wait for an event that arrives after this call. */
  next(
    pred: (m: Msg) => boolean,
    timeoutMs = 15000,
    what = "event",
  ): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              "timed out waiting for " + what + "\nstderr:\n" +
                this.stderr.slice(-3000),
            ),
          ),
        timeoutMs,
      )
      this.#waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t)
          resolve(m)
        },
      })
    })
  }

  async request(op: string, extra: Msg = {}): Promise<Msg> {
    const id = this.#nextId++
    const reply = this.waitFor((m) => m.id === id, 20000, "reply to " + op)
    await this.#writer.write(
      new TextEncoder().encode(JSON.stringify({ id, op, ...extra }) + "\n"),
    )
    const r = await reply
    if (!r.ok) throw new Error(op + " failed: " + r.error)
    return r.result
  }

  brokerState(id: string, state: string, timeoutMs = 20000): Promise<Msg> {
    return this.waitFor(
      (m) =>
        m.event === "brokers" &&
        m.brokers.some((b: Msg) => b.id === id && b.state === state),
      timeoutMs,
      id + " " + state,
    )
  }

  nextBrokerState(id: string, state: string, timeoutMs = 20000): Promise<Msg> {
    return this.next(
      (m) =>
        m.event === "brokers" &&
        m.brokers.some((b: Msg) => b.id === id && b.state === state),
      timeoutMs,
      id + " " + state,
    )
  }

  notifications(): Msg[] {
    return this.events.filter((m) => m.event === "notification").map((m) => m.notification)
  }

  async waitNotifications(count: number, timeoutMs = 15000): Promise<Msg[]> {
    const deadline = Date.now() + timeoutMs
    while (this.notifications().length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          "expected " + count + " notifications, got " +
            JSON.stringify(this.notifications().map((n) => n.text)) +
            "\nstderr:\n" +
            this.stderr.slice(-3000),
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return this.notifications()
  }

  async stop(): Promise<void> {
    try {
      await this.#writer.close()
    } catch { /* already closed */ }
    const status = await Promise.race([
      this.proc.status,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ])
    if (status === null) {
      this.proc.kill("SIGKILL")
      await this.proc.status
    }
  }
}

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(
    dir + "/config.json.tmp-x",
    JSON.stringify(config, null, 2),
  )
  await Deno.rename(dir + "/config.json.tmp-x", dir + "/config.json")
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

Deno.test({
  name: "integration: brokers, subscriptions, parsing, persistence, reconnect, hot reload",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const root = await Deno.makeTempDir({ prefix: "mqttn-it-" })
    const configDir = root + "/config"
    const stateDir = root + "/state"
    const portA = freePort()
    const portB = freePort()
    const a = new TestBroker(portA)
    const b = new TestBroker(portB)
    await a.start()
    await b.start()
    // Retained before the helper connects: replayed on subscribe, ignored by default.
    await a.publish("home/garage/door", "retained-old", true)

    const config = {
      version: 1,
      brokers: [
        {
          id: "a",
          name: "Alpha",
          host: "127.0.0.1",
          port: portA,
          clientId: "it-a",
          reconnectInterval: 1,
          maxReconnectInterval: 2,
          subscriptions: [
            { id: "all", topic: "home/#", qos: 1 },
            {
              id: "garage",
              topic: "home/garage/+",
              qos: 0,
              description: "Garage",
              parserScript: "msgout = 'ALERT: ' + msgin; msgicon = ICON_WARN; msglink = 'https://example.com/garage'",
            },
            {
              id: "json",
              topic: "sensors/+/climate",
              parserScript:
                "var d = JSON.parse(msgin); msgout = 'Temperature: ' + d.temperature + ' °C'; msgicon = d.temperature > 28 ? ICON_WARN : ICON_OK",
            },
            {
              id: "xml",
              topic: "xml/#",
              parserScript: "var d = parseXml(msgin); if (d.sensor.status === 'ignore') return false; msgout = d.sensor.status",
            },
          ],
        },
        {
          id: "b",
          name: "Beta",
          host: "127.0.0.1",
          port: portB,
          clientId: "it-b",
          reconnectInterval: 1,
          maxReconnectInterval: 2,
          subscriptions: [{ id: "x", topic: "x/#", qos: 2 }],
        },
        {
          id: "off",
          name: "Disabled",
          host: "127.0.0.1",
          port: freePort(),
          enabled: false,
          subscriptions: [],
        },
      ],
    }
    await writeConfig(configDir, config)

    let helper = new Helper(configDir, stateDir)
    helper.start()
    try {
      await t.step("both brokers connect independently (AC03)", async () => {
        await helper.waitFor((m) => m.event === "ready", 30000, "ready")
        await helper.brokerState("a", "connected")
        await helper.brokerState("b", "connected")
        const status = await helper.request("status")
        assertEquals(
          status.brokers.find((x: Msg) => x.id === "off").state,
          "disabled",
        )
        await sleep(300) // let subscriptions settle
      })

      await t.step(
        "one message matching two subscriptions makes two notifications",
        async () => {
          await a.publish("home/garage/door", "Garage door opened")
          const ns = await helper.waitNotifications(2)
          const texts = ns.map((n) => n.text).sort()
          assertEquals(texts, [
            "ALERT: Garage door opened",
            "Garage door opened",
          ])
          const alert = ns.find((n) => n.subscriptionId === "garage")!
          assertEquals(alert.icon, "ICON_WARN")
          assertEquals(alert.link, "https://example.com/garage")
          assertEquals(alert.broker, "Alpha")
          assertEquals(alert.topic, "home/garage/door")
          assertEquals(alert.read, false)
          // The retained replay was ignored.
          assert(!ns.some((n) => n.text.includes("retained-old")))
        },
      )

      await t.step(
        "plain numbers, JSON, XML, invalid UTF-8, parser errors (AC05–AC09, AC16)",
        async () => {
          const before = helper.notifications().length
          // Dropped by the parser (`return false`): no notification at all.
          await a.publish("xml/sensor", "<sensor><status>ignore</status></sensor>")
          await a.publish("home/kitchen/temp", "21.5")
          await a.publish(
            "sensors/attic/climate",
            JSON.stringify({ temperature: 29.5, humidity: 65 }),
          )
          await a.publish(
            "xml/sensor",
            "<sensor><temperature>29.5</temperature><status>warning</status></sensor>",
          )
          await a.publish("home/raw", new Uint8Array([0x4f, 0x4b, 0xff, 0x21]))
          await b.publish("x/1", "from beta")
          const ns = (await helper.waitNotifications(before + 5)).slice(before)
          const byTopic = (topic: string): Msg => ns.find((n) => n.topic === topic)!
          assertEquals(byTopic("home/kitchen/temp").text, "21.5")
          assertEquals(
            byTopic("sensors/attic/climate").text,
            "Temperature: 29.5 °C",
          )
          assertEquals(byTopic("sensors/attic/climate").icon, "ICON_WARN")
          assertEquals(byTopic("xml/sensor").text, "warning")
          assertEquals(byTopic("home/raw").text, "OK�!")
          assertEquals(byTopic("x/1").broker, "Beta")
          assertFalse(ns.some((n) => n.text === "ignore"))

          const before2 = helper.notifications().length
          await a.publish("sensors/broken/climate", "not json")
          const [failed] = (await helper.waitNotifications(before2 + 1)).slice(
            before2,
          )
          assertEquals(failed.text, "not json")
          assertEquals(failed.icon, "ICON_ERROR")
          assertEquals(failed.link, null)
        },
      )

      await t.step("pagination, unread, mark read (AC11)", async () => {
        const page1 = await helper.request("page", { limit: 3 })
        assertEquals(page1.items.length, 3)
        assert(page1.hasMore)
        assertEquals(page1.unread, page1.total)
        const page2 = await helper.request("page", {
          limit: 3,
          beforeSeq: page1.items[2].seq,
        })
        const ids = new Set(
          [...page1.items, ...page2.items].map((n: Msg) => n.id),
        )
        assertEquals(ids.size, 6)
        const zero = helper.next(
          (m) => m.event === "counts" && m.unread === 0,
          5000,
          "unread 0",
        )
        await helper.request("markAllRead")
        const counts = await zero
        assert(counts.total >= 8)
        const one = helper.next(
          (m) => m.event === "counts" && m.unread === 1,
          5000,
          "unread 1",
        )
        await a.publish("home/after", "arrived after opening")
        await one
      })

      await t.step(
        "broker loss shows an error state, reconnect restores subscriptions (AC14, AC15)",
        async () => {
          const lost = helper.nextBrokerState("b", "disconnected")
          await b.stop()
          const msg = await lost
          const entry = msg.brokers.find((x: Msg) => x.id === "b")
          assert(entry.error)
          // Broker A is unaffected.
          assertEquals(
            (await helper.request("status")).brokers.find((x: Msg) => x.id === "a").state,
            "connected",
          )
          const back = helper.nextBrokerState("b", "connected")
          await b.start()
          await back
          await sleep(300)
          const before = helper.notifications().length
          await b.publish("x/again", "beta is back")
          const [n] = (await helper.waitNotifications(before + 1)).slice(
            before,
          )
          assertEquals(n.text, "beta is back")
        },
      )

      await t.step(
        "hot reload: parser change applies to new messages, disabling stops a broker (AC19, AC20)",
        async () => {
          config.brokers[0].subscriptions[0].parserScript = "msgout = 'v2: ' + msgin"
          config.brokers[1].enabled = false
          const disabled = helper.nextBrokerState("b", "disabled")
          await writeConfig(configDir, config)
          await disabled
          await sleep(400)
          const before = helper.notifications().length
          await a.publish("home/changed", "hello")
          await b.publish("x/ignored", "should not arrive")
          const [n] = (await helper.waitNotifications(before + 1)).slice(
            before,
          )
          assertEquals(n.text, "v2: hello")
          await sleep(500)
          assertEquals(helper.notifications().length, before + 1)
        },
      )

      await t.step(
        "history and read state survive a helper restart (AC13, AC18)",
        async () => {
          const total = (await helper.request("stats")).total
          await helper.stop()
          helper = new Helper(configDir, stateDir)
          helper.start()
          await helper.waitFor(
            (m) => m.event === "ready",
            30000,
            "ready after restart",
          )
          const page = await helper.request("page", { limit: 100 })
          assertEquals(page.total, total)
          assertEquals(page.unread, 3) // "arrived after opening", "beta is back", "v2: hello"
          await helper.brokerState("a", "connected")
        },
      )

      await t.step("retention and clear (AC12, AC17)", async () => {
        await helper.request("settings", {
          settings: { maxStoredMessages: 3 },
        })
        assertEquals(
          (await helper.request("page", { limit: 10 })).items.length,
          3,
        )
        await helper.request("clear")
        const page = await helper.request("page", { limit: 10 })
        assertEquals(page.total, 0)
        assertEquals(page.unread, 0)
        // Connections survive Clear All.
        assertEquals(
          (await helper.request("status")).brokers.find((x: Msg) => x.id === "a").state,
          "connected",
        )
      })

      await t.step(
        "parser test and connection test do not store anything",
        async () => {
          const out = await helper.request("testParser", {
            script: "msgout = msgin.toUpperCase(); msglink = 'javascript:x'",
            input: "hi",
          })
          assertEquals(out.text, "HI")
          assertEquals(out.link, null)
          assertEquals(out.warnings.length, 1)
          const ignored = await helper.request("testParser", { script: "return false", input: "hi" })
          assertEquals(ignored.dropped, true)
          const conn = await helper.request("testConnection", {
            brokerId: "a",
          })
          assertEquals(conn.ok, true)
          const bad = await helper.request("testConnection", {
            brokerId: "off",
          })
          assertEquals(bad.ok, false)
          assertEquals((await helper.request("stats")).total, 0)
        },
      )

      await t.step(
        "settings ops: read, validate, save, draft connection test",
        async () => {
          const cfg = await helper.request("getConfig")
          assertEquals(cfg.brokers.map((x: Msg) => x.id), ["a", "b", "off"])
          assertEquals(cfg.secrets.a.password, false)
          const bad = await helper.request("saveConfig", {
            brokers: [{ ...cfg.brokers[0], host: "" }],
          })
          assertEquals(bad.saved, false)
          assertEquals(bad.errors[0].path, "brokers[0].host")

          const draft = {
            ...cfg.brokers[0],
            id: "draft",
            clientId: "it-draft",
          }
          assertEquals(
            (await helper.request("testConnection", { broker: draft })).ok,
            true,
          )
          assertEquals(
            (await helper.request("testConnection", {
              broker: { ...draft, port: freePort() },
            })).ok,
            false,
          )

          const brokers = cfg.brokers.map((x: Msg) => x.id === "a" ? { ...x, name: "Alpha 2" } : x)
          brokers[0].subscriptions = [...brokers[0].subscriptions, {
            id: "new",
            topic: "fresh/#",
            qos: 0,
            parserScript: "msgout = 'fresh: ' + msgin",
          }]
          const ok = await helper.request("saveConfig", { brokers })
          assertEquals(ok.saved, true)
          const onDisk = JSON.parse(
            await Deno.readTextFile(configDir + "/config.json"),
          )
          assertEquals(onDisk.brokers[0].name, "Alpha 2")
          await sleep(400)
          const before = helper.notifications().length
          await a.publish("fresh/x", "y")
          const [n] = (await helper.waitNotifications(before + 1)).slice(
            before,
          )
          assertEquals(n.text, "fresh: y")
          assertEquals(n.broker, "Alpha 2")
          const exports = await helper.request("listExports")
          assert(Array.isArray(exports.files))
        },
      )

      await t.step("a flood is held at the broker connection and delivered in order", async () => {
        const before = helper.notifications().length
        const count = 600
        await Promise.all(Array.from({ length: count }, (_, i) => a.publish("fresh/flood", String(i))))
        const got = (await helper.waitNotifications(before + count, 60000)).slice(before)
        assertEquals(got.map((n) => n.text), Array.from({ length: count }, (_, i) => "fresh: " + i))
        const log = await Deno.readTextFile(stateDir + "/logs/helper.log")
        assertStringIncludes(log, "message backlog full")
      })

      await t.step("helper files are private", async () => {
        const mode = (await Deno.stat(stateDir + "/state.json")).mode! & 0o777
        assertEquals(mode, 0o600)
        const log = await Deno.readTextFile(stateDir + "/logs/helper.log")
        assertStringIncludes(log, "connected")
      })
    } finally {
      await helper.stop()
      await a.stop().catch(() => {})
      await b.stop().catch(() => {})
    }
  },
})
