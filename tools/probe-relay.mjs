/**
 * Checks the relay the launcher actually uses, with the launcher's own idea of "usable".
 *
 * relays.js already defines that precisely: open the WebSocket, wait for the Wisp greeting,
 * open a TCP stream to example.com:80 and wait for HTTP to come back - a relay that accepts the
 * handshake but never carries a stream fails. This loads that script unchanged (it is a browser
 * script, so it gets a window) and reports what it finds.
 *
 *   node tools/probe-relay.mjs                 # the DEFAULT relay; exit 1 when it is down
 *   node tools/probe-relay.mjs wss://host/     # any relay
 *   node tools/probe-relay.mjs --all           # every curated relay, exit 1 only if none work
 *
 * Needs a global WebSocket, which Node 22+ has. Exit 0 = the relay carried traffic.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (typeof WebSocket !== "function") {
  console.error(`needs a global WebSocket; Node ${process.version} has none (22+ does)`);
  process.exit(2);
}

/** relays.js assigns window.WispRelays; nothing it defines runs until it is called. */
function launcher() {
  const context = { window: {}, URL, Uint8Array, Promise, setTimeout, clearTimeout, WebSocket };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "relays.js"), "utf8"), context, { filename: "relays.js" });
  return context.window.WispRelays;
}

const relays = launcher();
const args = process.argv.slice(2);
const everything = args.includes("--all");
const named = args.filter((arg) => !arg.startsWith("--"));

const results = everything
  ? await relays.probeAll(4000)
  : await Promise.all((named.length ? named : [relays.DEFAULT]).map((url) => relays.probe(url, 6000)));

results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
for (const result of results) console.log(`${result.ok ? "ok  " : "DOWN"} ${String(result.ms).padStart(5)} ms  ${result.url}`);

const down = results.filter((result) => !result.ok).length;
if (everything) {
  console.log(`\n${results.length - down}/${results.length} relays carried traffic.`);
  process.exit(down === results.length ? 1 : 0);
}
process.exit(down === 0 ? 0 : 1);
