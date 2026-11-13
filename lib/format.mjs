// Pure helpers shared by the QML views. ES module: QML imports it with
// `import "../lib/format.mjs" as Format`, and tests/qml-lib.test.ts runs it
// under Deno. No QML or Qt APIs here.

const glyph = (cp) => String.fromCodePoint(cp)

// Nerd Font (Material Design) glyphs.
export const BAR_ICON = glyph(0xf009a) // nf-md-bell
export const BAR_ICON_UNREAD = glyph(0xf116b) // nf-md-bell_badge
export const BAR_ICON_ALERT = glyph(0xf0d59) // nf-md-bell_alert (a broker is down)
export const ICON_CLEAR = glyph(0xf0a7a) // nf-md-trash_can_outline
export const ICON_SETTINGS = glyph(0xf0493) // nf-md-cog
export const ICON_RETRY = glyph(0xf0450) // nf-md-refresh
export const ICON_LINK = glyph(0xf0339) // nf-md-link_variant
export const ICON_WARNING = glyph(0xf0026) // nf-md-alert

const NOTIFICATION_ICONS = {
  ICON_QUESTION: glyph(0xf02d7), // nf-md-help_circle
  ICON_WARN: glyph(0xf0026), // nf-md-alert
  ICON_ERROR: glyph(0xf0159), // nf-md-close_circle
  ICON_OK: glyph(0xf05e0), // nf-md-check_circle
}
const DEFAULT_NOTIFICATION_ICON = glyph(0xf0361) // nf-md-message_text

/** Glyph for a notification icon constant; a neutral glyph for none/unknown. */
export function iconGlyph(icon) {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_ICONS, icon) ? NOTIFICATION_ICONS[icon] : DEFAULT_NOTIFICATION_ICON
}

/** Theme role used to tint an icon: "urgent", "accent", "dim" or "foreground". */
export function iconTone(icon) {
  if (icon === "ICON_ERROR") return "urgent"
  if (icon === "ICON_WARN") return "accent"
  if (icon === "ICON_OK") return "dim"
  return "foreground"
}

const SAFE_URL = /^https?:\/\/[^\s/?#@\\]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i

/**
 * Second check before handing a link to the desktop (the helper already
 * validated it): absolute http(s), no credentials, no whitespace or controls.
 */
export function safeLink(value) {
  if (typeof value !== "string") return ""
  const url = value.trim()
  if (url.length === 0 || url.length > 2048) return ""
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return ""
  return SAFE_URL.test(url) ? url : ""
}

/** Host part of a safe link, for display next to the link icon. */
export function linkHost(value) {
  const url = safeLink(value)
  if (!url) return ""
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url)
  return m ? m[1] : ""
}

/** True when two dates fall on the same local calendar day. */
export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * Brokers to warn about: enabled ones that are down, or reconnecting after a
 * failure. A broker on its first connection attempt is not a warning yet.
 */
export function brokerWarnings(brokers) {
  if (!Array.isArray(brokers)) return []
  return brokers.filter((b) =>
    b && b.enabled && (
      b.state === "disconnected" || b.state === "error" || (b.state === "connecting" && !!b.error)
    )
  )
}

/** Clamp a setting to an integer range, falling back on junk. */
export function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** The settings object of the first bar entry with this plugin id. */
export function findEntrySettings(barConfig, id) {
  const layout = barConfig && barConfig.layout
  if (!layout || typeof layout !== "object") return {}
  for (const section of ["left", "centerBegin", "center", "centerEnd", "right", "tray"]) {
    const list = layout[section]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry && typeof entry === "object" && entry.id === id) return entry
    }
  }
  return {}
}

/** Convert a helper notification into a flat ListModel row (no nulls: roles are typed). */
export function toRow(n) {
  return {
    seq: Number(n.seq) || 0,
    nid: String(n.id || ""),
    timestamp: String(n.timestamp || ""),
    brokerName: String(n.broker || ""),
    brokerId: String(n.brokerId || ""),
    topic: String(n.topic || ""),
    body: String(n.text || ""),
    icon: typeof n.icon === "string" ? n.icon : "",
    link: safeLink(n.link),
    read: n.read === true,
  }
}
