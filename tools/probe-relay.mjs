/**
 * Checks the relay the launcher actually uses, with the launcher's own idea of "usable".
 *
 * index.html already defines that precisely: open the WebSocket, wait for the Wisp greeting,
 * open a TCP stream to example.com:80 and wait for HTTP to come back - a relay that accepts the
 * handshake but never carries a stream fails. This loads that page's relay module unchanged (it is
 * a browser script, so it gets a window) and reports what it finds.
 *
 *   node tools/probe-relay.mjs                 # the DEFAULT relay; exit 1 when it is down
 *   node tools/probe-relay.mjs wss://host/     # any relay
 *   node tools/probe-relay.mjs --all           # every curated relay, exit 1 only if none work
 *
 * Needs a global WebSocket, which Node 22+ has. Exit 0 = the relay carried traffic.
 */
import vm from "node:vm";

import { relaySource } from "./relay-source.mjs";

if (typeof WebSocket !== "function") {
  console.error(`needs a global WebSocket; Node ${process.version} has none (22+ does)`);
  process.exit(2);
}

/* Everything the launcher is allowed to touch. A vm context inherits no Node globals, so this list
   is the launcher's whole world: a page edit that reaches for one more (TextEncoder, crypto,
   AbortController, performance) would otherwise throw here and nowhere else, which reads as a relay
   fault rather than a probe that fell behind the page. Grow it when the launcher grows. */
const GLOBALS = [
  "URL", "URLSearchParams", "atob", "btoa", "TextEncoder", "TextDecoder",
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "ArrayBuffer", "DataView",
  "Promise", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "performance", "crypto", "AbortController", "AbortSignal", "WebSocket", "console",
];

/** the page assigns window.WispRelays; nothing it defines runs until it is called. */
function launcher() {
  const context = { window: {} };
  for (const name of GLOBALS) {
    if (typeof globalThis[name] !== "undefined") context[name] = globalThis[name];
  }
  vm.createContext(context);
  vm.runInContext(relaySource(), context, { filename: "index.html" });
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
