# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MQTT Notifier is a third-party plugin for the **Omarchy 4.5 shell** (Quickshell 0.3 / Qt 6.12 QML): a bar bell with an unread count, a history panel, and desktop notifications fed by MQTT. User-facing docs are in `README.md`, the helper protocol in `docs/ipc.md`, and parser semantics in `docs/parser.md`.

## Commands

```bash
cd helper && deno task test          # all tests: unit, store, sandbox, QML-lib, end-to-end (~5 s)
cd helper && deno test --allow-read --allow-write --allow-net --allow-run --allow-env --allow-sys \
  ../tests/store.test.ts --filter retention                # one file / one test
cd helper && deno task check         # type-check the helper
cd helper && deno task lint && deno task fmt
omarchy plugin validate .            # manifest/schema check (also run by install.sh)
scripts/install.sh                   # copy into ~/.config/omarchy/plugins/odach.mqtt-notifier + restart shell
scripts/install.sh --watch           # same on every save (inotifywait)
```

Live manual testing (no broker is installed system-wide):

```bash
deno run --allow-net --allow-env --allow-read --allow-sys tests/tools/broker.ts 18830 &   # aedes dev broker
deno run --allow-net --allow-env --allow-read --allow-sys tests/tools/publish.ts --port 18830 test/x "hello"
omarchy-shell shell summon odach.mqtt-notifier '{"section":"subscriptions","edit":"dev/climate"}'   # settings window, deep-linked
omarchy-shell notifications act                  # "click" the newest desktop notification
```

Point a broker in `~/.config/omarchy/mqtt-notifier/config.json` at `127.0.0.1:18830`; the helper reloads the file on save. `wtype -k Down` drives the panel's keyboard navigation and `grim -o <output>` takes screenshots. These touch the user's real desktop, so restore their config afterwards.

## Architecture

Three processes, each with less privilege than the one before:

1. **QML, inside `omarchy-shell`.** `manifest.json` declares `kinds: ["service", "bar-widget", "panel"]` with `keepLoaded: true`.
   - `Service.qml` is a single, parentless, long-lived object. It owns the helper `Process`, holds all state (`brokers`, `unread`, `total`, the `items` ListModel), and exposes the functions the widgets call. Settings come from the widget's inline entry in `shell.json` (`shell.barConfig` → `Format.findEntrySettings`), and the manifest `barWidget.schema` describes them.
   - `BarWidget.qml` (`qs.Ui.Panel`, one instance per bar/screen) is a view. It finds the service with `bar.shell.serviceFor(id)`, polled until it appears, and renders a `BarIconButton` plus a `KeyboardPanel` built from `components/`.
   - `Settings.qml` (the `panel` entry point) is a `FloatingWindow` the shell loads on `summon` and destroys on `hide`. The loader injects `service`. Pages live in `components/settings/` and get the window root as `app`. They read `app.cfg` (helper `getConfig`) and write whole broker lists through `app.saveBrokers()` (helper `saveConfig`); widget settings go through `service.updateSetting()` into `shell.json`. Deep links: summon payload `{"section", "edit"}`.
   - `lib/format.mjs` holds pure logic as an ES module shared by QML and the Deno tests. Keep Qt APIs out of it.
2. **Deno helper** (`helper/main.ts`, started via `helper/start.sh`). It speaks NDJSON over stdin/stdout (`docs/ipc.md`) and is the single writer of history.
   - `mqtt_manager.ts`: one connection per broker, with its own exponential backoff (mqtt.js `reconnectPeriod: 0`). For MQTT 5 it maps subscription identifiers back to filters.
   - `processor.ts`: matches every enabled subscription and creates one notification per match, in order. Parser failures fall back to the raw payload with `ICON_ERROR`.
   - `store.ts`: JSONL history plus `state.json`. Read state is a cursor (`seq <= readThroughSeq`). Paging uses a `beforeSeq` cursor, not offsets.
   - `config.ts`: normalizes config, resolves `parserFile` and certificate paths inside their directories (`resolveInside`), and computes `connectionKey` (a reload reconnects a broker only when this changes).
   - `notifier.ts`: `notify-send --wait -A default=Open`. A click becomes an `activate` event, which calls `shell.summon`.
3. **Parser worker** (`helper/worker/worker.js` + `xml.js`). `parser.ts` runs it inside `bwrap --unshare-all` with `deno run` and no `--allow-*` flags, kills it on timeout, and respawns it after OOM. The worker deletes `Deno`, `fetch`, timers and Node globals and freezes `globalThis` and the intrinsics, so scripts can't leak state to each other. It must stay dependency-free: inside bwrap there is no network and only an empty Deno cache.

`helper/start.sh` is the single source of the helper's permissions and environment. The environment is cleared on purpose: `--allow-env` is required only because mqtt.js's `debug` dependency enumerates `process.env`. The helper runs `--cached-only --frozen`, so a new or changed dependency needs `deno install --frozen=false` plus a lockfile update, and `install.sh` caches dependencies before copying.

## Omarchy shell behaviours that matter here (verified on 4.5.0)

- **Hot reload doesn't apply all code changes.** `keepLoaded` services survive plugin reloads, and the engine keeps cached QML components and `.mjs` modules. After changing QML or JS, run `scripts/install.sh` (it runs `omarchy restart shell`), or the shell keeps running stale code. Data files (`config.json`, `parsers/`) reload live.
- **Plugin folders can't contain symlinks** (`omarchy plugin validate` rejects them), hence the copy-based install.
- **Third-party plugins can't register IPC targets.** A `ShellIpc` in plugin QML never shows up in `qs ipc show`. Use `omarchy-shell shell summon <id>` to open the panel.
- **Plugin `console.log` output doesn't reach the shell log** (`qs log …/log.qslog`). Debug through the helper log (`~/.local/state/omarchy/mqtt-notifier/logs/helper.log`) or show values in the UI temporarily.
- `omarchy-shell shell rescanPlugins` freezes the shell for about 2 s (with or without this plugin), and IPC calls then answer "omarchy-shell is not responding". Retry after a moment.
- **Adding a `panel` kind reroutes `shell.summon(<id>)`** from the bar widget to the panel loader. So a desktop-notification click opens the bell through `service.panelRequested()`: each widget compares its screen with `Hyprland.focusedMonitor`.
- **Quickshell `FloatingWindow`s tile, and Hyprland title rules don't match them at map time.** `Settings.qml` floats itself with `hyprctl dispatch 'hl.dsp.window.float({...window = "address:0x…"})'`. Hyprland here uses the Lua config, so old `hyprctl dispatch setfloating …` syntax fails, and `title:` window selectors don't work; use the address.
- `PanelKeyCatcher` owns `Keys.onPressed`. Hand keys to overlays (`ConfirmDialog`) via `blocked` + `focus` instead of a second handler.

## Rules for changes

- Never edit `/usr/share/omarchy/` (read it for reference: `shell/Ui/`, `shell/Commons/`, `shell/plugins/panels/*`).
- Show every MQTT-derived string through `components/PlainText.qml` (`Text.PlainText`), never `Text.AutoText`. Links must pass `validateLink` (helper) and `Format.safeLink` (QML).
- User-visible strings go in `i18n/en.json` and are read with `strings.t()` / `strings.tn()` inside bindings. Logs stay in English. Durations use `Style.duration()`.
- Integration tests launch the real helper through `start.sh` with `--no-desktop-notifications`. Keep that flag so test runs don't spam the desktop.
- The spec in the original request (multi-broker MQTT, JS parsers, JSONL history) is the product requirement. Deliberate deviations: the popup is an Omarchy `KeyboardPanel` anchored to the icon rather than pinned to the screen's right edge; read state is a cursor rather than per-line flags; files live in `~/.config/omarchy/mqtt-notifier` and `~/.local/state/omarchy/mqtt-notifier`; `ignoreRetained` defaults to true.
- Not built: syntax highlighting in the parser editor (would need a C++ `QSyntaxHighlighter`). Settings buttons set `focusable: true` and text areas must never trap Tab, so keep both when adding controls. `/usr/lib/qt6/bin/qmllint -I <dir containing qs -> /usr/share/omarchy/shell>` catches misspelled properties; `/usr/bin/qmllint` is the Qt 5 one and useless here.
