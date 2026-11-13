// One independent MQTT connection per broker, each with its own
// reconnect/backoff loop. A failing broker never affects the others.

import mqtt from "mqtt"
import type { IClientOptions, MqttClient } from "mqtt"
import { Buffer } from "node:buffer"
import { type BrokerConfig, connectionKey, resolveInside } from "./config.ts"
import type { Logger } from "./log.ts"
import type { SecretStore } from "./secrets.ts"

export type BrokerState = "disabled" | "connecting" | "connected" | "disconnected" | "error"

export interface BrokerStatus {
  id: string
  name: string
  enabled: boolean
  state: BrokerState
  error: string | null
  /** Seconds until the next reconnect attempt, when one is scheduled. */
  retryIn: number | null
  subscriptions: number
}

export interface IncomingMessage {
  brokerId: string
  topic: string
  payload: Uint8Array
  retain: boolean
  /** Filters this message was delivered for (MQTT 5 subscription identifiers); null = match locally. */
  filters: string[] | null
}

export interface ManagerOptions {
  certsDir: string
  secrets: SecretStore
  log: Logger
  onMessage: (msg: IncomingMessage) => void
  onStatus: () => void
}

const CONNACK_REASONS: Record<number, string> = {
  1: "unacceptable protocol version",
  2: "client identifier rejected",
  3: "server unavailable",
  4: "bad username or password",
  5: "not authorized",
  128: "unspecified error",
  129: "malformed packet",
  130: "protocol error",
  133: "client identifier not valid",
  134: "bad username or password",
  135: "not authorized",
  136: "server unavailable",
  137: "server busy",
  138: "banned",
  140: "bad authentication method",
  149: "packet too large",
  151: "quota exceeded",
  153: "payload format invalid",
  156: "use another server",
  157: "server moved",
}

function describeError(e: unknown): string {
  // deno-lint-ignore no-explicit-any
  const err = e as any
  const code = typeof err?.code === "number" ? err.code : null
  if (code !== null && CONNACK_REASONS[code]) return "Connection refused: " + CONNACK_REASONS[code]
  if (typeof err?.code === "string") {
    if (err.code === "ECONNREFUSED") return "Connection refused"
    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return "Host not found"
    if (err.code === "ETIMEDOUT") return "Connection timed out"
    if (err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") return "Host unreachable"
  }
  const message = err instanceof Error ? err.message : String(e)
  return message.slice(0, 300)
}

/** Exponential backoff with ±20% jitter. `attempt` starts at 0. */
export function backoffDelay(attempt: number, initialSec: number, maxSec: number, random = Math.random): number {
  const base = Math.min(maxSec, initialSec * Math.pow(2, Math.min(attempt, 30)))
  return Math.max(0.5, base * (0.8 + 0.4 * random()))
}

class BrokerConnection {
  config: BrokerConfig
  state: BrokerState = "disconnected"
  error: string | null = null
  retryAt: number | null = null
  #client: MqttClient | null = null
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #stopped = false
  /** filter -> granted/requested qos currently subscribed on this connection */
  #subscribed = new Map<string, number>()
  /** subscription identifier -> filter (MQTT 5) */
  #idToFilter = new Map<number, string>()
  #filterToId = new Map<string, number>()
  #nextSubId = 1

  constructor(config: BrokerConfig, private opts: ManagerOptions) {
    this.config = config
  }

  get key(): string {
    return connectionKey(this.config)
  }

  start(): void {
    this.#stopped = false
    if (!this.config.enabled) {
      this.#set("disabled", null)
      return
    }
    if (this.config.problems.length > 0) {
      this.#set("error", "Invalid configuration: " + this.config.problems.join("; "))
      return
    }
    this.#connect()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    clearTimeout(this.#timer)
    this.retryAt = null
    const client = this.#client
    this.#client = null
    this.#subscribed.clear()
    if (client) await new Promise<void>((resolve) => client.end(true, {}, () => resolve()))
  }

  /** Apply a new subscription list without reconnecting. */
  updateSubscriptions(config: BrokerConfig): void {
    this.config = config
    if (this.state === "connected") this.#syncSubscriptions()
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return
    clearTimeout(this.#timer)
    this.retryAt = null
    this.#set("connecting", this.error)
    let options: IClientOptions
    try {
      options = await buildOptions(this.config, this.opts)
    } catch (e) {
      this.#set("error", describeError(e))
      this.#scheduleReconnect()
      return
    }
    if (this.#stopped) return
    const url = (this.config.protocol === "mqtts" ? "mqtts://" : "mqtt://") + hostForUrl(this.config.host) + ":" + this.config.port
    const client = mqtt.connect(url, options)
    this.#client = client
    let failure: string | null = null

    client.on("connect", () => {
      if (client !== this.#client) return
      this.#attempt = 0
      this.#subscribed.clear()
      this.#set("connected", null)
      this.opts.log.info("broker " + this.config.id + ": connected to " + url)
      this.#syncSubscriptions()
    })
    client.on("error", (e) => {
      if (client !== this.#client) return
      failure = describeError(e)
      this.opts.log.warn("broker " + this.config.id + ": " + failure)
    })
    client.on("message", (topic, payload, packet) => {
      if (client !== this.#client) return
      this.opts.onMessage({
        brokerId: this.config.id,
        topic,
        payload: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
        retain: !!packet.retain,
        filters: this.#filtersFor(packet.properties?.subscriptionIdentifier),
      })
    })
    client.on("close", () => {
      if (client !== this.#client) return
      this.#client = null
      this.#subscribed.clear()
      try {
        client.end(true)
      } catch { /* already closed */ }
      if (this.#stopped) return
      const wasConnected = this.state === "connected"
      this.#set(failure ? "error" : "disconnected", failure ?? (wasConnected ? "Connection lost" : "Broker is unreachable"))
      this.#scheduleReconnect()
    })
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return
    const delay = backoffDelay(this.#attempt++, this.config.reconnectInterval, this.config.maxReconnectInterval)
    this.retryAt = Date.now() + delay * 1000
    this.opts.onStatus()
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#connect(), delay * 1000)
  }

  #filtersFor(ids: number | number[] | undefined): string[] | null {
    if (this.config.mqttVersion !== 5 || ids === undefined) return null
    const list = Array.isArray(ids) ? ids : [ids]
    const filters: string[] = []
    for (const id of list) {
      const f = this.#idToFilter.get(id)
      if (f !== undefined) filters.push(f)
    }
    return filters.length > 0 ? filters : null
  }

  /** Subscribe each distinct enabled filter once (highest QoS wins); drop removed ones. */
  #syncSubscriptions(): void {
    const client = this.#client
    if (!client) return
    const wanted = new Map<string, number>()
    for (const s of this.config.subscriptions) {
      if (!s.enabled) continue
      wanted.set(s.topic, Math.max(wanted.get(s.topic) ?? 0, s.qos))
    }
    const removed = [...this.#subscribed.keys()].filter((f) => !wanted.has(f))
    if (removed.length > 0) {
      for (const f of removed) this.#subscribed.delete(f)
      client.unsubscribe(removed, (err) => {
        if (err) this.opts.log.warn("broker " + this.config.id + ": unsubscribe failed: " + describeError(err))
      })
    }
    for (const [filter, qos] of wanted) {
      if (this.#subscribed.get(filter) === qos) continue
      this.#subscribed.set(filter, qos)
      // deno-lint-ignore no-explicit-any
      const subOpts: any = { qos }
      if (this.config.mqttVersion === 5) {
        let id = this.#filterToId.get(filter)
        if (id === undefined) {
          id = this.#nextSubId++
          this.#filterToId.set(filter, id)
          this.#idToFilter.set(id, filter)
        }
        subOpts.properties = { subscriptionIdentifier: id }
      }
      client.subscribe(filter, subOpts, (err, granted) => {
        if (client !== this.#client) return
        const rejected = granted?.find((g) => g.qos === 128)
        if (err || rejected) {
          this.#subscribed.delete(filter)
          const why = err ? describeError(err) : "not authorized"
          this.opts.log.warn("broker " + this.config.id + ": subscribe to " + filter + " failed: " + why)
          this.error = "Subscription to " + filter + " rejected (" + why + ")"
          this.opts.onStatus()
        }
      })
    }
  }

  #set(state: BrokerState, error: string | null): void {
    this.state = state
    this.error = error
    this.opts.onStatus()
  }
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host
}

async function readCert(certsDir: string, path: string | null): Promise<Buffer | undefined> {
  if (!path) return undefined
  const resolved = resolveInside(certsDir, path)
  if (!resolved) throw new Error("certificate path must be inside " + certsDir + ": " + path)
  try {
    return Buffer.from(await Deno.readFile(resolved))
  } catch (e) {
    throw new Error("cannot read " + resolved + ": " + (e instanceof Error ? e.message : String(e)))
  }
}

async function buildOptions(b: BrokerConfig, opts: ManagerOptions, clientIdSuffix = ""): Promise<IClientOptions> {
  const options: IClientOptions = {
    clientId: b.clientId + clientIdSuffix,
    keepalive: b.keepAlive,
    clean: b.cleanSession,
    protocolVersion: b.mqttVersion,
    reconnectPeriod: 0, // we run our own backoff
    connectTimeout: b.connectTimeout * 1000,
    resubscribe: false,
  }
  if (b.username) {
    options.username = b.username
    const password = await opts.secrets.get(b.id, "password")
    if (password !== null) options.password = password
  }
  if (b.protocol === "mqtts") {
    options.rejectUnauthorized = b.tls.rejectUnauthorized
    options.ca = await readCert(opts.certsDir, b.tls.ca)
    options.cert = await readCert(opts.certsDir, b.tls.cert)
    options.key = await readCert(opts.certsDir, b.tls.key)
    if (b.tls.key) {
      const passphrase = await opts.secrets.get(b.id, "keyPassphrase")
      // deno-lint-ignore no-explicit-any
      if (passphrase !== null) (options as any).passphrase = passphrase
    }
    options.servername = b.host
  }
  return options
}

export class MqttManager {
  #brokers = new Map<string, BrokerConnection>()

  constructor(private opts: ManagerOptions) {}

  /** Reconcile running connections with a new broker list. */
  async apply(brokers: BrokerConfig[]): Promise<void> {
    const next = new Map(brokers.map((b) => [b.id, b]))
    for (const [id, conn] of this.#brokers) {
      if (!next.has(id)) {
        await conn.stop()
        this.#brokers.delete(id)
      }
    }
    for (const b of brokers) {
      const existing = this.#brokers.get(b.id)
      if (existing && existing.key === connectionKey(b) && existing.config.problems.length === 0 && b.problems.length === 0) {
        existing.updateSubscriptions(b)
        continue
      }
      if (existing) await existing.stop()
      const conn = new BrokerConnection(b, this.opts)
      this.#brokers.set(b.id, conn)
      conn.start()
    }
    this.opts.onStatus()
  }

  config(id: string): BrokerConfig | null {
    return this.#brokers.get(id)?.config ?? null
  }

  status(): BrokerStatus[] {
    const now = Date.now()
    return [...this.#brokers.values()].map((c) => ({
      id: c.config.id,
      name: c.config.name,
      enabled: c.config.enabled,
      state: c.state,
      error: c.error,
      retryIn: c.retryAt !== null ? Math.max(0, Math.round((c.retryAt - now) / 1000)) : null,
      subscriptions: c.config.subscriptions.filter((s) => s.enabled).length,
    }))
  }

  /** Reconnect every enabled broker now (e.g. after resume or a "retry" click). */
  async reconnectAll(): Promise<void> {
    for (const conn of this.#brokers.values()) {
      if (conn.state === "connected" || !conn.config.enabled) continue
      await conn.stop()
      conn.start()
    }
  }

  async stop(): Promise<void> {
    for (const conn of this.#brokers.values()) await conn.stop()
    this.#brokers.clear()
  }
}

/** One-shot connection test with a distinct client id, so it never kicks the live session. */
export async function testConnection(
  b: BrokerConfig,
  opts: Omit<ManagerOptions, "onMessage" | "onStatus">,
): Promise<{ ok: boolean; error: string | null; ms: number }> {
  const started = Date.now()
  if (b.problems.length > 0) return { ok: false, error: "Invalid configuration: " + b.problems.join("; "), ms: 0 }
  let options: IClientOptions
  try {
    options = await buildOptions(b, { ...opts, onMessage: () => {}, onStatus: () => {} }, "-test-" + crypto.randomUUID().slice(0, 6))
  } catch (e) {
    return { ok: false, error: describeError(e), ms: 0 }
  }
  options.clean = true
  const url = (b.protocol === "mqtts" ? "mqtts://" : "mqtt://") + hostForUrl(b.host) + ":" + b.port
  return await new Promise((resolve) => {
    const client = mqtt.connect(url, options)
    let done = false
    const finish = (ok: boolean, error: string | null) => {
      if (done) return
      done = true
      client.end(true)
      resolve({ ok, error, ms: Date.now() - started })
    }
    client.on("connect", () => finish(true, null))
    client.on("error", (e) => finish(false, describeError(e)))
    client.on("close", () => finish(false, "Broker is unreachable"))
  })
}
