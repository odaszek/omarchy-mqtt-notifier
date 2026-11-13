// Reading and writing config.json for the settings window.
//
// The file stays hand-editable: saving keeps top-level keys the UI does not
// manage (e.g. "advanced"), writes atomically, and the normal hot reload
// picks the change up. Secrets never pass through here.

import { type BrokerConfig, CONFIG_VERSION, HOST_RE, ID_RE, normalizeConfig, resolveInside } from "./config.ts"
import { atomicWrite } from "./store.ts"
import { isValidFilter } from "./topic.ts"
import { LIMITS } from "./validate.ts"

export interface FieldError {
  path: string
  message: string
}

/** Broker as the settings UI edits it (normalized, without runtime-only fields). */
export type EditableBroker = Omit<BrokerConfig, "problems">

export function editableBrokers(brokers: BrokerConfig[]): EditableBroker[] {
  return brokers.map(({ problems: _p, ...rest }) => ({
    ...rest,
    tls: { ...rest.tls },
    subscriptions: rest.subscriptions.map((s) => ({ ...s })),
  }))
}

// deno-lint-ignore no-explicit-any
type Raw = Record<string, any>

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Field-level validation of brokers coming from the UI. Empty array = valid. */
export function validateBrokers(input: unknown): FieldError[] {
  const errors: FieldError[] = []
  if (!Array.isArray(input)) {
    return [{ path: "brokers", message: "must be a list" }]
  }
  if (input.length > 64) {
    errors.push({ path: "brokers", message: "at most 64 brokers" })
  }
  const ids = new Set<string>()
  input.forEach((b, i) => {
    const p = "brokers[" + i + "]"
    if (!isObj(b)) {
      errors.push({ path: p, message: "must be an object" })
      return
    }
    if (typeof b.id !== "string" || !ID_RE.test(b.id)) {
      errors.push({
        path: p + ".id",
        message: "1–64 letters, digits, '.', '_' or '-'",
      })
    } else if (ids.has(b.id)) {
      errors.push({ path: p + ".id", message: "duplicate broker id" })
    } else ids.add(b.id)
    if (typeof b.name !== "string" || b.name.trim() === "") {
      errors.push({ path: p + ".name", message: "name is required" })
    }
    if (typeof b.host !== "string" || !HOST_RE.test(b.host.trim())) {
      errors.push({
        path: p + ".host",
        message: "hostname or IP address is required",
      })
    }
    const port = Number(b.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ path: p + ".port", message: "port must be 1–65535" })
    }
    if (
      b.protocol !== undefined && b.protocol !== "mqtt" &&
      b.protocol !== "mqtts"
    ) {
      errors.push({ path: p + ".protocol", message: "mqtt or mqtts" })
    }
    if (
      b.mqttVersion !== undefined && b.mqttVersion !== 4 && b.mqttVersion !== 5
    ) {
      errors.push({ path: p + ".mqttVersion", message: "4 (3.1.1) or 5" })
    }
    const subs = Array.isArray(b.subscriptions) ? b.subscriptions : []
    if (b.subscriptions !== undefined && !Array.isArray(b.subscriptions)) {
      errors.push({ path: p + ".subscriptions", message: "must be a list" })
    }
    const subIds = new Set<string>()
    subs.forEach((s: unknown, j: number) => {
      const sp = p + ".subscriptions[" + j + "]"
      if (!isObj(s)) {
        errors.push({ path: sp, message: "must be an object" })
        return
      }
      if (typeof s.id !== "string" || !ID_RE.test(s.id)) {
        errors.push({ path: sp + ".id", message: "invalid subscription id" })
      } else if (subIds.has(s.id)) {
        errors.push({ path: sp + ".id", message: "duplicate subscription id" })
      } else subIds.add(s.id)
      if (typeof s.topic !== "string" || !isValidFilter(s.topic)) {
        errors.push({
          path: sp + ".topic",
          message: "invalid topic filter ('+' and '#' must fill a whole level; '#' only last)",
        })
      }
      if (s.qos !== undefined && s.qos !== 0 && s.qos !== 1 && s.qos !== 2) {
        errors.push({ path: sp + ".qos", message: "QoS must be 0, 1 or 2" })
      }
      if (
        typeof s.parserScript === "string" &&
        s.parserScript.length > LIMITS.scriptChars
      ) {
        errors.push({
          path: sp + ".parserScript",
          message: "longer than " + LIMITS.scriptChars + " characters",
        })
      }
    })
  })
  return errors
}

/** Turn validated UI brokers into the JSON written to config.json (known fields only, stable order). */
export function brokersForFile(input: Raw[]): Raw[] {
  // Normalizing fills defaults and coerces types the same way loading does.
  const normalized = normalizeConfig({ brokers: input }).brokers
  return normalized.map((b) => {
    const tls: Raw = { rejectUnauthorized: b.tls.rejectUnauthorized }
    if (b.tls.ca) tls.ca = b.tls.ca
    if (b.tls.cert) tls.cert = b.tls.cert
    if (b.tls.key) tls.key = b.tls.key
    return {
      id: b.id,
      name: b.name,
      host: b.host,
      port: b.port,
      protocol: b.protocol,
      mqttVersion: b.mqttVersion,
      clientId: b.clientId,
      username: b.username,
      keepAlive: b.keepAlive,
      cleanSession: b.cleanSession,
      connectTimeout: b.connectTimeout,
      reconnectInterval: b.reconnectInterval,
      maxReconnectInterval: b.maxReconnectInterval,
      enabled: b.enabled,
      tls,
      subscriptions: b.subscriptions.map((s) => {
        const out: Raw = {
          id: s.id,
          topic: s.topic,
          qos: s.qos,
          enabled: s.enabled,
          description: s.description,
          ignoreRetained: s.ignoreRetained,
        }
        if (s.parserFile) out.parserFile = s.parserFile
        else out.parserScript = s.parserScript
        return out
      }),
    }
  })
}

/** Read config.json as raw JSON (null when missing or unreadable). */
export async function readRawConfig(configDir: string): Promise<Raw | null> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(configDir + "/config.json"))
    return isObj(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * Save brokers (and optional parser file contents) into config.json, keeping
 * every other top-level key. Throws on unreadable-but-present config so a
 * broken hand edit is never silently overwritten.
 */
export async function saveBrokers(
  configDir: string,
  brokers: Raw[],
  parserFiles: Record<string, string> = {},
): Promise<{ removedBrokerIds: string[] }> {
  const path = configDir + "/config.json"
  let existing: Raw = {}
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path))
    if (isObj(parsed)) existing = parsed
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw new Error(
        "config.json has a syntax error; fix it by hand before saving from settings (" +
          (e instanceof Error ? e.message : String(e)) + ")",
      )
    }
  }
  const oldIds = Array.isArray(existing.brokers) ? existing.brokers.filter(isObj).map((b: Raw) => String(b.id)) : []

  for (const [name, content] of Object.entries(parserFiles)) {
    const target = resolveInside(configDir + "/parsers", name)
    if (!target) {
      throw new Error(
        "parser file must be inside " + configDir + "/parsers: " + name,
      )
    }
    if (typeof content !== "string" || content.length > LIMITS.scriptChars) {
      throw new Error("parser file " + name + " is too large")
    }
    await Deno.mkdir(configDir + "/parsers", { recursive: true, mode: 0o700 })
    await atomicWrite(target, content)
  }

  const next: Raw = {
    version: CONFIG_VERSION,
    ...existing,
    brokers: brokersForFile(brokers),
  }
  next.version = Math.max(CONFIG_VERSION, Number(existing.version) || 0)
  await atomicWrite(path, JSON.stringify(next, null, 2) + "\n")
  const newIds = new Set(next.brokers.map((b: Raw) => b.id))
  return { removedBrokerIds: oldIds.filter((id: string) => !newIds.has(id)) }
}

/** Plain file names in a directory (no subdirectories), sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && !e.name.startsWith(".")) out.push(e.name)
    }
  } catch { /* missing directory */ }
  return out.sort()
}

/** Contents of parser files referenced by subscriptions, for the editor. */
export async function readParserFiles(
  configDir: string,
  brokers: BrokerConfig[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const b of brokers) {
    for (const s of b.subscriptions) {
      if (!s.parserFile || out[s.parserFile] !== undefined) continue
      const path = resolveInside(configDir + "/parsers", s.parserFile)
      if (!path) continue
      try {
        out[s.parserFile] = await Deno.readTextFile(path)
      } catch { /* reported by loadConfig */ }
    }
  }
  return out
}
