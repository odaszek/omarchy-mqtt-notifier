// Restricted parser worker. Runs user scripts that turn an MQTT payload into a
// notification. Started by the helper as a separate process:
//
//   bwrap --unshare-all ... deno run --no-prompt --v8-flags=--max-old-space-size=N worker.js
//
// with no --allow-* flags (Deno denies fs, net, env, run, ffi), inside a
// bubblewrap namespace with no network and a read-only view of /usr. This file
// is a second layer only: it removes the Deno namespace and other ambient
// capabilities and freezes the shared intrinsics so one script cannot affect
// the next. The helper enforces the wall-clock timeout by killing this process.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   ← {"ready":true}
//   → {"id":1,"script":"msgout = msgin","msgin":"hello"}
//   ← {"id":1,"ok":true,"msgout":"hello","msgicon":null,"msglink":null,"logs":[]}
//   ← {"id":1,"ok":false,"error":"ReferenceError: x is not defined","logs":[]}

import { parseXml } from "./xml.js"

const MAX_LINE = 1024 * 1024
const MAX_LOG_LINES = 20
const MAX_LOG_CHARS = 500
const MAX_SCRIPT_CACHE = 64

// ---- capture what the worker itself needs, then drop ambient capabilities ----
const stdinReader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader()
const stdoutWriter = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
const jsonStringify = JSON.stringify
const jsonParse = JSON.parse
const exit = Deno.exit

// A script may leave a rejected promise behind (e.g. a denied dynamic import).
// It must not crash the worker after its reply and fail the next message.
globalThis.addEventListener("unhandledrejection", (event) => event.preventDefault())
globalThis.addEventListener("error", (event) => event.preventDefault())

for (
  const name of [
    "Deno",
    "fetch",
    "Request",
    "Response",
    "Headers",
    "WebSocket",
    "WebSocketStream",
    "EventSource",
    "Worker",
    "BroadcastChannel",
    "caches",
    "CacheStorage",
    "localStorage",
    "sessionStorage",
    "Storage",
    "navigator",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "alert",
    "confirm",
    "prompt",
    "process",
    "Buffer",
    "global",
    "setImmediate",
    "clearImmediate",
    "require",
    "close",
    "reportError",
    "onload",
    "onunload",
    "onerror",
    "onunhandledrejection",
    "WebAssembly",
    "SharedArrayBuffer",
    "Atomics",
  ]
) {
  try {
    delete globalThis[name]
  } catch { /* non-configurable: left in place, still permission-less */ }
}

const ICON_QUESTION = "ICON_QUESTION"
const ICON_WARN = "ICON_WARN"
const ICON_ERROR = "ICON_ERROR"
const ICON_OK = "ICON_OK"

function to_string(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  try {
    return jsonStringify(value) ?? ""
  } catch {
    return String(value)
  }
}

Object.freeze(to_string)
Object.freeze(parseXml)

// Freeze intrinsics so a script cannot leave state (or traps) for later
// scripts, e.g. by patching JSON.parse or Array.prototype.
const intrinsics = [
  Object,
  Function,
  Array,
  String,
  Number,
  Boolean,
  Symbol,
  BigInt,
  Math,
  JSON,
  Date,
  RegExp,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Promise,
  Reflect,
  Proxy,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
  ArrayBuffer,
  DataView,
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray,
  BigInt64Array,
  BigUint64Array,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Intl,
]
for (const value of intrinsics) {
  if (value === undefined) continue
  try {
    Object.freeze(value)
    if (value.prototype) Object.freeze(value.prototype)
  } catch { /* keep going */ }
}
try {
  Object.freeze(Object.getPrototypeOf(function* () {}))
} catch { /* ignore */ }
try {
  Object.freeze(Object.getPrototypeOf(async function () {}))
} catch { /* ignore */ }
// Deno marks the global object when it dispatches "unload" at exit. Dispatch
// it once now (nothing listens) so the frozen global needs no new property later.
try {
  globalThis.dispatchEvent(new Event("unload"))
} catch { /* ignore */ }
Object.freeze(globalThis)

// ---- script execution ----
const cache = new Map()

function compile(script) {
  let fn = cache.get(script)
  if (fn) return fn
  // The user script runs in an inner function so `return` ends it early; the
  // outer function owns the reserved output variables.
  fn = new Function(
    "msgin",
    "to_string",
    "parseXml",
    "ICON_QUESTION",
    "ICON_WARN",
    "ICON_ERROR",
    "ICON_OK",
    "console",
    '"use strict";\nlet msgout = "", msgicon = null, msglink = null;\n(function () {\n' + script +
      "\n})();\nreturn { msgout: msgout, msgicon: msgicon, msglink: msglink };",
  )
  if (cache.size >= MAX_SCRIPT_CACHE) cache.delete(cache.keys().next().value)
  cache.set(script, fn)
  return fn
}

function makeConsole(logs) {
  const push = (level) => (...args) => {
    if (logs.length >= MAX_LOG_LINES) return
    let line = args.map((a) => typeof a === "string" ? a : to_string(a)).join(" ")
    if (line.length > MAX_LOG_CHARS) line = line.slice(0, MAX_LOG_CHARS) + "…"
    logs.push(level + ": " + line)
  }
  return Object.freeze({ log: push("log"), info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") })
}

function primitive(value) {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === "string" || t === "boolean") return value
  if (t === "number") return Number.isFinite(value) ? value : String(value)
  return { type: Array.isArray(value) ? "array" : t }
}

function run(request) {
  const logs = []
  try {
    if (typeof request.script !== "string") throw new TypeError("script must be a string")
    if (typeof request.msgin !== "string") throw new TypeError("msgin must be a string")
    const out = compile(request.script)(
      request.msgin,
      to_string,
      parseXml,
      ICON_QUESTION,
      ICON_WARN,
      ICON_ERROR,
      ICON_OK,
      makeConsole(logs),
    )
    return {
      id: request.id,
      ok: true,
      msgout: primitive(out.msgout),
      msgicon: primitive(out.msgicon),
      msglink: primitive(out.msglink),
      logs,
    }
  } catch (e) {
    let message
    try {
      message = e instanceof Error ? e.name + ": " + e.message : "Thrown: " + to_string(e)
    } catch {
      message = "Script threw a value that could not be described"
    }
    return { id: request.id, ok: false, error: message.slice(0, 1000), logs }
  }
}

async function send(obj) {
  await stdoutWriter.write(encoder.encode(jsonStringify(obj) + "\n"))
}

// ---- main loop ----
await send({ ready: true })
let buffer = ""
for (;;) {
  const { value, done } = await stdinReader.read()
  if (done) break
  buffer += value
  if (buffer.length > MAX_LINE && buffer.indexOf("\n") === -1) {
    buffer = ""
    await send({ id: null, ok: false, error: "request too large" })
    continue
  }
  let nl
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (line.trim() === "") continue
    let request
    try {
      request = jsonParse(line)
    } catch {
      await send({ id: null, ok: false, error: "invalid request" })
      continue
    }
    await send(run(request))
  }
}
// stdin closed: the helper is gone. Exit directly; the normal unload path
// would try to write to the frozen global object.
exit(0)
