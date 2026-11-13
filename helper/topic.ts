// MQTT topic filter matching (MQTT 3.1.1 §4.7 / MQTT 5 §4.7).

/** True when `filter` is a syntactically valid subscription topic filter. */
export function isValidFilter(filter: string): boolean {
  if (typeof filter !== "string" || filter.length === 0 || filter.length > 65535) return false
  if (filter.includes("\u0000")) return false
  const levels = filter.split("/")
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]
    if (level.includes("#") && (level !== "#" || i !== levels.length - 1)) return false
    if (level.includes("+") && level !== "+") return false
  }
  return true
}

/**
 * True when a concrete topic name matches a subscription filter.
 * Wildcards at the first level never match topics starting with `$`.
 */
export function matchTopic(filter: string, topic: string): boolean {
  if (!isValidFilter(filter) || typeof topic !== "string" || topic.length === 0) return false
  if (topic.includes("+") || topic.includes("#")) return false
  const f = filter.split("/")
  const t = topic.split("/")
  if (topic.startsWith("$") && (f[0] === "+" || f[0] === "#")) return false
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true // also matches the parent level ("a/#" matches "a")
    if (i >= t.length) return false
    if (f[i] !== "+" && f[i] !== t[i]) return false
  }
  return f.length === t.length
}
