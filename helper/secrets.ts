// Broker secrets: Secret Service keyring via `secret-tool`, or an opt-in
// 0600 JSON file in the state directory when no keyring is available.
//
// Keyring attributes: service=omarchy-mqtt-notifier broker=<brokerId> field=<password|keyPassphrase>
// Store one by hand:  secret-tool store --label="MQTT home password" service omarchy-mqtt-notifier broker home field password

import { atomicWrite } from "./store.ts"
import type { Logger } from "./log.ts"

export type SecretField = "password" | "keyPassphrase"
export const SECRET_SERVICE = "omarchy-mqtt-notifier"

export interface SecretStore {
  get(brokerId: string, field: SecretField): Promise<string | null>
  set(brokerId: string, field: SecretField, value: string): Promise<void>
  remove(brokerId: string, field: SecretField): Promise<void>
}

export class KeyringSecrets implements SecretStore {
  constructor(private log: Logger) {}

  async get(brokerId: string, field: SecretField): Promise<string | null> {
    try {
      const out = await new Deno.Command("secret-tool", {
        args: ["lookup", "service", SECRET_SERVICE, "broker", brokerId, "field", field],
        stdout: "piped",
        stderr: "piped",
      }).output()
      if (!out.success) return null // not found (or keyring locked/unavailable)
      const value = new TextDecoder().decode(out.stdout)
      return value.length > 0 ? value : null
    } catch (e) {
      this.log.warn("secret-tool lookup failed: " + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }

  async set(brokerId: string, field: SecretField, value: string): Promise<void> {
    const child = new Deno.Command("secret-tool", {
      args: ["store", "--label=MQTT Notifier " + brokerId + " " + field, "service", SECRET_SERVICE, "broker", brokerId, "field", field],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    }).spawn()
    const w = child.stdin.getWriter()
    await w.write(new TextEncoder().encode(value))
    await w.close()
    const out = await child.output()
    if (!out.success) throw new Error("secret-tool store failed: " + new TextDecoder().decode(out.stderr).trim())
  }

  async remove(brokerId: string, field: SecretField): Promise<void> {
    await new Deno.Command("secret-tool", {
      args: ["clear", "service", SECRET_SERVICE, "broker", brokerId, "field", field],
      stdout: "null",
      stderr: "null",
    }).output()
  }
}

/** Fallback for systems without a Secret Service: a 0600 file readable only by the user. */
export class FileSecrets implements SecretStore {
  readonly file: string
  constructor(stateDir: string) {
    this.file = stateDir + "/secrets.json"
  }

  async #read(): Promise<Record<string, Record<string, string>>> {
    try {
      const info = await Deno.stat(this.file)
      if (info.mode !== null && (info.mode & 0o077) !== 0) await Deno.chmod(this.file, 0o600)
      const data = JSON.parse(await Deno.readTextFile(this.file))
      return data && typeof data === "object" ? data : {}
    } catch {
      return {}
    }
  }

  async get(brokerId: string, field: SecretField): Promise<string | null> {
    const data = await this.#read()
    const v = data[brokerId]?.[field]
    return typeof v === "string" && v.length > 0 ? v : null
  }

  async set(brokerId: string, field: SecretField, value: string): Promise<void> {
    const data = await this.#read()
    data[brokerId] = { ...(data[brokerId] ?? {}), [field]: value }
    await atomicWrite(this.file, JSON.stringify(data) + "\n")
  }

  async remove(brokerId: string, field: SecretField): Promise<void> {
    const data = await this.#read()
    if (data[brokerId]) delete data[brokerId][field]
    await atomicWrite(this.file, JSON.stringify(data) + "\n")
  }
}
