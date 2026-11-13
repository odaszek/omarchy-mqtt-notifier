// Persistent notification history: JSON Lines, single writer (this process).
//
// notifications.jsonl  one record per line, oldest first, append-only between compactions
// state.json           { nextSeq, readThroughSeq } — written atomically (tmp + rename)
//
// Read state is a cursor: a record is read when its seq <= readThroughSeq.
// "Mark all read" therefore never rewrites the history file.

import { bounded, type Icon, LIMITS, validateIcon, validateLink } from "./validate.ts"

export interface NotificationInput {
  brokerId: string
  broker: string
  subscriptionId: string
  topic: string
  text: string
  icon: Icon | null
  link: string | null
}

export interface StoredNotification extends NotificationInput {
  seq: number
  id: string
  timestamp: string
}

export interface Notification extends StoredNotification {
  read: boolean
}

export interface Page {
  items: Notification[]
  hasMore: boolean
  total: number
  unread: number
}

export const DEFAULT_RETENTION = 1000
export const MAX_RETENTION = 100_000

export class NotificationStore {
  readonly file: string
  readonly stateFile: string
  #records: StoredNotification[] = []
  #nextSeq = 1
  #readThroughSeq = 0
  #retention = DEFAULT_RETENTION
  #onDisk = 0 // records currently in the file (may exceed retention until compaction)
  #queue: Promise<unknown> = Promise.resolve()
  skippedOnLoad = 0

  constructor(readonly dir: string) {
    this.file = dir + "/notifications.jsonl"
    this.stateFile = dir + "/state.json"
  }

  get total(): number {
    return this.#records.length
  }
  get retention(): number {
    return this.#retention
  }
  get unread(): number {
    let n = 0
    for (let i = this.#records.length - 1; i >= 0 && this.#records[i].seq > this.#readThroughSeq; i--) n++
    return n
  }

  async open(retention = DEFAULT_RETENTION): Promise<void> {
    this.#retention = clampRetention(retention)
    await Deno.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const state = await readJson(this.stateFile)
    if (state && typeof state === "object") {
      const s = state as Record<string, unknown>
      if (Number.isSafeInteger(s.nextSeq) && (s.nextSeq as number) > 0) this.#nextSeq = s.nextSeq as number
      if (Number.isSafeInteger(s.readThroughSeq) && (s.readThroughSeq as number) >= 0) this.#readThroughSeq = s.readThroughSeq as number
    }

    let text = ""
    try {
      text = await Deno.readTextFile(this.file)
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    }
    const records: StoredNotification[] = []
    let skipped = 0
    let lines = 0
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue
      lines++
      const rec = parseRecord(line)
      if (rec) records.push(rec)
      else skipped++
    }
    // Records without a usable seq (hand-edited or imported) get one in file order.
    let maxSeq = 0
    for (const r of records) if (r.seq > maxSeq) maxSeq = r.seq
    for (const r of records) if (r.seq <= 0) r.seq = ++maxSeq
    records.sort((a, b) => a.seq - b.seq)
    this.#records = records
    this.#onDisk = lines
    this.#nextSeq = Math.max(this.#nextSeq, maxSeq + 1)
    this.#readThroughSeq = Math.min(this.#readThroughSeq, this.#nextSeq - 1)
    this.skippedOnLoad = skipped

    const trimmed = this.#trimToRetention()
    if (skipped > 0 || trimmed > 0) await this.#serial(() => this.#compact())
  }

  /** Append one notification; returns the stored record. */
  add(input: NotificationInput, now = new Date()): Promise<Notification> {
    const rec: StoredNotification = {
      seq: this.#nextSeq++,
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      ...sanitizeInput(input),
    }
    this.#records.push(rec)
    const trimmed = this.#trimToRetention()
    return this.#serial(async () => {
      await Deno.writeTextFile(this.file, JSON.stringify(rec) + "\n", { append: true, mode: 0o600 })
      this.#onDisk++
      await this.#writeState()
      // Compact with some slack so a full history doesn't rewrite the file on every message.
      if (trimmed > 0 && this.#onDisk > this.#records.length + compactionSlack(this.#retention)) await this.#compact()
      return this.#decorate(rec)
    })
  }

  /** Newest first. `beforeSeq` is the cursor from the previous page (exclusive); omit for the first page. */
  page(limit: number, beforeSeq?: number): Page {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 10))
    let end = this.#records.length // exclusive index
    if (beforeSeq !== undefined && Number.isFinite(beforeSeq)) {
      end = lowerBound(this.#records, beforeSeq)
    }
    const start = Math.max(0, end - n)
    const items = this.#records.slice(start, end).reverse().map((r) => this.#decorate(r))
    return { items, hasMore: start > 0, total: this.#records.length, unread: this.unread }
  }

  markAllRead(): Promise<number> {
    const last = this.#records.length > 0 ? this.#records[this.#records.length - 1].seq : this.#nextSeq - 1
    this.#readThroughSeq = Math.max(this.#readThroughSeq, last)
    return this.#serial(async () => {
      await this.#writeState()
      return this.#readThroughSeq
    })
  }

  clear(): Promise<void> {
    this.#records = []
    this.#readThroughSeq = this.#nextSeq - 1
    return this.#serial(() => this.#compact())
  }

  setRetention(max: number): Promise<number> {
    this.#retention = clampRetention(max)
    const trimmed = this.#trimToRetention()
    return this.#serial(async () => {
      if (trimmed > 0 || this.#onDisk > this.#records.length) await this.#compact()
      return this.#retention
    })
  }

  /** Write the full history as a JSON array (oldest first). */
  exportTo(path: string): Promise<number> {
    const snapshot = this.#records.map((r) => this.#decorate(r))
    return this.#serial(async () => {
      await atomicWrite(path, JSON.stringify(snapshot, null, 2) + "\n")
      return snapshot.length
    })
  }

  /** Merge a JSON array (or JSONL) export into the history; returns records imported. */
  async importFrom(path: string): Promise<{ imported: number; skipped: number }> {
    const text = await Deno.readTextFile(path)
    let rows: unknown[] = []
    try {
      const parsed = JSON.parse(text)
      rows = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      rows = text.split("\n").filter((l) => l.trim() !== "").map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
    }
    const known = new Set(this.#records.map((r) => r.id))
    const incoming: StoredNotification[] = []
    let skipped = 0
    for (const row of rows) {
      const rec = row && typeof row === "object" ? parseRecord(JSON.stringify(row)) : null
      if (!rec || known.has(rec.id)) {
        skipped++
        continue
      }
      known.add(rec.id)
      incoming.push(rec)
    }
    if (incoming.length === 0) return { imported: 0, skipped }
    const merged = this.#records.concat(incoming)
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.seq - b.seq)
    // Renumber so seq order matches time order; imported history counts as read.
    const unreadIds = new Set(this.#records.filter((r) => r.seq > this.#readThroughSeq).map((r) => r.id))
    let seq = 0
    let readThrough = 0
    for (const r of merged) {
      r.seq = ++seq
      if (!unreadIds.has(r.id)) readThrough = r.seq
    }
    this.#records = merged
    this.#nextSeq = seq + 1
    this.#readThroughSeq = readThrough
    this.#trimToRetention()
    await this.#serial(() => this.#compact())
    return { imported: incoming.length, skipped }
  }

  /** Wait for queued writes (used by tests and shutdown). */
  flush(): Promise<unknown> {
    return this.#serial(() => Promise.resolve())
  }

  #decorate(r: StoredNotification): Notification {
    return { ...r, read: r.seq <= this.#readThroughSeq }
  }

  #trimToRetention(): number {
    const excess = this.#records.length - this.#retention
    if (excess <= 0) return 0
    this.#records.splice(0, excess)
    return excess
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn)
    this.#queue = next.catch(() => {})
    return next
  }

  async #compact(): Promise<void> {
    const body = this.#records.map((r) => JSON.stringify(r)).join("\n")
    await atomicWrite(this.file, body.length > 0 ? body + "\n" : "")
    this.#onDisk = this.#records.length
    await this.#writeState()
  }

  #writeState(): Promise<void> {
    return atomicWrite(this.stateFile, JSON.stringify({ version: 1, nextSeq: this.#nextSeq, readThroughSeq: this.#readThroughSeq }) + "\n")
  }
}

function clampRetention(value: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RETENTION
  return Math.min(MAX_RETENTION, n)
}

function compactionSlack(retention: number): number {
  return Math.max(20, Math.floor(retention / 10))
}

/** Index of the first record whose seq >= target (records are sorted by seq). */
function lowerBound(records: StoredNotification[], target: number): number {
  let lo = 0, hi = records.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (records[mid].seq < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? bounded(value, max) : ""
}

function sanitizeInput(input: NotificationInput): NotificationInput {
  return {
    brokerId: str(input.brokerId, 128),
    broker: str(input.broker, 256),
    subscriptionId: str(input.subscriptionId, 128),
    topic: str(input.topic, LIMITS.topicChars),
    text: str(input.text, LIMITS.textChars),
    icon: validateIcon(input.icon),
    link: validateLink(input.link),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Parse one history line; null when it is not a usable record. */
export function parseRecord(line: string): StoredNotification | null {
  if (line.length > 64 * 1024) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string" || !UUID_RE.test(r.id)) return null
  if (typeof r.timestamp !== "string" || Number.isNaN(Date.parse(r.timestamp))) return null
  if (typeof r.text !== "string" || r.text.length === 0) return null
  return {
    seq: Number.isSafeInteger(r.seq) && (r.seq as number) > 0 ? r.seq as number : 0,
    id: r.id.toLowerCase(),
    timestamp: new Date(r.timestamp).toISOString(),
    ...sanitizeInput({
      brokerId: r.brokerId as string,
      broker: r.broker as string,
      subscriptionId: r.subscriptionId as string,
      topic: r.topic as string,
      text: r.text,
      icon: r.icon as Icon,
      link: r.link as string,
    }),
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(path))
  } catch {
    return null
  }
}

/** Write to a temp file in the same directory, then rename over the target. */
export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = path + ".tmp-" + crypto.randomUUID().slice(0, 8)
  try {
    await Deno.writeTextFile(tmp, data, { mode: 0o600 })
    await Deno.rename(tmp, path)
  } catch (e) {
    try {
      await Deno.remove(tmp)
    } catch { /* already gone */ }
    throw e
  }
}
