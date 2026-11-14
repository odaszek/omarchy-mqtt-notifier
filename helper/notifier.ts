// Desktop notifications through the freedesktop notification service
// (Omarchy's own daemon) using `notify-send`.
//
// Each notification is sent with a "default" action and --wait, so clicking
// it reports back: a notification with a link opens the link, any other opens
// the plugin's panel. The link is also shown as the panel list does, a "<link glyph> Open <host>" line under
// the text: an <a href> the Omarchy daemon renders and opens after its own URL
// check. The body is escaped: the notification spec treats it as markup.
//
// Popups are rate limited (a burst of BURST, then one per REFILL_MS) and at
// most MAX_RUNNING notify-send processes run at once, so a flood of MQTT
// messages can neither spawn processes without bound nor bury the desktop.
// Messages over the limit are still stored; one summary popup reports them.

import type { Logger } from "./log.ts"
import type { Notification } from "./store.ts"
import { bounded, escapeMarkup, type Icon } from "./validate.ts"

const URGENCY: Record<Icon, "low" | "normal" | "critical"> = {
  ICON_QUESTION: "normal",
  ICON_OK: "low",
  ICON_WARN: "normal",
  ICON_ERROR: "critical",
  ICON_NOTIFY: "normal",
}

const ICON_NAME: Record<Icon, string> = {
  ICON_QUESTION: "dialog-question",
  ICON_OK: "emblem-ok-symbolic",
  ICON_WARN: "dialog-warning",
  ICON_ERROR: "dialog-error",
  ICON_NOTIFY: "dialog-information",
}

const LINK_GLYPH = String.fromCodePoint(0xf0339) // nf-md-link_variant, as in the panel

/**
 * The link line of a notification body. `label` has "%1" for the host.
 * The daemon only turns `<a href="…">` into a link when the URL has no `"` or
 * `&`; such a URL is shown in full instead, which the daemon makes clickable.
 */
export function linkLine(link: string, label: string): string {
  let host = ""
  try {
    host = new URL(link).hostname
  } catch {
    return ""
  }
  if (/["&<>\s]/.test(link)) return LINK_GLYPH + " " + escapeMarkup(link)
  return '<a href="' + link + '">' + LINK_GLYPH + " " + escapeMarkup(label.replace("%1", host)) + "</a>"
}

/** Notifications that can still report a click; older ones are sent fire-and-forget. */
const MAX_WAITING = 16

export function notifyArgs(n: Notification, title: string, wait: boolean, linkLabel = "Open %1"): string[] {
  const urgency = n.icon ? URGENCY[n.icon] : "normal"
  const args = [
    "--app-name=MQTT Notifier",
    "--urgency=" + urgency,
    "--icon=" + (n.icon ? ICON_NAME[n.icon] : "mail-unread-symbolic"),
    "--category=im.received",
  ]
  if (wait) args.push("--action=default=Open", "--wait")
  let body = escapeMarkup(bounded(n.text, 1000))
  const link = n.link ? linkLine(n.link, linkLabel) : ""
  if (link) body += "\n" + link
  // "--" ends option parsing so a title or body starting with "-" is never read as a flag.
  args.push("--", bounded(title, 120), body)
  return args
}

/** Popups allowed back to back, then one per REFILL_MS. */
export const BURST = 5
export const REFILL_MS = 2000
/** notify-send processes running at once (waiting for a click or still starting). */
const MAX_RUNNING = 32

export function summaryArgs(count: number, label: string, wait: boolean): string[] {
  const args = ["--app-name=MQTT Notifier", "--urgency=normal", "--icon=mail-unread-symbolic", "--category=im.received"]
  if (wait) args.push("--action=default=Open", "--wait")
  args.push("--", "MQTT Notifier", escapeMarkup(label.replace("%1", String(count))))
  return args
}

export interface NotifierOptions {
  burst?: number
  refillMs?: number
  /** Runs notify-send; resolves with its stdout, or null when it failed. Tests replace it. */
  exec?: (args: string[], wait: boolean) => Promise<string | null>
}

export class DesktopNotifier {
  #enabled = true
  #waiting = 0
  #running = 0
  #burst: number
  #refillMs: number
  #tokens: number
  #refilledAt = Date.now()
  #suppressed = 0
  #summaryTimer: ReturnType<typeof setTimeout> | undefined
  #exec: (args: string[], wait: boolean) => Promise<string | null>

  /** Label of the link line ("%1" = host); set from the panel's translations. */
  linkLabel = "Open %1"
  /** Text of the popup that reports rate-limited messages ("%1" = how many). */
  suppressedLabel = "%1 more messages arrived. Open the panel to see them."

  constructor(
    private log: Logger,
    private onActivate: (id: string) => void,
    private onOpenLink: (id: string, url: string) => void,
    options: NotifierOptions = {},
  ) {
    this.#burst = options.burst ?? BURST
    this.#refillMs = options.refillMs ?? REFILL_MS
    this.#tokens = this.#burst
    this.#exec = options.exec ?? ((args, wait) => this.#notifySend(args, wait))
  }

  get enabled(): boolean {
    return this.#enabled
  }
  set enabled(value: boolean) {
    this.#enabled = value
    if (!value) {
      this.#suppressed = 0
      clearTimeout(this.#summaryTimer)
      this.#summaryTimer = undefined
    }
  }

  show(n: Notification, title: string): void {
    if (!this.#enabled) return
    if (!this.#take()) {
      this.#suppressed++
      this.#scheduleSummary()
      return
    }
    const wait = this.#waiting < MAX_WAITING
    this.#run(notifyArgs(n, title, wait, this.linkLabel), wait, () => {
      if (n.link) this.onOpenLink(n.id, n.link)
      else this.onActivate(n.id)
    })
  }

  /** Take one popup from the allowance, if there is one. */
  #take(): boolean {
    const now = Date.now()
    const earned = Math.floor((now - this.#refilledAt) / this.#refillMs)
    if (earned > 0) {
      this.#tokens = Math.min(this.#burst, this.#tokens + earned)
      this.#refilledAt = this.#tokens === this.#burst ? now : this.#refilledAt + earned * this.#refillMs
    }
    if (this.#tokens < 1 || this.#running >= MAX_RUNNING) return false
    this.#tokens--
    return true
  }

  #scheduleSummary(): void {
    if (this.#summaryTimer !== undefined) return
    this.#summaryTimer = setTimeout(() => {
      this.#summaryTimer = undefined
      if (!this.#enabled || this.#suppressed === 0) return
      if (!this.#take()) return this.#scheduleSummary()
      const count = this.#suppressed
      this.#suppressed = 0
      const wait = this.#waiting < MAX_WAITING
      this.#run(summaryArgs(count, this.suppressedLabel, wait), wait, () => this.onActivate(""))
    }, this.#refillMs)
  }

  #run(args: string[], wait: boolean, onClick: () => void): void {
    this.#running++
    if (wait) this.#waiting++
    this.#exec(args, wait).then((stdout) => {
      if (wait && stdout !== null && stdout.trim() === "default") onClick()
    }).finally(() => {
      this.#running--
      if (wait) this.#waiting--
    })
  }

  async #notifySend(args: string[], wait: boolean): Promise<string | null> {
    try {
      const out = await new Deno.Command("notify-send", {
        args,
        stdout: wait ? "piped" : "null",
        stderr: "piped",
        stdin: "null",
      }).output()
      if (!out.success) {
        this.log.warn("notify-send exited with " + out.code + ": " + new TextDecoder().decode(out.stderr).trim().slice(0, 300))
        return null
      }
      return wait ? new TextDecoder().decode(out.stdout) : ""
    } catch (e) {
      this.log.warn("notify-send failed: " + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }
}
