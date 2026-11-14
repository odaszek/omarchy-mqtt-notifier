// Turns incoming MQTT messages into stored notifications.
//
// Every enabled subscription whose filter matches produces its own
// notification (no de-duplication). A parser drops a message only by
// returning `false`. Parser failures never drop a message: they produce a
// fallback notification with the raw payload and ICON_ERROR.
//
// Messages are processed one at a time, so the pending queue is bounded:
// messages no subscription wants are discarded before queueing, oversized
// payloads are replaced by their size, and once the backlog reaches
// MAX_PENDING_MESSAGES / MAX_PENDING_BYTES `handle()` returns a promise that
// holds the broker connection (mqtt.js `handleMessage`) until it drains.

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
  /** Backlog limits (tests override them). */
  maxPendingMessages?: number
  maxPendingBytes?: number
}

export const MAX_PENDING_MESSAGES = 200
export const MAX_PENDING_BYTES = 16 * 1024 * 1024

interface QueuedMessage extends IncomingMessage {
  /** Original size of a payload over the limit (its bytes are not kept), else null. */
  oversize: number | null
  limit: number
}

function tooLarge(size: number, max: number): ProcessedOutput {
  return {
    text: "Payload too large (" + size + " bytes, limit " + max + ")",
    icon: "ICON_ERROR",
    link: null,
    fallback: true,
    dropped: false,
    error: "payload of " + size + " bytes exceeds the " + max + " byte limit",
    warnings: [],
    logs: [],
  }
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
  #pending = 0
  #pendingBytes = 0
  #waiters: (() => void)[] = []
  #maxMessages: number
  #maxBytes: number

  constructor(private opts: ProcessorOptions) {
    this.#maxMessages = opts.maxPendingMessages ?? MAX_PENDING_MESSAGES
    this.#maxBytes = opts.maxPendingBytes ?? MAX_PENDING_BYTES
  }

  /** Messages queued or being processed. */
  get pending(): number {
    return this.#pending
  }

  /**
   * Queue a message; messages are processed strictly in arrival order. The
   * returned promise resolves when the caller may deliver the next message:
   * at once, or after the backlog has drained to half its limits.
   */
  handle(msg: IncomingMessage): Promise<void> {
    const broker = this.opts.broker(msg.brokerId)
    if (!broker || matchingSubscriptions(broker, msg).length === 0) return Promise.resolve()
    const limit = this.opts.maxPayloadBytes()
    const size = msg.payload.byteLength
    // Build a fresh record and never use `msg` after this point: a closure
    // that kept it would keep the original (possibly oversized) payload alive
    // until the message is processed. The payload is copied so only its own
    // bytes are kept, not the socket chunk it was parsed from.
    const queued: QueuedMessage = {
      brokerId: msg.brokerId,
      topic: msg.topic,
      retain: msg.retain,
      filters: msg.filters,
      payload: size > limit ? new Uint8Array(0) : msg.payload.slice(),
      oversize: size > limit ? size : null,
      limit,
    }
    this.#enqueue(queued)
    if (this.#pending < this.#maxMessages && this.#pendingBytes < this.#maxBytes) return Promise.resolve()
    if (this.#waiters.length === 0) {
      this.opts.log.warn(
        "message backlog full (" + this.#pending + " messages, " + this.#pendingBytes + " bytes); pausing brokers until it drains",
      )
    }
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  /** Bytes charged to the backlog: payloads kept plus topics (UTF-16). */
  get pendingBytes(): number {
    return this.#pendingBytes
  }

  #enqueue(queued: QueuedMessage): void {
    const cost = queued.payload.byteLength + queued.topic.length * 2
    this.#pending++
    this.#pendingBytes += cost
    const run = () =>
      this.#process(queued).catch((e) => {
        this.opts.log.error(
          "processing " + queued.brokerId + " " + queued.topic + " failed: " + (e instanceof Error ? e.stack ?? e.message : String(e)),
        )
      }).finally(() => {
        this.#pending--
        this.#pendingBytes -= cost
        this.#release()
      })
    this.#queue = this.#queue.then(run, run)
  }

  /** Resolves once everything queued so far has been processed. */
  async idle(): Promise<void> {
    while (this.#pending > 0) await this.#queue
  }

  #release(): void {
    if (this.#waiters.length === 0) return
    if (this.#pending > this.#maxMessages / 2 || this.#pendingBytes > this.#maxBytes / 2) return
    const waiters = this.#waiters
    this.#waiters = []
    for (const w of waiters) w()
  }

  async #process(msg: QueuedMessage): Promise<void> {
    const broker = this.opts.broker(msg.brokerId)
    if (!broker) return
    const subs = matchingSubscriptions(broker, msg)
    if (subs.length === 0) return
    for (const sub of subs) {
      const out = msg.oversize !== null
        ? tooLarge(msg.oversize, msg.limit)
        : await this.render(msg.payload, this.opts.script(broker.id, sub.id))
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
    if (payload.byteLength > max) return tooLarge(payload.byteLength, max)
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
