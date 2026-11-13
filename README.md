# MQTT Notifier for Omarchy

A bar widget for the Omarchy 4.5 shell that turns MQTT messages into notifications:

- Connects to any number of brokers and topic subscriptions (MQTT 3.1.1 or 5.0, TCP or TLS).
- Optional JavaScript parser per subscription that turns the payload into text, an icon and a link. Parsers run in a sandbox.
- Bar icon with an unread count, and a red-tinted (theme `urgent`) warning when a broker is unreachable.
- Panel with notification history, paging ("More"), clickable links and Clear All.
- Desktop notifications through Omarchy's notification daemon. A link shows as an "Open <host>" line under the text, as in the panel. Clicking a notification opens its link, or the panel when it has none.
- History is kept in a JSON Lines file and survives shell restarts.

## Install

Requires Omarchy 4.5 and `git`. Clone the repository anywhere and run the installer from it:

```bash
git clone https://github.com/odaszek/omarchy-mqtt-notifier.git
cd omarchy-mqtt-notifier
scripts/install.sh
```

To update later: `git pull && scripts/install.sh` in the same folder.

The script:

1. checks for `deno` (it offers `sudo pacman -S deno` if missing);
2. caches the pinned npm dependency (`mqtt`);
3. copies the plugin to `~/.config/omarchy/plugins/odach.mqtt-notifier` (Omarchy doesn't allow symlinked plugins);
4. adds the bell to the right side of the bar.

Running it again updates the plugin and restarts the shell (`omarchy restart shell`). The restart is needed because the shell caches compiled QML and keeps the MQTT service loaded across plugin reloads.

Uninstall with `scripts/uninstall.sh`. Add `--purge` to also delete config, history, logs and keyring secrets.

## Settings window

The gear button in the panel opens a floating settings window. Esc closes it from anywhere (cancelling an open confirmation first; unsaved editor changes are discarded). A mouse click outside the window closes it too (just moving the pointer away doesn't), unless an editor has unsaved changes:

- **General:** panel size, page sizes, desktop notifications, unread counter, mark-read-on-open (written to `shell.json`).
- **Brokers:** add, edit, delete and enable brokers, with live connection status (green connected, yellow connecting, red unreachable, grey disabled) and **Test connection** for unsaved changes. Passwords go straight to the keyring.
- **Subscriptions:** grouped by broker, each with a parser editor (Tab indents, Ctrl+Tab leaves the editor, long lines wrap, **Format** puts one statement per line and re-indents) and a **Test parser** bench that runs your script in the same sandbox as live messages without storing anything.
- **Storage:** history size, clear, export to JSON, import an export.
- **About:** version, helper and sandbox status, file locations.

From scripts: `omarchy-shell shell summon odach.mqtt-notifier '{"section":"brokers"}'`. Add `"edit":"<brokerId>"`, `"edit":"new"` (Brokers) or `"edit":"<brokerId>/<subId>"` / `"<brokerId>/new"` (Subscriptions) to open an editor directly.

## Configure brokers by hand

Everything in the settings window is stored in `~/.config/omarchy/mqtt-notifier/config.json` (created on first start with a disabled example). You can edit it directly; the helper reloads it on save and the settings window refreshes. Saving from the window keeps keys it doesn't manage (such as `advanced`), and refuses to overwrite a file with a JSON syntax error.

```json
{
  "version": 1,
  "brokers": [
    {
      "id": "home",
      "name": "HomeMQTT",
      "host": "192.168.1.10",
      "port": 1883,
      "protocol": "mqtt",
      "mqttVersion": 4,
      "clientId": "omarchy-notifications",
      "username": "omarchy",
      "enabled": true,
      "subscriptions": [
        { "id": "garage", "topic": "home/garage/#", "qos": 1, "description": "Garage",
          "parserScript": "msgout = 'ALERT: ' + msgin; msgicon = ICON_WARN" },
        { "id": "climate", "topic": "sensors/+/climate", "parserFile": "climate.js" }
      ]
    }
  ]
}
```

| Broker field | Default | Notes |
|---|---|---|
| `id` | required | Letters, digits, `.`, `_`, `-` (max 64). Keyring secrets are stored under this id. |
| `name` | `id` | Shown in the panel and in notification titles. |
| `host`, `port` | –, 1883 / 8883 | Hostname, IPv4 or IPv6. |
| `protocol` | `mqtt` | `mqtt` (TCP) or `mqtts` (TLS). |
| `mqttVersion` | `4` | `4` = MQTT 3.1.1, `5` = MQTT 5.0. |
| `clientId` | `omarchy-mqtt-<id>` | |
| `username` | empty | Its password comes from the keyring (see below). |
| `keepAlive` | 60 | Seconds. |
| `cleanSession` | `true` | |
| `connectTimeout` | 10 | Seconds. |
| `reconnectInterval`, `maxReconnectInterval` | 2, 60 | Exponential backoff with ±20% jitter, reset after a successful connection. |
| `tls.rejectUnauthorized` | `true` | Certificate validation. |
| `tls.ca`, `tls.cert`, `tls.key` | none | File names inside `~/.config/omarchy/mqtt-notifier/certs/`. |
| `enabled` | `true` | A disabled broker is not connected. |

| Subscription field | Default | Notes |
|---|---|---|
| `id` | `sub-N` | |
| `topic` | required | Filter with `+` and `#` wildcards. |
| `qos` | 0 | 0, 1 or 2. |
| `parserScript` | empty | Inline JavaScript. Empty means the payload text is used as-is. |
| `parserFile` | none | A file in `~/.config/omarchy/mqtt-notifier/parsers/`. Overrides `parserScript`. |
| `description` | empty | Shown in the notification title. |
| `ignoreRetained` | `true` | Skips the retained messages a broker replays on every (re)subscribe. |
| `enabled` | `true` | |

Every enabled subscription that matches a message creates its own notification, so overlapping filters produce one notification each. With MQTT 5 the helper uses subscription identifiers to tell the deliveries apart.

### Passwords and private keys

Secrets never go in `config.json`. Store them in the Secret Service keyring (GNOME Keyring ships with Omarchy):

```bash
secret-tool store --label="MQTT home password" service omarchy-mqtt-notifier broker home field password
secret-tool store --label="MQTT home key passphrase" service omarchy-mqtt-notifier broker home field keyPassphrase
```

If no keyring is available, set `"advanced": { "secretStore": "file" }`. Secrets are then read from `~/.local/state/omarchy/mqtt-notifier/secrets.json`, a JSON object `{ "<brokerId>": { "password": "…" } }` that the helper keeps at mode 0600.

### Advanced options

```json
"advanced": { "parserTimeoutMs": 250, "parserMemoryMb": 64, "maxPayloadBytes": 262144, "sandbox": "auto", "secretStore": "keyring" }
```

## Parsers

See [docs/parser.md](docs/parser.md). In short, the script reads `msgin` (the payload as UTF-8 text) and sets `msgout` (text), `msgicon` (`ICON_NOTIFY`, `ICON_QUESTION`, `ICON_WARN`, `ICON_ERROR`, `ICON_OK` or `null`) and `msglink` (an http(s) URL or `null`). `return false` ignores the message; any other ending keeps it. `parseXml(text)` and `to_string(value)` are available.

## Widget settings

These live in the widget's own entry in `~/.config/omarchy/shell.json` and are described by the manifest schema:

| Key | Default |
|---|---|
| `initialMessageCount` | 10 |
| `loadMoreCount` | 10 |
| `maxStoredMessages` | 1000 (applied immediately) |
| `popupWidth`, `popupMaxHeight` | 380, 600 |
| `desktopNotifications` | `true` |
| `showUnreadCounter` | `true` |
| `markReadOnOpen` | `true` |

Example: `omarchy bar set odach.mqtt-notifier maxStoredMessages 5000 --json`

## Using it

- **Left- or right-click** the bell to open or close the panel. **Middle-click** reconnects all brokers now.
- **Keyboard:** ↑/↓ (or k/j) select a row; going past the last row loads more. Enter or Space opens the selected link. `x` or Delete starts Clear All. Esc closes. Tab moves to the neighbouring panel.
- **From scripts:** `omarchy-shell shell summon odach.mqtt-notifier` opens the settings window (see above). Clicking a desktop notification without a link opens the bell panel on the focused screen.
- The panel's warning block lists enabled brokers that are currently unreachable; it clears as soon as they reconnect. Disabled brokers are never reported. Other helper warnings (a failing parser, for example) show in the footer for 10 minutes.
- Opening the panel marks everything already received as read. Messages that arrive while it's open stay unread.

## Files

| Path | Contents |
|---|---|
| `~/.config/omarchy/mqtt-notifier/config.json` | Brokers, subscriptions, advanced options |
| `~/.config/omarchy/mqtt-notifier/parsers/`, `certs/` | Parser files and TLS material |
| `~/.local/state/omarchy/mqtt-notifier/notifications.jsonl` | History, one notification per line |
| `~/.local/state/omarchy/mqtt-notifier/state.json` | Sequence counter and read cursor |
| `~/.local/state/omarchy/mqtt-notifier/logs/helper.log` | Diagnostics (rotated at 1 MiB) |

## Security model

- **Parser scripts** run in a separate Deno process with no permissions (no file, network, environment or subprocess access). It runs inside a bubblewrap namespace with no network and a read-only `/usr`, has a 64 MB heap limit and a 250 ms wall-clock limit, and its global object and built-ins are frozen so one script can't affect the next. A crash or timeout costs one fallback notification and the worker restarts.
- **The helper** runs with a cleared environment and explicit Deno permissions: read access to its code and its config/state directories, write access to those directories, network access, and permission to run `secret-tool`, `notify-send`, `bwrap` and `deno`.
- **Untrusted text** (payloads, topics, broker names) is shown only as plain text, so markup in a payload is never rendered. Desktop notification bodies are markup-escaped. Links must be absolute `http(s)` URLs without credentials; they are checked in the helper and again in the panel before opening.
- **Limits:** payloads over 256 KiB become an error notification; notification text is capped at 4 KiB and links at 2 KiB.

## Development

See [CLAUDE.md](CLAUDE.md) for the architecture and commands. Quick reference:

```bash
cd helper && deno task test     # unit, sandbox and end-to-end tests (in-process MQTT brokers)
cd helper && deno task check    # type-check the helper
scripts/install.sh --watch      # copy + restart the shell on every save
```

Further docs: [dependencies](docs/dependencies.md), [troubleshooting](docs/troubleshooting.md), [helper IPC protocol](docs/ipc.md).

## Status

| Done | Not done yet |
|---|---|
| Bar widget, panel, MQTT service, sandboxed parsers, JSONL history, desktop notifications, settings window (general, brokers, subscriptions with parser editor and test, storage, about), install/uninstall scripts, tests | Syntax highlighting in the parser editor (QML has no built-in highlighter; it would need a C++ helper). Importing files from outside the `exports/` folder. |

This has only been tested on Omarchy 4.5.0 (Quickshell 0.3.2, Qt 6.12, Deno 2.9.8).

## License

[MIT](LICENSE): you may use, copy, modify and share it, including in your own projects, as long as the copyright and license notice stay with it.
