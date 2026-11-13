// Runs parser scripts in the restricted worker process (worker/worker.js).
//
// One long-lived worker handles requests one at a time. A request that
// exceeds the timeout, or a worker that dies (e.g. V8 out of memory), kills
// and replaces the worker; the failed request gets an error result and the
// queue continues.

import { LIMITS } from "./validate.ts"
import type { Logger } from "./log.ts"

export interface ParserResult {
  ok: boolean
  /** False when the script returned exactly `false`: the message is dropped. */
  keep?: boolean
  msgout?: unknown
  msgicon?: unknown
  msglink?: unknown
  error?: string
  logs: string[]
}

export interface ParserOptions {
  timeoutMs: number
  memoryMb: number
  /** "bwrap": Deno permissions plus a bubblewrap namespace; "deno": Deno permissions only; "auto": bwrap when it works. */
  sandbox: "auto" | "bwrap" | "deno"
  denoPath: string
  workerDir: string
  /** Writable directory for Deno's cache when running without bubblewrap. */
  cacheDir: string
  log: Logger
}

interface Pending {
  id: number
  script: string
  msgin: string
  resolve: (r: ParserResult) => void
}

const READY_TIMEOUT_MS = 10_000

export class ParserRunner {
  #opts: ParserOptions
  #proc: Deno.ChildProcess | null = null
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  #ready: Promise<void> | null = null
  #queue: Pending[] = []
  #busy = false
  #nextId = 1
  #current: Pending | null = null
  #lineWaiter: ((line: string | null) => void) | null = null
  #lines: string[] = []
  #sandboxMode: "bwrap" | "deno" | null = null
  #closed = false
  restarts = 0

  constructor(opts: ParserOptions) {
    this.#opts = opts
  }

  get sandboxMode(): string {
    return this.#sandboxMode ?? "not started"
  }

  run(script: string, msgin: string): Promise<ParserResult> {
    if (script.length > LIMITS.scriptChars) {
      return Promise.resolve({ ok: false, error: "parser script is longer than " + LIMITS.scriptChars + " characters", logs: [] })
    }
    return new Promise((resolve) => {
      this.#queue.push({ id: this.#nextId++, script, msgin, resolve })
      this.#pump()
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const p of this.#queue.splice(0)) p.resolve({ ok: false, error: "parser stopped", logs: [] })
    await this.#kill()
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#closed) return
    this.#busy = true
    try {
      while (this.#queue.length > 0 && !this.#closed) {
        const job = this.#queue.shift()!
        this.#current = job
        job.resolve(await this.#execute(job))
        this.#current = null
      }
    } finally {
      this.#busy = false
    }
  }

  async #execute(job: Pending): Promise<ParserResult> {
    try {
      await this.#ensure()
    } catch (e) {
      await this.#kill()
      return { ok: false, error: "parser worker failed to start: " + errorText(e), logs: [] }
    }
    const line = JSON.stringify({ id: job.id, script: job.script, msgin: job.msgin }) + "\n"
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.#writer!.write(new TextEncoder().encode(line))
      const reply = await Promise.race([
        this.#readLine(),
        new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), this.#opts.timeoutMs)
        }),
      ])
      if (reply === "timeout") {
        this.#opts.log.warn("parser exceeded " + this.#opts.timeoutMs + " ms; restarting worker")
        await this.#kill()
        return { ok: false, error: "parser timed out after " + this.#opts.timeoutMs + " ms", logs: [] }
      }
      if (reply === null) {
        await this.#kill()
        return { ok: false, error: "parser worker exited (out of memory or crashed)", logs: [] }
      }
      return parseReply(reply, job.id)
    } catch (e) {
      await this.#kill()
      return { ok: false, error: "parser worker error: " + errorText(e), logs: [] }
    } finally {
      clearTimeout(timer)
    }
  }

  #readLine(): Promise<string | null> {
    if (this.#lines.length > 0) return Promise.resolve(this.#lines.shift()!)
    return new Promise((resolve) => {
      this.#lineWaiter = resolve
    })
  }

  #pushLine(line: string | null): void {
    const waiter = this.#lineWaiter
    if (waiter) {
      this.#lineWaiter = null
      waiter(line)
    } else if (line !== null) {
      this.#lines.push(line)
    }
  }

  async #ensure(): Promise<void> {
    if (this.#proc && this.#ready) return this.#ready
    if (this.#sandboxMode === null) this.#sandboxMode = await this.#pickSandbox()
    const cmd = this.#command(this.#sandboxMode)
    const proc = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: this.#sandboxMode === "deno" ? { NO_COLOR: "1", DENO_DIR: this.#opts.cacheDir } : {},
    }).spawn()
    this.#proc = proc
    this.#writer = proc.stdin.getWriter()
    this.#lines = []
    this.restarts++
    this.#readStdout(proc)
    this.#drainStderr(proc)
    this.#ready = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const first = await Promise.race([
        this.#readLine(),
        new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), READY_TIMEOUT_MS)
        }),
      ])
      clearTimeout(timer)
      if (first === "timeout") throw new Error("worker did not become ready")
      if (first === null) throw new Error("worker exited during startup")
      const msg = safeJson(first)
      if (!msg || msg.ready !== true) throw new Error("unexpected worker greeting")
    })()
    return this.#ready
  }

  async #readStdout(proc: Deno.ChildProcess): Promise<void> {
    let buffer = ""
    try {
      for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
        if (proc !== this.#proc) return
        buffer += chunk
        if (buffer.length > 4 * 1024 * 1024 && buffer.indexOf("\n") === -1) {
          this.#opts.log.warn("parser worker sent an oversized reply; restarting it")
          await this.#kill()
          return
        }
        let nl
        while ((nl = buffer.indexOf("\n")) !== -1) {
          this.#pushLine(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
        }
      }
    } catch { /* process killed */ }
    // Only the current worker's exit wakes a waiting request; a worker that
    // was already replaced must not fail the next one.
    if (proc === this.#proc) {
      this.#proc = null
      this.#ready = null
      this.#writer = null
      this.#pushLine(null)
    }
  }

  async #drainStderr(proc: Deno.ChildProcess): Promise<void> {
    // One condensed line per worker process: V8 dumps long GC/stack traces on OOM.
    let text = ""
    try {
      for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
        if (text.length < 8192) text += chunk
      }
    } catch { /* ignore */ }
    text = text.trim()
    if (text === "") return
    if (/out of memory|heap limit/i.test(text)) {
      this.#opts.log.warn("parser worker ran out of memory (limit " + this.#opts.memoryMb + " MB)")
    } else {
      this.#opts.log.warn("parser worker stderr: " + text.replace(/\s+/g, " ").slice(0, 300))
    }
  }

  async #kill(): Promise<void> {
    const proc = this.#proc
    this.#proc = null
    this.#ready = null
    this.#writer = null
    this.#lines = []
    if (!proc) return
    try {
      proc.kill("SIGKILL")
    } catch { /* already gone */ }
    try {
      await proc.status
    } catch { /* ignore */ }
    this.#pushLine(null)
  }

  #command(mode: "bwrap" | "deno"): string[] {
    const deno = [
      this.#opts.denoPath,
      "run",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--cached-only",
      "--v8-flags=--max-old-space-size=" + Math.max(16, Math.floor(this.#opts.memoryMb)),
    ]
    if (mode === "deno") return [...deno, this.#opts.workerDir + "/worker.js"]
    return [
      "bwrap",
      "--clearenv",
      "--setenv",
      "NO_COLOR",
      "1",
      "--setenv",
      "DENO_DIR",
      "/tmp/deno",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--symlink",
      "usr/bin",
      "/bin",
      "--ro-bind",
      this.#opts.denoPath,
      "/run/deno",
      "--ro-bind",
      this.#opts.workerDir,
      "/worker",
      "--tmpfs",
      "/tmp",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      "/worker",
      "/run/deno",
      ...deno.slice(1),
      "/worker/worker.js",
    ]
  }

  async #pickSandbox(): Promise<"bwrap" | "deno"> {
    const wanted = this.#opts.sandbox
    if (wanted === "deno") return "deno"
    try {
      const probe = await new Deno.Command("bwrap", {
        args: [
          "--unshare-all",
          "--die-with-parent",
          "--ro-bind",
          "/usr",
          "/usr",
          "--symlink",
          "usr/bin",
          "/bin",
          "--symlink",
          "usr/lib",
          "/lib",
          "--symlink",
          "usr/lib64",
          "/lib64",
          "/usr/bin/true",
        ],
        stdout: "null",
        stderr: "piped",
        clearEnv: true,
      }).output()
      if (probe.success) return "bwrap"
      this.#opts.log.warn("bubblewrap unavailable: " + new TextDecoder().decode(probe.stderr).trim().slice(0, 300))
    } catch (e) {
      this.#opts.log.warn("bubblewrap unavailable: " + errorText(e))
    }
    if (wanted === "bwrap") throw new Error('sandbox "bwrap" was requested but bubblewrap does not work here')
    this.#opts.log.warn("parser worker runs with Deno permissions only (no namespace sandbox)")
    return "deno"
  }
}

function parseReply(line: string, id: number): ParserResult {
  const msg = safeJson(line)
  if (!msg || msg.id !== id || typeof msg.ok !== "boolean") return { ok: false, error: "malformed reply from parser worker", logs: [] }
  const logs = Array.isArray(msg.logs)
    ? msg.logs.filter((l: unknown) => typeof l === "string").slice(0, 20).map((l: string) => l.slice(0, 600))
    : []
  if (!msg.ok) return { ok: false, error: typeof msg.error === "string" ? msg.error.slice(0, 1000) : "parser failed", logs }
  return { ok: true, keep: msg.keep !== false, msgout: msg.msgout, msgicon: msg.msgicon, msglink: msg.msglink, logs }
}

// deno-lint-ignore no-explicit-any
function safeJson(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
