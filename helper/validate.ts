// Parser output validation, payload decoding, and the shared limits.

export const ICONS = ["ICON_QUESTION", "ICON_WARN", "ICON_ERROR", "ICON_OK", "ICON_NOTIFY"] as const
export type Icon = typeof ICONS[number]

export const LIMITS = {
  /** Largest MQTT payload handed to a parser, in bytes. Larger payloads become an error notification. */
  payloadBytes: 256 * 1024,
  /** Longest stored/displayed notification text, in characters. */
  textChars: 4096,
  /** Longest accepted link, in characters. */
  linkChars: 2048,
  /** Longest topic stored with a notification. */
  topicChars: 1024,
  /** Longest parser script accepted, in characters. */
  scriptChars: 64 * 1024,
}

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })

/** Decode MQTT payload bytes as UTF-8, replacing invalid sequences with U+FFFD. */
export function decodePayload(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Deterministic conversion used by the default parser and exposed to scripts. */
export function toString(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "bigint") return value.toString()
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

/** Cut a string to `max` characters without splitting a surrogate pair. */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end) + "…"
}

/** Only absolute http(s) URLs without credentials are accepted. */
export function validateLink(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > LIMITS.linkChars) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (!url.hostname || url.username || url.password) return null
  return url.href
}

export function validateIcon(value: unknown): Icon | null {
  return typeof value === "string" && (ICONS as readonly string[]).includes(value) ? value as Icon : null
}

export interface ParserOutput {
  msgout?: unknown
  msgicon?: unknown
  msglink?: unknown
}

export interface ValidatedOutput {
  text: string
  icon: Icon | null
  link: string | null
  /** Non-fatal problems: an invalid icon or link is dropped, not fatal. */
  warnings: string[]
}

/**
 * Validate what a parser produced. Fails only when `msgout` is unusable, so
 * the caller can apply the fallback policy; a bad icon or link is dropped.
 */
export function validateOutput(out: ParserOutput): { ok: true; value: ValidatedOutput } | { ok: false; reason: string } {
  if (typeof out.msgout !== "string") return { ok: false, reason: "msgout is not a string" }
  const text = out.msgout.trim()
  if (text.length === 0) return { ok: false, reason: "msgout is empty" }
  const warnings: string[] = []
  const icon = validateIcon(out.msgicon)
  if (icon === null && out.msgicon !== null && out.msgicon !== undefined) {
    warnings.push("msgicon ignored: not one of " + ICONS.join(", "))
  }
  const link = validateLink(out.msglink)
  if (link === null && out.msglink !== null && out.msglink !== undefined && out.msglink !== "") {
    warnings.push("msglink ignored: only absolute http(s) URLs are allowed")
  }
  return { ok: true, value: { text: bounded(text, LIMITS.textChars), icon, link, warnings } }
}

/** Text used when a parser fails: the raw payload, or a placeholder for an empty one. */
export function fallbackText(payload: string): string {
  const text = payload.trim()
  return text.length > 0 ? bounded(text, LIMITS.textChars) : "(empty payload)"
}

/** Escape text for the freedesktop notification body, which is markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}
