# Helper IPC protocol

`Service.qml` starts `helper/start.sh CONFIG_DIR STATE_DIR [--max-stored N] [--no-desktop-notifications] [--verbose]` and talks to it with newline-delimited JSON over stdin/stdout. One JSON object per line, at most 1 MiB per request line. stderr carries human-readable logs only.

## Requests (QML → helper)

`{"id": <number>, "op": "<name>", ...params}`. Every request gets exactly one reply: `{"id": n, "ok": true, "result": …}` or `{"id": n, "ok": false, "error": "…"}`. Requests run concurrently; the store applies its writes in order.

| op | params | result |
|---|---|---|
| `settings` | `settings: {maxStoredMessages?, desktopNotifications?, linkLabel?, suppressedLabel?}` (`linkLabel`: the desktop notification's link text, `%1` = host; `suppressedLabel`: the summary popup shown after rate-limited popups, `%1` = count) | `{retention, desktopNotifications}`. A smaller retention is applied immediately. |
| `page` | `limit`, `beforeSeq?` | `{items, hasMore, total, unread}`, newest first. `beforeSeq` is the `seq` of the last item already shown. |
| `markAllRead` | – | `{readThroughSeq}` |
| `clear` | – | `{total: 0}` |
| `status` | – | `{brokers: BrokerStatus[]}` |
| `stats` | – | `{version, total, unread, retention, sandbox, configPath, statePath, problems, configError}` |
| `reload` | – | Re-read `config.json` now. |
| `reconnect` | – | Reconnect every enabled broker that isn't connected. |
| `testParser` | `script`, `input` | `{text, icon, link, fallback, dropped, error, warnings, logs}`. `dropped` is true when the script returned `false`. Nothing is stored. |
| `testConnection` | `brokerId`, or `broker` (an unsaved draft) + optional `password` | `{ok, error, ms}`, using a separate client id. A draft password is used for this test only. |
| `getConfig` | – | `{path, error, problems, brokers, secrets: {<id>: {password, keyPassphrase}}, secretStore, parserFiles: {<file>: text}, certs: [names]}`. Secrets are reported as present/absent only. |
| `saveConfig` | `brokers`, `parserFiles?` | `{saved, errors: [{path, message}], problems}`. Validates, writes `config.json` atomically (keeping other top-level keys), writes `parsers/<file>`, clears keyring secrets of removed brokers, reloads. |
| `listExports` | – | `{dir, files}`, newest first |
| `export` | – | `{path, count}`, written to `STATE_DIR/exports/`. |
| `import` | `path` (inside `STATE_DIR/exports/`) | `{imported, skipped}` |
| `setSecret` | `brokerId`, `field` (`password`/`keyPassphrase`), `value` | `{}` |
| `clearSecret` | `brokerId`, `field` | `{}` |

## Events (helper → QML)

| event | fields |
|---|---|
| `ready` | `version, configPath, statePath` |
| `config` | `path, error, problems[], sandbox` |
| `brokers` | `brokers: [{id, name, enabled, state, error, retryIn, subscriptions}]`. `state` is `disabled`, `connecting`, `connected`, `disconnected` or `error`. Bursts are coalesced (50 ms). |
| `notification` | `notification: {seq, id, timestamp, brokerId, broker, subscriptionId, topic, text, icon, link, read}` |
| `counts` | `total, unread` |
| `activate` | `id`: a desktop notification without a link was clicked (open the panel); `""` for the rate-limit summary popup |
| `openLink` | `id, url`: a desktop notification with a link was clicked. The panel re-checks the URL before opening it. |
| `log` | `level` (`warn`/`error`), `message`. Broker connection messages are not sent here; the `brokers` event carries that state. |
| `fatal` | `error`: the helper is about to exit (deno missing, another instance holds the lock) |

## Storage format

`notifications.jsonl` holds one notification per line, oldest first, without the `read` field. A record counts as read when `seq <= readThroughSeq` in `state.json`, so marking everything read rewrites only `state.json`, never the history. Retention trims the oldest records. The file is compacted (temp file + rename) once it holds 10% more lines than the retention limit (at least 20 more). Lines that can't be parsed are skipped when loading, and the file is rewritten without them.
