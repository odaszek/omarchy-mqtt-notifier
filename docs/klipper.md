# Recipe: 3D printer notifications from Klipper

Klipper's API server, Moonraker, can publish to an MQTT broker. Point it at the same broker as the MQTT Notifier and you get a desktop notification when a print starts, finishes, is paused, resumed or cancelled, or when the hot end is up to temperature. Clicking the notification opens the printer's Mainsail or Fluidd page.

This uses only Moonraker's built-in MQTT support and a parser script; the notifier itself needs no changes.

```
Klipper macro ──▶ Moonraker [mqtt] ──▶ broker ──▶ MQTT Notifier ──▶ bell + desktop notification
```

## Requirements

- Klipper with Moonraker (any recent version with the `[mqtt]` component).
- An MQTT broker the printers can reach.
- The MQTT Notifier installed and connected to that broker.

## 1. Connect Moonraker to the broker

Add to each printer's `moonraker.conf`, then restart Moonraker:

```ini
[mqtt]
address: 172.20.20.60   # your broker, as the printer reaches it
port: 1883
# username: printers    # if the broker requires a login
# password: secret
instance_name: voron    # a unique name per printer
```

The broker address is the one the *printer* uses. It may differ from the one your desktop uses (different network or interface); the notifier only needs to reach the same broker.

## 2. Send events from your macros

Moonraker lets a Klipper macro publish any message with the remote method `publish_mqtt_topic`. Add this helper macro to `printer.cfg`, and set `variable_printer_name` to the printer's name:

```ini
[gcode_macro NOTIFY]
description: Send a desktop notification through MQTT
variable_printer_name: "voron"
gcode:
  {% set data = {
      "printer": printer_name,
      "level": params.LEVEL|default("info")|lower,
      "text": params.MSG|default("Event"),
      "file": printer.print_stats.filename
  } %}
  {action_call_remote_method("publish_mqtt_topic",
                             topic="printers/" ~ printer_name ~ "/events",
                             payload=data,
                             qos=1,
                             retain=False)}
```

`LEVEL` is `info`, `ok`, `warn` or `error` and picks the icon. Each printer publishes to `printers/<name>/events`, so a single subscription to `printers/+/events` covers all of them.

Then call it from the macros you already have:

```ini
[gcode_macro START_PRINT]
gcode:
  # ... your heating and homing ...
  NOTIFY MSG="Print started" LEVEL=info

[gcode_macro END_PRINT]
gcode:
  # ... your end gcode ...
  NOTIFY MSG="Print finished" LEVEL=ok
```

Optional, after `M109` in `START_PRINT`, when the hot end has reached its target:

```ini
  NOTIFY MSG="Hot end at {printer.extruder.target|int} C" LEVEL=info
```

### Pause, resume and cancel

`PAUSE`, `RESUME` and `CANCEL_PRINT` usually come from `mainsail.cfg` or Fluidd's `client.cfg`, which you shouldn't edit. Both read hook variables from `_CLIENT_VARIABLE`. Point the hooks at small macros (keep any `_CLIENT_VARIABLE` section you already have and only add these lines):

```ini
[gcode_macro _CLIENT_VARIABLE]
variable_user_pause_macro: "_NOTIFY_PAUSE"
variable_user_resume_macro: "_NOTIFY_RESUME"
variable_user_cancel_macro: "_NOTIFY_CANCEL"
gcode:

[gcode_macro _NOTIFY_PAUSE]
gcode:
  NOTIFY MSG="Paused" LEVEL=warn

[gcode_macro _NOTIFY_RESUME]
gcode:
  NOTIFY MSG="Resumed" LEVEL=info

[gcode_macro _NOTIFY_CANCEL]
gcode:
  NOTIFY MSG="Print cancelled" LEVEL=warn
```

Check that your `mainsail.cfg` / `client.cfg` version supports these hooks (search it for `user_pause_macro`). The hooks came with mainsail-config 2.x, which Moonraker keeps updated in `~/mainsail-config/` and links into your config folder.

Older setups have a `mainsail.cfg` version 1.x: a plain file in your config folder that nothing updates, with no hooks. Add the `NOTIFY` line to its macros directly, right after the `*_BASE` call (if the base command fails, for example `RESUME` when nothing is paused, the notification is skipped). Indent each new line with spaces, like the lines around it (see the note below):

```ini
[gcode_macro CANCEL_PRINT]
gcode:
  # ... park, heaters off, fan off ...
  CANCEL_PRINT_BASE
  NOTIFY MSG="Print cancelled" LEVEL=warn

[gcode_macro PAUSE]
gcode:
  PAUSE_BASE
  NOTIFY MSG="Paused" LEVEL=warn
  _TOOLHEAD_PARK_PAUSE_CANCEL

[gcode_macro RESUME]
gcode:
  # ... re-extrude ...
  RESUME_BASE {get_params}
  NOTIFY MSG="Resumed" LEVEL=info
```

`PAUSE` also runs for pauses you didn't start yourself (a filament runout sensor, `M600`), and `[virtual_sdcard]` in `mainsail.cfg` 1.x has `on_error_gcode: CANCEL_PRINT`, so a print stopped by a file error is reported as "Print cancelled".

> **Indentation matters.** Every line under `gcode:` must start with whitespace (use spaces, not tabs). A line at the start of the row ends the macro, and Klipper reads it as a config option instead, failing to start with an error such as `Option 'notify msg' is not valid in section 'gcode_macro resume'`. This applies to the `NOTIFY` macro itself and to every line you add to existing macros.

A print that fails because Klipper shuts down (thermal runaway, MCU error) never reaches `END_PRINT`. To be told about those too, add the status topic from [the alternative below](#alternative-without-macros-moonraker-status-topics).

## 3. Subscribe in the notifier

In the bell's settings (gear button):

1. **Brokers:** add the broker if it isn't there yet, at the address your desktop uses.
2. **Subscriptions:** add a subscription to that broker:
   - **Topic filter:** `printers/+/events`
   - **Quality of service:** 1
   - **Description:** `3D printers`
3. Paste this parser, and edit the `pages` list to your printers' Mainsail/Fluidd addresses:

```js
var e
try {
  e = JSON.parse(msgin)
} catch (err) {
  // A plain-text payload is shown as it is.
  msgout = msgin
  msgicon = ICON_NOTIFY
  return
}
var icons = { ok: ICON_OK, warn: ICON_WARN, error: ICON_ERROR, info: ICON_NOTIFY }
var pages = {
  voron: "http://voron.local",   // your printers' Mainsail/Fluidd pages
  ender: "http://ender.local"
}
msgout = e.printer + ": " + e.text + (e.file ? " — " + e.file : "")
msgicon = icons[e.level] || ICON_NOTIFY
msglink = pages[e.printer] || null
```

Result, for `NOTIFY MSG="Print finished" LEVEL=ok` during a print of `benchy.gcode` on `voron`:

| | |
|---|---|
| Text | voron: Print finished — benchy.gcode |
| Icon | ICON_OK (check mark) |
| Link | Open voron.local |

Clicking the desktop notification opens the printer's page.

If you'd rather keep it minimal, publish plain text instead of JSON (`payload=params.MSG`) and leave the parser empty: the text is shown as sent.

## Alternative without macros: Moonraker status topics

Moonraker can also publish Klipper's own state whenever it changes. Add to `[mqtt]`:

```ini
publish_split_status: True
status_objects:
  print_stats=state
```

The printer then publishes `voron/klipper/state/print_stats/state` with a payload such as `{"eventtime": 1234.5, "value": "printing"}`. The state is one of `standby`, `printing`, `paused`, `complete`, `cancelled` or `error`.

Add one subscription per printer (topic `voron/klipper/state/print_stats/state`, description `Voron`) with this parser:

```js
var state = JSON.parse(msgin).value
var events = {
  printing:  ["Printing",        ICON_NOTIFY],
  paused:    ["Paused",          ICON_WARN],
  complete:  ["Print finished",  ICON_OK],
  cancelled: ["Print cancelled", ICON_WARN],
  error:     ["Print failed",    ICON_ERROR]
}
if (!events[state]) return false   // standby and anything unknown: no notification
msgout = events[state][0]
msgicon = events[state][1]
msglink = "http://voron.local"
```

Trade-offs compared with the macros:

- It needs no macro changes and also catches `error` (a failed print).
- It can't tell "resumed" from "started": both are `printing`.
- Don't subscribe to temperature topics such as `extruder/temperature` for notifications: they change every few seconds. Use the `NOTIFY` line after `M109` instead.

Both approaches can run side by side; a common setup is macros for start/finish/pause, plus the status topic filtered down to `error` only (`if (state !== "error") return false`).

## Testing

1. In the subscription editor, paste a sample payload and press **Test parser**, for example `{"printer":"voron","level":"ok","text":"Print finished","file":"benchy.gcode"}`.
2. From the printer's console (Mainsail/Fluidd), run `NOTIFY MSG="Test" LEVEL=ok`. The bell should count one more and a desktop notification should appear.
3. To see what the printer actually publishes, watch the broker with an MQTT client such as MQTT Explorer, subscribed to `printers/#` (and `+/klipper/#` for the status topics).

## Troubleshooting

- **Nothing arrives.** Check `moonraker.log` on the printer for MQTT connection errors (wrong address, port or login). Check the broker from the desktop with MQTT Explorer.
- **Klipper won't start: `Option 'notify msg' is not valid in section 'gcode_macro …'`.** A `NOTIFY` line isn't indented, so Klipper reads it as an option. Indent it with spaces like the other lines under `gcode:`, then run `RESTART`. Klipper stops at the first error, so check every line you added.
- **"Unknown remote method publish_mqtt_topic"** in the console: the `[mqtt]` section is missing or Moonraker wasn't restarted.
- **The notification shows raw JSON with an error icon.** The parser failed; use **Test parser** with the same payload to see the error.
- **Old events show up after a restart.** Keep `retain=False` in the macro. The notifier's "Ignore retained messages" (on by default) also skips replays.
- **Every event shows twice.** Two subscriptions match the same topic (for example `printers/#` and `printers/+/events`); each produces its own notification. Remove one.
