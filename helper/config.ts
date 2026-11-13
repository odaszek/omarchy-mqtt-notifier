// Broker / subscription configuration: ~/.config/omarchy/mqtt-notifier/config.json
//
// Secrets (passwords, private-key passphrases) are never read from this file;
// they live in the Secret Service keyring (see secrets.ts).

import { isValidFilter } from "./topic.ts"
import { LIMITS } from "./validate.ts"

export const CONFIG_VERSION = 1

export interface TlsConfig {
  rejectUnauthorized: boolean
  /** Paths are relative to <config>/certs/ (absolute paths must also be inside it). */
  ca: string | null
  cert: string | null
  key: string | null
}

export interface SubscriptionConfig {
  id: string
  topic: string
  qos: 0 | 1 | 2
  enabled: boolean
  /** Inline JavaScript; empty means the default parser (msgout = to_string(msgin)). */
  parserScript: string
  /** Alternative to parserScript: a file in <config>/parsers/. Wins when both are set. */
  parserFile: string | null
  description: string
  /** Skip messages the broker replays from its retained store on (re)subscribe. */
  ignoreRetained: boolean
}

export interface BrokerConfig {
  id: string
  name: string
  host: string
  port: number
  protocol: "mqtt" | "mqtts"
  clientId: string
  username: string
  keepAlive: number
  cleanSession: boolean
  enabled: boolean
  /** Initial reconnect delay in seconds; doubles up to maxReconnectInterval. */
  reconnectInterval: number
  maxReconnectInterval: number
  connectTimeout: number
  mqttVersion: 4 | 5
  tls: TlsConfig
  subscriptions: SubscriptionConfig[]
  /** Problems found while normalizing; a broker with problems is not connected. */
  problems: string[]
}

export interface AdvancedConfig {
  parserTimeoutMs: number
  parserMemoryMb: number
  sandbox: "auto" | "bwrap" | "deno"
  maxPayloadBytes: number
  /** Where secrets live: "keyring" (Secret Service) or "file" (0600 file in the state dir). */
  secretStore: "keyring" | "file"
}

export interface Config {
  version: number
  brokers: BrokerConfig[]
  advanced: AdvancedConfig
  problems: string[]
}

export const DEFAULT_ADVANCED: AdvancedConfig = {
  parserTimeoutMs: 250,
  parserMemoryMb: 64,
  sandbox: "auto",
  maxPayloadBytes: LIMITS.payloadBytes,
  secretStore: "keyring",
}

export const EXAMPLE_CONFIG = {
  version: CONFIG_VERSION,
  brokers: [
    {
      id: "home",
      name: "HomeMQTT",
      host: "192.168.1.10",
      port: 1883,
      protocol: "mqtt",
      clientId: "omarchy-notifications",
      username: "",
      enabled: false,
      mqttVersion: 4,
      subscriptions: [
        { id: "garage", topic: "home/garage/#", qos: 1, enabled: true, parserScript: "", description: "Garage events" },
      ],
    },
  ],
  advanced: DEFAULT_ADVANCED,
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, fallback: string, max = 256): string {
  return typeof value === "string" ? value.slice(0, max) : fallback
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function mqttVersion(value: unknown): 4 | 5 {
  if (value === 5 || value === "5" || value === "5.0") return 5
  return 4 // 3.1.1
}

function relativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null
  return value.trim()
}

/** Resolve a user path inside `base`; null when it escapes. */
export function resolveInside(base: string, path: string): string | null {
  const root = base.replace(/\/+$/, "")
  const joined = path.startsWith("/") ? path : root + "/" + path
  const parts: string[] = []
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  const resolved = "/" + parts.join("/")
  return resolved === root || resolved.startsWith(root + "/") ? resolved : null
}

export function normalizeConfig(raw: unknown): Config {
  const r = obj(raw)
  const problems: string[] = []
  const version = int(r.version, CONFIG_VERSION, 0, 1000)
  if (version > CONFIG_VERSION) {
    problems.push("config version " + version + " is newer than this plugin understands (" + CONFIG_VERSION + ")")
  }

  const a = obj(r.advanced)
  const sandbox = a.sandbox === "bwrap" || a.sandbox === "deno" ? a.sandbox : "auto"
  const advanced: AdvancedConfig = {
    parserTimeoutMs: int(a.parserTimeoutMs, DEFAULT_ADVANCED.parserTimeoutMs, 20, 10_000),
    parserMemoryMb: int(a.parserMemoryMb, DEFAULT_ADVANCED.parserMemoryMb, 16, 1024),
    sandbox,
    maxPayloadBytes: int(a.maxPayloadBytes, DEFAULT_ADVANCED.maxPayloadBytes, 1024, 4 * 1024 * 1024),
    secretStore: a.secretStore === "file" ? "file" : "keyring",
  }

  const brokers: BrokerConfig[] = []
  const brokerIds = new Set<string>()
  const list = Array.isArray(r.brokers) ? r.brokers : []
  if (r.brokers !== undefined && !Array.isArray(r.brokers)) problems.push('"brokers" must be an array')
  list.slice(0, 64).forEach((entry, index) => {
    const b = obj(entry)
    const bp: string[] = []
    let id = text(b.id, "", 64)
    if (!ID_RE.test(id)) {
      bp.push("broker id must be 1–64 letters, digits, '.', '_' or '-'")
      id = "broker-" + (index + 1)
    }
    while (brokerIds.has(id)) {
      bp.push("duplicate broker id")
      id = id + "-" + (index + 1)
    }
    brokerIds.add(id)
    const host = text(b.host, "", 253).trim()
    if (!HOST_RE.test(host)) bp.push("host is missing or invalid")
    const protocol = b.protocol === "mqtts" || b.protocol === "tls" || b.protocol === "ssl" ? "mqtts" : "mqtt"
    const t = obj(b.tls)
    const subs: SubscriptionConfig[] = []
    const subIds = new Set<string>()
    const subList = Array.isArray(b.subscriptions) ? b.subscriptions : []
    subList.slice(0, 256).forEach((se, si) => {
      const s = obj(se)
      let sid = text(s.id, "", 64)
      if (!ID_RE.test(sid)) sid = "sub-" + (si + 1)
      while (subIds.has(sid)) sid = sid + "-" + (si + 1)
      subIds.add(sid)
      const topic = text(s.topic, "", LIMITS.topicChars)
      const sp = isValidFilter(topic) ? null : "subscription " + sid + ": invalid topic filter"
      if (sp) bp.push(sp)
      const qos = int(s.qos, 0, 0, 2) as 0 | 1 | 2
      subs.push({
        id: sid,
        topic,
        qos,
        enabled: bool(s.enabled, true) && !sp,
        parserScript: text(s.parserScript, "", LIMITS.scriptChars),
        parserFile: relativePath(s.parserFile),
        description: text(s.description, "", 512),
        ignoreRetained: bool(s.ignoreRetained, true),
      })
    })
    const port = int(b.port, protocol === "mqtts" ? 8883 : 1883, 1, 65535)
    brokers.push({
      id,
      name: text(b.name, id, 128).trim() || id,
      host,
      port,
      protocol,
      clientId: text(b.clientId, "", 128).trim() || "omarchy-mqtt-" + id,
      username: text(b.username, "", 256),
      keepAlive: int(b.keepAlive, 60, 0, 65535),
      cleanSession: bool(b.cleanSession, true),
      enabled: bool(b.enabled, true),
      reconnectInterval: int(b.reconnectInterval, 2, 1, 3600),
      maxReconnectInterval: int(b.maxReconnectInterval, 60, 1, 3600),
      connectTimeout: int(b.connectTimeout, 10, 1, 300),
      mqttVersion: mqttVersion(b.mqttVersion),
      tls: {
        rejectUnauthorized: bool(t.rejectUnauthorized, true),
        ca: relativePath(t.ca),
        cert: relativePath(t.cert),
        key: relativePath(t.key),
      },
      subscriptions: subs,
      problems: bp.filter((p) => !p.startsWith("subscription ")),
    })
    // Subscription problems disable just that subscription; report them on the broker too.
    for (const p of bp) if (p.startsWith("subscription ")) problems.push(id + ": " + p)
  })
  return { version, brokers, advanced, problems }
}

export interface LoadedConfig {
  config: Config
  /** Parser scripts resolved from parserFile, keyed by "<brokerId>/<subscriptionId>". */
  scripts: Map<string, string>
  error: string | null
}

export async function loadConfig(configDir: string): Promise<LoadedConfig> {
  const file = configDir + "/config.json"
  let raw: unknown = {}
  let error: string | null = null
  try {
    raw = JSON.parse(await Deno.readTextFile(file))
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      await writeExampleConfig(configDir)
      raw = EXAMPLE_CONFIG
    } else {
      error = "cannot read " + file + ": " + (e instanceof Error ? e.message : String(e))
    }
  }
  const config = normalizeConfig(raw)
  const scripts = new Map<string, string>()
  for (const broker of config.brokers) {
    for (const sub of broker.subscriptions) {
      if (!sub.parserFile) {
        scripts.set(broker.id + "/" + sub.id, sub.parserScript)
        continue
      }
      const path = resolveInside(configDir + "/parsers", sub.parserFile)
      if (!path) {
        config.problems.push(broker.id + "/" + sub.id + ": parserFile must be inside " + configDir + "/parsers")
        sub.enabled = false
        continue
      }
      try {
        const script = await Deno.readTextFile(path)
        if (script.length > LIMITS.scriptChars) throw new Error("longer than " + LIMITS.scriptChars + " characters")
        scripts.set(broker.id + "/" + sub.id, script)
      } catch (e) {
        config.problems.push(broker.id + "/" + sub.id + ": cannot read parser file: " + (e instanceof Error ? e.message : String(e)))
        sub.enabled = false
      }
    }
  }
  return { config, scripts, error }
}

async function writeExampleConfig(configDir: string): Promise<void> {
  try {
    await Deno.mkdir(configDir + "/parsers", { recursive: true, mode: 0o700 })
    await Deno.mkdir(configDir + "/certs", { recursive: true, mode: 0o700 })
    await Deno.writeTextFile(configDir + "/config.json", JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n", { createNew: true, mode: 0o600 })
  } catch { /* another writer won, or the directory is read-only */ }
}

/** Fields whose change requires reconnecting the broker. */
export function connectionKey(b: BrokerConfig): string {
  const { subscriptions: _s, name: _n, problems: _p, ...rest } = b
  return JSON.stringify(rest)
}
