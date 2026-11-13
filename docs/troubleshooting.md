# Troubleshooting

## Where to look

| What | Where |
|---|---|
| Helper diagnostics (connections, parser errors, config problems) | `~/.local/state/omarchy/mqtt-notifier/logs/helper.log` |
| Problems the panel shows | The red block at the top: unreachable brokers, config errors, helper errors |
| QML load errors | `qs log /run/user/$UID/quickshell/by-pid/$(pgrep -f 'quickshell -n -p /usr/share/omarchy/shell')/log.qslog` |
| Is the helper running? | `ps -eo pid,etimes,args \| awk '$3 ~ /deno$/ && /mqtt-notifier\/helper\/main.ts/'` |

Output from the plugin's own `console.log` doesn't appear in the shell log. Use the helper log, or show values in the UI temporarily while debugging.

## Common problems

**The bell doesn't appear.** Check that the plugin is in the bar layout (`omarchy plugin list`, then `omarchy plugin enable odach.mqtt-notifier --section right`). Then run `omarchy plugin validate ~/.config/omarchy/plugins/odach.mqtt-notifier`.

**The panel says "Deno is not installed".** Run `sudo pacman -S deno`, then `omarchy restart shell`.

**The panel says "Could not download the MQTT library".** The first start fetches the `mqtt` npm package. The helper retries on its own (up to once a minute) once the network is up. Details are in `~/.local/state/omarchy/mqtt-notifier/logs/dependencies.log`.

**The helper keeps restarting.** Look at the end of `helper.log`. The helper runs with `--cached-only`; `start.sh` fetches missing dependencies before starting it, so a cleared `~/.cache/deno` is refilled on the next start.

**A broker shows "bad username or password".** The password comes from the keyring, not `config.json`. Check it with `secret-tool lookup service omarchy-mqtt-notifier broker <id> field password`. A keyring that stays locked after login also causes this.

**Retained messages show up after every restart.** They shouldn't while `ignoreRetained` is `true` (the default). If you set it to `false` for a subscription, every reconnect replays that topic's retained message.

**One message creates two notifications.** That's intended when two enabled subscriptions match the same topic (for example `home/#` and `home/garage/+`): each subscription produces its own notification. Disable or narrow one of them.

**Duplicate notifications with MQTT 3.1.1 and overlapping filters.** Some brokers send one copy per matching subscription, and with 3.1.1 the client can't tell the copies apart. Use `"mqttVersion": 5`, which identifies each delivery's subscription.

**`omarchy-shell shell summon odach.mqtt-notifier` opens settings, not the bell panel.** That's intended: a plugin with a settings window ("panel" entry point) has `summon` routed to that window. Click the bell, or a desktop notification, to open the panel.

**The settings window opens tiled.** It floats itself right after opening with `hyprctl` (a title-based window rule doesn't match Quickshell windows at map time). If `hyprctl` or `jq` is missing it stays tiled; float it with your usual key.

**Parser changes don't apply.** The helper reloads `config.json` and `parsers/*.js` when they're saved. Check the log for `config:` problems; a file outside `parsers/` is refused.

**Edits to the plugin code don't show up.** The shell caches compiled QML and JS and keeps the MQTT service loaded across plugin reloads. Run `omarchy restart shell` (after `omarchy plugin update`), or `scripts/install.sh` from a clone (it restarts the shell).

**"bubblewrap unavailable" in the log.** User namespaces are probably disabled. Parsers still run with Deno's permission sandbox; set `"advanced": {"sandbox": "deno"}` to silence the probe, or `"bwrap"` to refuse to run without it.

**The panel's warning colour isn't red.** It uses the theme's `urgent` colour (the theme's `red`/`color1`). Monochrome themes define that as a grey.

## Resetting

- Clear the history: Clear All in the panel, or delete `~/.local/state/omarchy/mqtt-notifier/notifications.jsonl` and `state.json` while the shell is stopped.
- Start the configuration over: delete `~/.config/omarchy/mqtt-notifier/config.json`. A disabled example is recreated on the next start.
- Remove everything: `omarchy plugin remove odach.mqtt-notifier`, then delete `~/.config/omarchy/mqtt-notifier` and `~/.local/state/omarchy/mqtt-notifier` (or `scripts/uninstall.sh --purge` from a clone).
