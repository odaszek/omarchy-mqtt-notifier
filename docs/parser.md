# Parser scripts

A parser turns one MQTT payload into one notification. Each subscription has its own parser: `parserScript` holds inline code, and `parserFile` names a file in `~/.config/omarchy/mqtt-notifier/parsers/`. Without a parser the payload text is used as-is.

## The environment

| Name | Kind | Meaning |
|---|---|---|
| `msgin` | input, string | The payload decoded as UTF-8. Invalid bytes become U+FFFD (�). |
| `msgout` | output, starts as `""` | Notification text. Must end up a non-empty string. |
| `msgicon` | output, starts as `null` | `ICON_QUESTION`, `ICON_WARN`, `ICON_ERROR`, `ICON_OK` or `null`. |
| `msglink` | output, starts as `null` | An absolute `http://` or `https://` URL, or `null`. |
| `to_string(v)` | function | Strings unchanged, numbers as decimals, booleans as `true`/`false`, objects and arrays as JSON, `null`/`undefined` as `""`. |
| `parseXml(text)` | function | XML to a plain object (see below). |
| `JSON`, `Math`, `Date`, `RegExp`, `Intl`, … | built-ins | Standard JavaScript, frozen. |
| `console.log/info/warn/error` | function | Captured (up to 20 lines) and shown by the parser test, not in the shell log. |

Scripts run in strict mode, so assigning to an undeclared variable is an error; use `var`/`let`/`const`. `return` ends the script early, and whatever the outputs hold at that point is used.

There is no file, network, environment, timer or subprocess access, and the `Deno` and Node globals have been removed. A script has 250 ms and a 64 MB heap; both limits can be changed under `advanced`.

## Results and failures

| What happens | Notification |
|---|---|
| Script runs; `msgout` is a non-empty string | `msgout` (trimmed, max 4096 characters), `msgicon`, `msglink` |
| `msgicon` isn't one of the four constants | Same, without an icon; a warning goes to the log |
| `msglink` isn't an http(s) URL (or contains credentials) | Same, without a link; a warning goes to the log |
| `msgout` is empty or not a string | **Fallback:** the raw payload, `ICON_ERROR`, no link; the reason goes to the log |
| The script throws, times out, or runs out of memory | **Fallback** as above; the worker is restarted when needed |
| Payload larger than `maxPayloadBytes` (256 KiB) | "Payload too large (N bytes …)", `ICON_ERROR` |

A message is never dropped because its parser failed.

## Examples

JSON:

```js
var data = JSON.parse(msgin)
msgout = "Temperature: " + data.temperature + " °C, Humidity: " + data.humidity + "%"
msgicon = data.temperature > 28 ? ICON_WARN : ICON_OK
```

Plain text:

```js
msgout = "ALERT: " + msgin
msgicon = ICON_WARN
```

XML:

```js
// <sensor id="attic"><temperature>29.5</temperature><status>warning</status></sensor>
var s = parseXml(msgin).sensor
msgout = s["@_id"] + ": " + s.temperature + " °C (" + s.status + ")"
msgicon = s.status === "warning" ? ICON_WARN : ICON_OK
```

Link to a dashboard, and skip noise:

```js
var d = JSON.parse(msgin)
if (d.state === "idle") { msgout = "Washer idle"; return }
msgout = "Washer: " + d.state
msglink = "http://homeassistant.local:8123/dashboard-laundry"
```

## parseXml conventions

- Attributes become `"@_name"` keys.
- An element that contains only text becomes a string. Values are never converted to numbers.
- Repeated child elements become an array.
- Text mixed with child elements is stored as `"#text"`.
- Comments and processing instructions are skipped. CDATA is kept as text.
- DOCTYPE declarations are ignored and entities in them are never expanded, so external entities and "billion laughs" attacks don't work. Only the five XML entities and numeric character references are decoded.
- At most 64 levels of nesting and 10,000 elements. Malformed XML throws `SyntaxError`, which produces the fallback notification.

## Testing a parser

Until the settings screen exists, test a parser through the helper the same way the UI will:

```bash
cd helper
printf '%s\n' '{"id":1,"op":"testParser","script":"msgout = msgin.toUpperCase()","input":"hello"}' \
  | ./start.sh "$(mktemp -d)" "$(mktemp -d)" --no-desktop-notifications | grep '"id":1'
```

The reply contains `text`, `icon`, `link`, `fallback`, `error`, `warnings` and `logs`. A test never creates a notification.
