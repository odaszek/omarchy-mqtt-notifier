// Development MQTT broker (aedes, MQTT 3.1.1) for trying the plugin without a real broker.
//   deno run --allow-net --allow-env --allow-read --allow-sys tests/tools/broker.ts [port]
import aedes from "npm:aedes@0.51.3"
import net from "node:net"

const port = Number(Deno.args[0] ?? 1883)
const broker = await aedes.createBroker()
const server = net.createServer(broker.handle)
server.listen(port, "127.0.0.1", () => console.log("dev broker listening on 127.0.0.1:" + port))
broker.on("client", (c: { id: string }) => console.log("client connected:", c.id))
broker.on(
  "subscribe",
  (subs: { topic: string }[], c: { id: string }) => console.log("subscribe", c?.id, subs.map((s) => s.topic).join(", ")),
)
