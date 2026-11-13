// Turns incoming MQTT messages into stored notifications.
//
// Every enabled subscription whose filter matches produces its own
// notification (no de-duplication). A parser drops a message only by
// returning `false`. Parser failures never drop a message: they produce a
// fallback notification with the raw payload and ICON_ERROR.

import type { BrokerConfig, SubscriptionConfig } from "./config.ts"
import type { Logger } from "./log.ts"
import type { IncomingMessage } from "./mqtt_manager.ts"
import type { ParserRunner } from "./parser.ts"
import type { Notification, NotificationStore } from "./store.ts"
import { matchTopic } from "./topic.ts"
import { decodePayload, fallbackText, type Icon, toString, validateOutput } from "./validate.ts"

export interface ProcessedOutput {
  text: string
  icon: Icon | null
  link: string | null
  /** True when the fallback policy was applied. */
  fallback: boolean
  /** True when the script returned `false`: no notification is created. */
  dropped: boolean
  error: string | null
  warnings: string[]
  logs: string[]
}

export interface ProcessorOptions {
  store: NotificationStore
  parser: ParserRunner
  log: Logger
  broker: (id: string) => BrokerConfig | null
  script: (brokerId: string, subscriptionId: string) => string
  maxPayloadBytes: () => number
  onNotification: (n: Notification, sub: SubscriptionConfig, broker: BrokerConfig) => void
}

export function matchingSubscriptions(
  broker: BrokerConfig,
  msg: Pick<IncomingMessage, "topic" | "retain" | "filters">,
): SubscriptionConfig[] {
  return broker.subscriptions.filter((s) => {
    if (!s.enabled) return false
    if (s.ignoreRetained && msg.retain) return false
    if (msg.filters !== null) return msg.filters.includes(s.topic)
    return matchTopic(s.topic, msg.topic)
  })
}

export class Processor {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private opts: ProcessorOptions) {}

  /** Queue a message; messages are processed strictly in arrival order. */
  handle(msg: IncomingMessage): Promise<void> {
    const run = () =>
      this.#process(msg).catch((e) => {
        this.opts.log.error(
          "processing " + msg.brokerId + " " + msg.topic + " failed: " + (e instanceof Error ? e.stack ?? e.message : String(e)),
        )
      })
    const next = this.#queue.then(run, run)
    this.#queue = next
    return next
  }

  async #process(msg: IncomingMessage): Promise<void> {
    const broker = this.opts.broker(msg.brokerId)
    if (!broker) return
    const subs = matchingSubscriptions(broker, msg)
    if (subs.length === 0) return
    for (const sub of subs) {
      const out = await this.render(msg.payload, this.opts.script(broker.id, sub.id))
      if (out.dropped) continue
      if (out.error) this.opts.log.warn("parser error [" + broker.name + " / " + msg.topic + " / " + sub.id + "]: " + out.error)
      for (const w of out.warnings) this.opts.log.info("parser warning [" + broker.name + " / " + msg.topic + " / " + sub.id + "]: " + w)
      const n = await this.opts.store.add({
        brokerId: broker.id,
        broker: broker.name,
        subscriptionId: sub.id,
        topic: msg.topic,
        text: out.text,
        icon: out.icon,
        link: out.link,
      })
      this.opts.onNotification(n, sub, broker)
    }
  }

  /** Convert a payload with a parser script; also used by the parser test (no storage). */
  async render(payload: Uint8Array, script: string): Promise<ProcessedOutput> {
    const max = this.opts.maxPayloadBytes()
    if (payload.byteLength > max) {
      return {
        text: "Payload too large (" + payload.byteLength + " bytes, limit " + max + ")",
        icon: "ICON_ERROR",
        link: null,
        fallback: true,
        dropped: false,
        error: "payload of " + payload.byteLength + " bytes exceeds the " + max + " byte limit",
        warnings: [],
        logs: [],
      }
    }
    const msgin = decodePayload(payload)

    if (script.trim() === "") {
      const checked = validateOutput({ msgout: toString(msgin) })
      if (checked.ok) return { ...checked.value, fallback: false, dropped: false, error: null, logs: [] }
      return { text: fallbackText(msgin), icon: null, link: null, fallback: false, dropped: false, error: null, warnings: [], logs: [] }
    }

    const result = await this.opts.parser.run(script, msgin)
    if (!result.ok) {
      return {
        text: fallbackText(msgin),
        icon: "ICON_ERROR",
        link: null,
        fallback: true,
        dropped: false,
        error: result.error ?? "parser failed",
        warnings: [],
        logs: result.logs,
      }
    }
    if (result.keep === false) {
      return { text: "", icon: null, link: null, fallback: false, dropped: true, error: null, warnings: [], logs: result.logs }
    }
    const checked = validateOutput(result)
    if (!checked.ok) {
      return {
        text: fallbackText(msgin),
        icon: "ICON_ERROR",
        link: null,
        fallback: true,
        dropped: false,
        error: checked.reason,
        warnings: [],
        logs: result.logs,
      }
    }
    return { ...checked.value, fallback: false, dropped: false, error: null, logs: result.logs }
  }
}
