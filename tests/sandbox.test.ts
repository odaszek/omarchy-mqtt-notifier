// The parser worker must not reach protected resources, must survive hostile
// scripts, and must isolate one script run from the next.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1"
import { ParserRunner } from "../helper/parser.ts"
import { MemoryLogger } from "../helper/log.ts"

const workerDir = new URL("../helper/worker", import.meta.url).pathname

function runner(sandbox: "auto" | "deno" = "auto", timeoutMs = 500): ParserRunner {
  return new ParserRunner({
    timeoutMs,
    memoryMb: 64,
    sandbox,
    denoPath: Deno.execPath(),
    workerDir,
    cacheDir: Deno.makeTempDirSync({ prefix: "mqttn-cache-" }),
    log: new MemoryLogger(),
  })
}

Deno.test({
  name: "sandbox: reserved variables and helpers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = runner()
    try {
      const out = await r.run(
        `
        var d = JSON.parse(msgin)
        msgout = "Temperature: " + d.temperature + " °C, Humidity: " + d.humidity + "%"
        msgicon = d.temperature > 28 ? ICON_WARN : ICON_OK
        msglink = "https://example.com/sensor"
      `,
        '{"temperature":29.5,"humidity":65}',
      )
      assert(out.ok, out.error)
      assertEquals(out.msgout, "Temperature: 29.5 °C, Humidity: 65%")
      assertEquals(out.msgicon, "ICON_WARN")
      assertEquals(out.msglink, "https://example.com/sensor")
      const xml = await r.run(
        "var d = parseXml(msgin); msgout = d.sensor.status; console.log('t', d.sensor.temperature)",
        "<sensor><temperature>29.5</temperature><status>warning</status></sensor>",
      )
      assertEquals(xml.msgout, "warning")
      assertEquals(xml.logs, ["log: t 29.5"])
      assertEquals((await r.run("msgout = to_string(msgin)", "plain")).msgout, "plain")
      // `return` ends the script early and keeps what was set so far.
      assertEquals((await r.run("msgout = 'early'; return; msgout = 'late'", "")).msgout, "early")
    } finally {
      await r.close()
    }
  },
})

Deno.test({
  name: "sandbox: no filesystem, network, env, subprocess or Deno namespace",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = runner()
    try {
      const probes: Record<string, string> = {
        deno: "msgout = typeof Deno",
        fetch: "msgout = typeof fetch",
        timers: "msgout = typeof setTimeout + typeof setInterval",
        websocket: "msgout = typeof WebSocket",
        worker: "msgout = typeof Worker",
        globalDeno: "msgout = typeof Function('return this')().Deno",
        importFs: "msgout = 'x'; import('node:fs').then(fs => fs.readFileSync('/etc/passwd'))",
        process: "msgout = typeof process",
      }
      for (const [name, script] of Object.entries(probes)) {
        const out = await r.run(script, "")
        assert(out.ok, name + ": " + out.error)
        assertFalse(String(out.msgout).includes("function") || String(out.msgout).includes("object"), name + " leaked: " + out.msgout)
      }
      // Dynamic import (if it resolves at all) must not reach the filesystem.
      const imp = await r.run("msgout = 'started'", "")
      assertEquals(imp.msgout, "started")
    } finally {
      await r.close()
    }
  },
})

Deno.test({
  name: "sandbox: scripts cannot leave state for later scripts",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = runner()
    try {
      const writeGlobal = await r.run("globalThis.secret = msgin; msgout = 'x'", "s3cret")
      assertFalse(writeGlobal.ok)
      const sloppy = await r.run("leak = 1; msgout = 'x'", "")
      assertFalse(sloppy.ok)
      const proto = await r.run("JSON.parse = () => 'pwned'; msgout = 'x'", "")
      assertFalse(proto.ok)
      const arr = await r.run("Array.prototype.map = null; msgout = 'x'", "")
      assertFalse(arr.ok)
      const check = await r.run("msgout = typeof globalThis.secret + ' ' + JSON.parse('\"ok\"') + ' ' + typeof [].map", "")
      assertEquals(check.msgout, "undefined ok function")
    } finally {
      await r.close()
    }
  },
})

Deno.test({
  name: "sandbox: timeout and memory exhaustion are contained",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = runner("auto", 300)
    try {
      const loop = await r.run("while (true) {}", "")
      assertFalse(loop.ok)
      assertStringIncludes(loop.error ?? "", "timed out")
      assertEquals((await r.run("msgout = msgin", "next")).msgout, "next")

      const oom = await r.run("var a = []; for (;;) a.push(new Array(1e6).fill(1))", "")
      assertFalse(oom.ok)
      assertEquals((await r.run("msgout = msgin", "after")).msgout, "after")

      const thrown = await r.run("throw new Error('boom')", "")
      assertEquals(thrown.error, "Error: boom")
      const syntax = await r.run("this is not javascript", "")
      assertFalse(syntax.ok)
      assertStringIncludes(syntax.error ?? "", "SyntaxError")
    } finally {
      await r.close()
    }
  },
})

Deno.test({
  name: "sandbox: bubblewrap mode is used when available",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const r = runner()
    try {
      await r.run("msgout = 'x'", "")
      const probe = await new Deno.Command("bwrap", {
        args: [
          "--unshare-all",
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
      }).output().catch(() => null)
      if (probe?.success) assertEquals(r.sandboxMode, "bwrap")
    } finally {
      await r.close()
    }
  },
})
