// MQTT Notifier helper process. Started and owned by Service.qml.
//
//   deno run <permissions> main.ts --config-dir DIR --state-dir DIR [--max-stored N] [--verbose]
//
// Talks newline-delimited JSON on stdin/stdout (see docs/ipc.md):
//   requests  {"id":1,"op":"page","limit":10}
//   replies   {"id":1,"ok":true,"result":{...}}  /  {"id":1,"ok":false,"error":"..."}
//   events    {"event":"notification","notification":{...}}

import { type Config, loadConfig, normalizeConfig, resolveInside } from "./config.ts"
import { FileLogger } from "./log.ts"
import { MqttManager, testConnection } from "./mqtt_manager.ts"
import { DesktopNotifier } from "./notifier.ts"
import { ParserRunner } from "./parser.ts"
import { Processor } from "./processor.ts"
import { FileSecrets, KeyringSecrets, type SecretField, type SecretStore } from "./secrets.ts"
import { DEFAULT_RETENTION, NotificationStore } from "./store.ts"
import { editableBrokers, listFiles, readParserFiles, saveBrokers, validateBrokers } from "./settings.ts"

export const VERSION = "0.1.0"
const MAX_REQUEST_LINE = 1024 * 1024

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i]
    } else out[a.slice(2)] = true
  }
  return out
}
const args = parseArgs(Deno.args)
const configDir = String(args["config-dir"] ?? "").replace(/\/+$/, "")
const stateDir = String(args["state-dir"] ?? "").replace(/\/+$/, "")
if (!configDir.startsWith("/") || !stateDir.startsWith("/")) {
  console.error(
    "usage: main.ts --config-dir /abs/path --state-dir /abs/path [--max-stored N]",
  )
  Deno.exit(2)
}
const workerDir = new URL("./worker", import.meta.url).pathname
const exportsDir = stateDir + "/exports"

await Deno.mkdir(configDir, { recursive: true, mode: 0o700 })
await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 })
const log = new FileLogger(stateDir + "/logs", !!args.verbose)

// ---- stdout events ----
const encoder = new TextEncoder()
let stdoutChain: Promise<void> = Promise.resolve()
function emit(obj: Record<string, unknown>): void {
  const line = encoder.encode(JSON.stringify(obj) + "\n")
  stdoutChain = stdoutChain.then(async () => {
    try {
      let written = 0
      while (written < line.length) {
        written += await Deno.stdout.write(line.subarray(written))
      }
    } catch { /* shell went away; stdin EOF will stop us */ }
  })
}
log.onLog((level, message) => {
  if (level === "warn" || level === "error") {
    emit({ event: "log", level, message })
  }
})

// ---- single instance ----
const lockFile = await Deno.open(stateDir + "/helper.lock", {
  create: true,
  write: true,
  mode: 0o600,
})
const locked = await Promise.race([
  lockFile.lock(true).then(() => true),
  new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
])
if (!locked) {
  log.error("another MQTT Notifier helper is already running for " + stateDir)
  emit({ event: "fatal", error: "Another helper instance is already running" })
  await stdoutChain
  Deno.exit(3)
}

// ---- components ----
const retention = Number(args["max-stored"]) || DEFAULT_RETENTION
const store = new NotificationStore(stateDir)
await store.open(retention)
if (store.skippedOnLoad > 0) {
  log.warn(
    "skipped " + store.skippedOnLoad +
      " unreadable history line(s); the file was rewritten",
  )
}

let loaded = await loadConfig(configDir)
let config: Config = loaded.config
let scripts = loaded.scripts

function secretsFor(c: Config): SecretStore {
  return c.advanced.secretStore === "file" ? new FileSecrets(stateDir) : new KeyringSecrets(log)
}
let secrets = secretsFor(config)

const parser = new ParserRunner({
  timeoutMs: config.advanced.parserTimeoutMs,
  memoryMb: config.advanced.parserMemoryMb,
  sandbox: config.advanced.sandbox,
  denoPath: Deno.execPath(),
  workerDir,
  cacheDir: stateDir + "/worker-cache",
  log,
})

const notifier = new DesktopNotifier(
  log,
  (id) => emit({ event: "activate", id }),
)
notifier.enabled = !args["no-desktop-notifications"]

let statusTimer: ReturnType<typeof setTimeout> | undefined
function scheduleStatus(): void {
  if (statusTimer !== undefined) return
  statusTimer = setTimeout(() => {
    statusTimer = undefined
    emit({ event: "brokers", brokers: manager.status() })
  }, 50)
}

function emitCounts(): void {
  emit({ event: "counts", total: store.total, unread: store.unread })
}

const manager = new MqttManager({
  certsDir: configDir + "/certs",
  get secrets() {
    return secrets
  },
  log,
  onMessage: (msg) => processor.handle(msg),
  onStatus: scheduleStatus,
})

const processor = new Processor({
  store,
  parser,
  log,
  broker: (id) => manager.config(id),
  script: (b, s) => scripts.get(b + "/" + s) ?? "",
  maxPayloadBytes: () => config.advanced.maxPayloadBytes,
  onNotification: (n, sub, broker) => {
    emit({ event: "notification", notification: n })
    emitCounts()
    notifier.show(
      n,
      sub.description ? broker.name + " · " + sub.description : broker.name,
    )
  },
})

function emitConfig(): void {
  emit({
    event: "config",
    path: configDir + "/config.json",
    error: loaded.error,
    problems: config.problems,
    sandbox: parser.sandboxMode,
  })
}

async function reloadConfig(): Promise<void> {
  const next = await loadConfig(configDir)
  if (next.error) {
    // Keep running with the last good configuration.
    loaded = { ...loaded, error: next.error }
    log.warn(next.error)
    emitConfig()
    return
  }
  loaded = next
  config = next.config
  scripts = next.scripts
  secrets = secretsFor(config)
  for (const p of config.problems) log.warn("config: " + p)
  await manager.apply(config.brokers)
  emitConfig()
}

// ---- config hot reload ----
let reloadTimer: ReturnType<typeof setTimeout> | undefined
;(async () => {
  try {
    for await (const ev of Deno.watchFs(configDir, { recursive: true })) {
      if (
        ev.paths.every((p) => p.includes(".tmp-") || p.endsWith("~") || p.endsWith(".swp"))
      ) continue
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(
        () => reloadConfig().catch((e) => log.error("reload failed: " + e)),
        300,
      )
    }
  } catch (e) {
    log.warn(
      "config watcher stopped: " + (e instanceof Error ? e.message : String(e)),
    )
  }
})()

// ---- requests ----
// deno-lint-ignore no-explicit-any
type Req = Record<string, any>

function int(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}

const handlers: Record<string, (req: Req) => Promise<unknown> | unknown> = {
  settings: async (req) => {
    const s = req.settings && typeof req.settings === "object" ? req.settings : {}
    if (s.maxStoredMessages !== undefined) {
      await store.setRetention(
        int(s.maxStoredMessages, DEFAULT_RETENTION, 1, 100_000),
      )
    }
    if (typeof s.desktopNotifications === "boolean") {
      notifier.enabled = s.desktopNotifications
    }
    emitCounts()
    return {
      retention: store.retention,
      desktopNotifications: notifier.enabled,
    }
  },
  page: (req) =>
    store.page(
      int(req.limit, 10, 1, 500),
      req.beforeSeq === undefined || req.beforeSeq === null ? undefined : Number(req.beforeSeq),
    ),
  markAllRead: async () => {
    const through = await store.markAllRead()
    emitCounts()
    return { readThroughSeq: through }
  },
  clear: async () => {
    await store.clear()
    emitCounts()
    return { total: 0 }
  },
  status: () => ({ brokers: manager.status() }),
  stats: () => ({
    version: VERSION,
    total: store.total,
    unread: store.unread,
    retention: store.retention,
    sandbox: parser.sandboxMode,
    configPath: configDir + "/config.json",
    statePath: stateDir,
    problems: config.problems,
    configError: loaded.error,
  }),
  reload: async () => {
    await reloadConfig()
    return { problems: config.problems }
  },
  reconnect: async () => {
    await manager.reconnectAll()
    return {}
  },
  testParser: async (req) => {
    const script = typeof req.script === "string" ? req.script : ""
    const input = typeof req.input === "string" ? req.input : ""
    return await processor.render(new TextEncoder().encode(input), script)
  },
  // Either a saved broker ({brokerId}) or an unsaved draft from the settings
  // window ({broker, password?}); a draft password is used for this test only.
  testConnection: async (req) => {
    let broker = req.broker && typeof req.broker === "object" ? normalizeConfig({ brokers: [req.broker] }).brokers[0] : null
    if (!broker) {
      broker = config.brokers.find((b) => b.id === req.brokerId) ?? null
    }
    if (!broker) throw new Error("unknown broker " + String(req.brokerId))
    const draftPassword = typeof req.password === "string" && req.password !== "" ? req.password : null
    const testSecrets: SecretStore = draftPassword === null ? secrets : {
      get: (id, field) => field === "password" ? Promise.resolve(draftPassword) : secrets.get(id, field),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    }
    return await testConnection(broker, {
      certsDir: configDir + "/certs",
      secrets: testSecrets,
      log,
    })
  },
  getConfig: async () => {
    const secretState: Record<
      string,
      { password: boolean; keyPassphrase: boolean }
    > = {}
    for (const b of config.brokers) {
      secretState[b.id] = {
        password: (await secrets.get(b.id, "password")) !== null,
        keyPassphrase: b.tls.key ? (await secrets.get(b.id, "keyPassphrase")) !== null : false,
      }
    }
    return {
      path: configDir + "/config.json",
      error: loaded.error,
      problems: config.problems,
      brokers: editableBrokers(config.brokers),
      secrets: secretState,
      secretStore: config.advanced.secretStore,
      parserFiles: await readParserFiles(configDir, config.brokers),
      certs: await listFiles(configDir + "/certs"),
    }
  },
  saveConfig: async (req) => {
    const errors = validateBrokers(req.brokers)
    if (errors.length > 0) return { saved: false, errors }
    const parserFiles = req.parserFiles && typeof req.parserFiles === "object" ? req.parserFiles : {}
    const { removedBrokerIds } = await saveBrokers(
      configDir,
      req.brokers,
      parserFiles,
    )
    for (const id of removedBrokerIds) {
      try {
        await secrets.remove(id, "password")
        await secrets.remove(id, "keyPassphrase")
      } catch (e) {
        log.warn(
          "could not remove secrets of deleted broker " + id + ": " +
            (e instanceof Error ? e.message : String(e)),
        )
      }
    }
    await reloadConfig()
    return { saved: true, errors: [], problems: config.problems }
  },
  listExports: async () => ({
    dir: exportsDir,
    files: (await listFiles(exportsDir)).reverse(),
  }),
  export: async () => {
    await Deno.mkdir(exportsDir, { recursive: true, mode: 0o700 })
    const path = exportsDir + "/history-" +
      new Date().toISOString().replace(/[:.]/g, "-") + ".json"
    const count = await store.exportTo(path)
    return { path, count }
  },
  import: async (req) => {
    const path = typeof req.path === "string" ? resolveInside(exportsDir, req.path) : null
    if (!path) throw new Error("import files must be inside " + exportsDir)
    const result = await store.importFrom(path)
    emitCounts()
    return result
  },
  setSecret: async (req) => {
    const field = secretField(req.field)
    if (typeof req.brokerId !== "string" || typeof req.value !== "string") {
      throw new Error("brokerId and value are required")
    }
    await secrets.set(req.brokerId, field, req.value)
    return {}
  },
  clearSecret: async (req) => {
    if (typeof req.brokerId !== "string") {
      throw new Error("brokerId is required")
    }
    await secrets.remove(req.brokerId, secretField(req.field))
    return {}
  },
}

function secretField(value: unknown): SecretField {
  if (value === "password" || value === "keyPassphrase") return value
  throw new Error('field must be "password" or "keyPassphrase"')
}

async function handle(line: string): Promise<void> {
  let req: Req
  try {
    req = JSON.parse(line)
  } catch {
    emit({ id: null, ok: false, error: "invalid JSON request" })
    return
  }
  const id = typeof req?.id === "number" || typeof req?.id === "string" ? req.id : null
  const handler = typeof req?.op === "string" && Object.hasOwn(handlers, req.op) ? handlers[req.op] : null
  if (!handler) {
    emit({ id, ok: false, error: "unknown op " + JSON.stringify(req?.op) })
    return
  }
  try {
    emit({ id, ok: true, result: await handler(req) })
  } catch (e) {
    emit({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

// ---- start ----
for (const p of config.problems) log.warn("config: " + p)
if (loaded.error) log.warn(loaded.error)
emit({
  event: "ready",
  version: VERSION,
  configPath: configDir + "/config.json",
  statePath: stateDir,
})
emitConfig()
emitCounts()
await manager.apply(config.brokers)

// Requests still being handled; shutdown waits for them (bounded) so their replies are sent.
const inFlight = new Set<Promise<void>>()

let shuttingDown = false
async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((r) => setTimeout(r, 5000)),
    ])
    try {
      await manager.stop()
    } catch { /* ignore */ }
    try {
      await parser.close()
    } catch { /* ignore */ }
    try {
      await store.flush()
    } catch { /* ignore */ }
    await stdoutChain
  }
  Deno.exit(code)
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  try {
    Deno.addSignalListener(sig, () => shutdown(0))
  } catch { /* unsupported */ }
}

let buffer = ""
let discarding = false
for await (
  const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
) {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (discarding) {
      discarding = false
      continue
    }
    // Requests run concurrently (a connection test must not stall paging);
    // the store serializes its own writes.
    if (line.trim() !== "") {
      const p = handle(line)
      inFlight.add(p)
      p.finally(() => inFlight.delete(p))
    }
  }
  if (buffer.length > MAX_REQUEST_LINE) {
    emit({ id: null, ok: false, error: "request too large" })
    buffer = ""
    discarding = true
  }
}
// stdin closed: the shell (or its service) is gone.
await shutdown(0)
