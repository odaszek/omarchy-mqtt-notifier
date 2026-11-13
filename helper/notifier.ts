// Desktop notifications through the freedesktop notification service
// (Omarchy's own daemon) using `notify-send`.
//
// Each notification is sent with a "default" action and --wait, so clicking
// it reports back and the plugin can open its panel. The body is escaped:
// the notification spec treats it as markup.

import type { Logger } from "./log.ts"
import type { Notification } from "./store.ts"
import { bounded, escapeMarkup, type Icon } from "./validate.ts"

const URGENCY: Record<Icon, "low" | "normal" | "critical"> = {
  ICON_QUESTION: "normal",
  ICON_OK: "low",
  ICON_WARN: "normal",
  ICON_ERROR: "critical",
}

const ICON_NAME: Record<Icon, string> = {
  ICON_QUESTION: "dialog-question",
  ICON_OK: "emblem-ok-symbolic",
  ICON_WARN: "dialog-warning",
  ICON_ERROR: "dialog-error",
}

/** Notifications that can still report a click; older ones are sent fire-and-forget. */
const MAX_WAITING = 16

export function notifyArgs(n: Notification, title: string, wait: boolean): string[] {
  const urgency = n.icon ? URGENCY[n.icon] : "normal"
  const args = [
    "--app-name=MQTT Notifier",
    "--urgency=" + urgency,
    "--icon=" + (n.icon ? ICON_NAME[n.icon] : "mail-unread-symbolic"),
    "--category=im.received",
  ]
  if (wait) args.push("--action=default=Open", "--wait")
  // "--" ends option parsing so a title or body starting with "-" is never read as a flag.
  args.push("--", bounded(title, 120), escapeMarkup(bounded(n.text, 1000)))
  return args
}

export class DesktopNotifier {
  enabled = true
  #waiting = 0

  constructor(private log: Logger, private onActivate: (id: string) => void) {}

  show(n: Notification, title: string): void {
    if (!this.enabled) return
    const wait = this.#waiting < MAX_WAITING
    let child: Deno.ChildProcess
    try {
      child = new Deno.Command("notify-send", {
        args: notifyArgs(n, title, wait),
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
      if (wait && new TextDecoder().decode(out.stdout).trim() === "default") this.onActivate(n.id)
    }).catch((e) => {
      this.log.warn("notify-send failed: " + (e instanceof Error ? e.message : String(e)))
    }).finally(() => {
      if (wait) this.#waiting--
    })
  }
}
