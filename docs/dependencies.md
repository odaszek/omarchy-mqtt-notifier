# Dependencies

| Dependency | Package | Why | Present on a stock Omarchy 4.5? |
|---|---|---|---|
| Omarchy shell | `omarchy` 4.5 | Hosts the plugin (Quickshell 0.3, Qt 6.12) | yes |
| Deno ≥ 2.4 | `deno` | Runs the helper (MQTT, storage) and the parser worker | not guaranteed: `sudo pacman -S deno` (`scripts/install.sh` offers it) |
| mqtt.js 5.16.1 | npm, pinned in `helper/deno.json` + `deno.lock` | MQTT 3.1.1/5.0 client with TLS support | downloaded into Deno's cache by the install script |
| bubblewrap | `bubblewrap` | Namespace sandbox around parser scripts | yes (system dependency) |
| libsecret | `libsecret` (`secret-tool`) | Reads broker secrets from the keyring | yes |
| GNOME Keyring | `gnome-keyring` | Secret Service provider | yes (omarchy dependency) |
| libnotify | `libnotify` (`notify-send`) | Desktop notifications with a click action | yes |

Only for the tests: `npm:aedes@0.51.3` (an in-process MQTT broker) and `jsr:@std/assert`. Deno fetches both on the first test run.

## Why a helper process

QML in Quickshell has no TCP sockets, and none of Qt MQTT, mosquitto or paho-mqtt ships with Omarchy, so MQTT has to run in a separate process. Deno does both jobs with one runtime: it runs mqtt.js for the connections, and its deny-by-default permissions plus V8 heap limits make it a good base for the parser sandbox. Everything else the plugin needs (process, file and JSON handling) comes from Quickshell's `Quickshell.Io`.

## Offline operation

The helper runs with `--cached-only --frozen`, so it never downloads code while running. Before starting it, `helper/start.sh` checks the cache offline and, only if something is missing (first start after `omarchy plugin add`, or a cleared `~/.cache/deno`), runs `deno install --frozen`, which fetches exactly the versions and checksums in `helper/deno.lock`.
