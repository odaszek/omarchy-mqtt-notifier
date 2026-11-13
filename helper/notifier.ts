// Desktop notifications through the freedesktop notification service
// (Omarchy's own daemon) using `notify-send`.
//
// Each notification is sent with a "default" action and --wait, so clicking
// it reports back: a notification with a link opens the link, any other opens
// the plugin's panel. The link is also shown as the panel list does, a "<link glyph> Open <host>" line under
// the text: an <a href> the Omarchy daemon renders and opens after its own URL
// check. The body is escaped: the notification spec treats it as markup.

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

export class DesktopNotifier {
  enabled = true
  #waiting = 0

  /** Label of the link line ("%1" = host); set from the panel's translations. */
  linkLabel = "Open %1"

  constructor(
    private log: Logger,
    private onActivate: (id: string) => void,
    private onOpenLink: (id: string, url: string) => void,
  ) {}

  show(n: Notification, title: string): void {
    if (!this.enabled) return
    const wait = this.#waiting < MAX_WAITING
    let child: Deno.ChildProcess
    try {
      child = new Deno.Command("notify-send", {
        args: notifyArgs(n, title, wait, this.linkLabel),
        stdout: wait ? "piped" : "null",
        stderr: "piped",
        stdin: "null",
      }).spawn()
    } catch (e) {
      this.log.warn("notify-send failed: " + (e instanceof Error ? e.message : String(e)))
      return
    }
    if (wait) this.#waiting++
    child.output().then((out) => {
      if (!out.success) {
        this.log.warn("notify-send exited with " + out.code + ": " + new TextDecoder().decode(out.stderr).trim().slice(0, 300))
        return
      }
      if (!wait || new TextDecoder().decode(out.stdout).trim() !== "default") return
      if (n.link) this.onOpenLink(n.id, n.link)
      else this.onActivate(n.id)
    }).catch((e) => {
      this.log.warn("notify-send failed: " + (e instanceof Error ? e.message : String(e)))
    }).finally(() => {
      if (wait) this.#waiting--
    })
  }
}
