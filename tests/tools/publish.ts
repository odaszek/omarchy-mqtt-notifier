// Publish one MQTT message.
//   deno run --allow-net --allow-env --allow-read --allow-sys tests/tools/publish.ts [--port 1883] [--retain] <topic> <payload>
import mqtt from "npm:mqtt@5.16.1"

const args = [...Deno.args]
let port = 1883
let retain = false
for (let i = 0; i < args.length;) {
  if (args[i] === "--port") {
    port = Number(args[i + 1])
    args.splice(i, 2)
  } else if (args[i] === "--retain") {
    retain = true
    args.splice(i, 1)
  } else i++
}
const [topic, payload = ""] = args
if (!topic) {
  console.error("usage: publish.ts [--port N] [--retain] <topic> <payload>")
  Deno.exit(2)
}
const client = mqtt.connect("mqtt://127.0.0.1:" + port, {
  clientId: "dev-publisher-" + crypto.randomUUID().slice(0, 6),
})
client.on("connect", () => {
  client.publish(topic, payload, { qos: 1, retain }, (err) => {
    if (err) console.error(err)
    client.end(false, {}, () => Deno.exit(err ? 1 : 0))
  })
})
client.on("error", (e) => {
  console.error(e.message)
  Deno.exit(1)
})
