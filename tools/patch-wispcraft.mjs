#!/usr/bin/env node
/**
 * Re-applies the local modifications to the vendored Wispcraft bundle (wispcraft.js).
 *
 * Patches (see PATCHES.md for the measured behaviour behind each one):
 *   1. getProfile() diagnostics - the upstream bundle throws a bare
 *      `throw new Error("mc did not return a profile")`, which hides whether the
 *      account has no Java profile (404) or the token/relay was rejected (401/403).
 *      This injects a helper that reports the HTTP status plus a cause hint.
 *   2. Built-in relay default - pins the bundle's fallback relay to the same value
 *      the launcher page ships as DEFAULT, which is read out of index.html so a replaced bundle
 *      cannot drift from the launcher (and --check needs no extra flag).
 *   3. Relay fetch export - publishes the epoxy client on the launcher namespace so a page can reach
 *      an endpoint that sends no CORS headers (the session join).
 *   7. Relay repair - rebuilds the multiplexor once when it has ended, then retries the request.
 *   4. SRV resolution - asks the launcher's cached resolver before the relay dials a Java host.
 *   5. Quick play transport - a matching wss:// address is routed into the Wisp stream.
 *   6. Server entry - appends the launcher's java:// entry to the list the client builds at boot.
 *   8. Runtime relay switch - rebuilds the client on a new relay, gated on connects that are still opening.
 *   9. Join-only reach check - asks the launcher whether the relay can reach this server, and only for a join.
 *  10. Post-connect failure - a stream that errors or ends after connect_tcp ends the socket with
 *      error then close, instead of an unhandled rejection on a socket that stays open.
 * 7 before 4/5/6 because it rewrites the line patch 3 leaves behind; the numbers otherwise follow
 * the order they were added to the launcher, not the order they run.
 *
 * Usage:
 *   node tools/patch-wispcraft.mjs                 # patch ./wispcraft.js
 *   node tools/patch-wispcraft.mjs --check         # verify only, no writes
 *   node tools/patch-wispcraft.mjs --file path.js  # patch another copy
 *   node tools/patch-wispcraft.mjs --default-relay wss://relay.example/
 *
 * Exit codes: 0 patched/already-patched, 1 --check found a missing patch, 2 anchors unusable.
 *
 * The script is idempotent and never guesses: if a future bundle minifies the
 * profile function differently, it stops with exit 2 and says which anchor vanished.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HELPER = "__wispProfileError";
const PROFILE_URL = '"https://api.minecraftservices.com/minecraft/profile"';
const ORIGINAL_THROW = 'throw new Error("mc did not return a profile")';
const APPLIED_MARKERS = ['Minecraft profile fetch failed (HTTP ', HELPER + "("];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const file = path.resolve(opt("--file", "wispcraft.js"));
/* index.html is the single source of truth for the default relay; the bundle's pinned fallback
   follows it unless a caller is patching a copy against some other launcher. */
function launcherRelayDefault() {
  const candidates = [path.join(path.dirname(file), "index.html"), path.resolve("index.html")];
  for (const candidate of candidates) {
    try {
      const found = fs.readFileSync(candidate, "utf8").match(/\bvar\s+DEFAULT\s*=\s*"([^"]+)"/);
      if (found) return found[1];
    } catch (err) { /* try the next location */ }
  }
  return null;
}
const relayDefault = opt("--default-relay", launcherRelayDefault() || "wss://anura.pro/");
const checkOnly = flag("--check");

let js;
try {
  js = fs.readFileSync(file, "utf8");
} catch (err) {
  console.error(`[fail] cannot read ${file}: ${err.message}`);
  process.exit(2);
}

const lines = [];
let changed = 0;
let fatal = null;

// ---------------------------------------------------------------- patch 1: relay default
// The bundle resolves its default with `localStorage.wispcraft_wispurl || OI`, so the
// identifier is discovered rather than hard-coded (minifiers rename it between builds).
let defaultId = null;
const refMatch = js.match(/localStorage\.wispcraft_wispurl\s*\|\|\s*([A-Za-z_$][\w$]*)/);
if (!refMatch) {
  lines.push("[skip] relay default: no `localStorage.wispcraft_wispurl||<CONST>` reference found");
} else {
  defaultId = refMatch[1];
  const assign = js.match(new RegExp(`(\\b${defaultId}\\s*=\\s*")(wss?:\\/\\/[^"]*)(")`));
  if (!assign) {
    lines.push(`[skip] relay default: constant ${defaultId} exists but its literal was not found`);
  } else if (assign[2] === relayDefault) {
    lines.push(`[ok]   relay default already ${relayDefault} (${defaultId})`);
  } else {
    js = js.replace(assign[0], `${assign[1]}${relayDefault}${assign[3]}`);
    changed++;
    lines.push(`[fix]  relay default ${assign[2]} -> ${relayDefault} (${defaultId})`);
  }
}

// ---------------------------------------------------------------- patch 2: profile diagnostics
const alreadyApplied = APPLIED_MARKERS.some((m) => js.includes(m));

if (alreadyApplied) {
  lines.push("[ok]   profile error patch already present");
} else {
  const urlAt = js.indexOf(PROFILE_URL);
  const throwAt = js.indexOf(ORIGINAL_THROW);

  if (urlAt < 0) {
    fatal = `profile patch: ${PROFILE_URL} is not in this file - is it the Wispcraft bundle?`;
  } else if (throwAt < 0 || throwAt - urlAt > 900) {
    fatal =
      `profile patch: the throw ${JSON.stringify(ORIGINAL_THROW)} is missing or too far from the profile fetch.\n` +
      "       The bundle was rebuilt with a different shape; open the function around\n" +
      `       ${PROFILE_URL}, check what it throws now, and update ORIGINAL_THROW in this script.`;
  } else {
    // Which variable holds the profile Response? Read it from the fetch binding.
    const window = js.slice(Math.max(0, urlAt - 200), urlAt + 200);
    const binding = window.match(
      /([A-Za-z_$][\w$]*)\s*=\s*await\s+LA\(\s*"https:\/\/api\.minecraftservices\.com\/minecraft\/profile"/
    );

    if (!binding) {
      fatal =
        "profile patch: could not tell which variable holds the profile Response\n" +
        '       (expected `<name> = await LA("https://api.minecraftservices.com/minecraft/profile" ...)`).';
    } else {
      const helperSrc =
        `async function ${HELPER}(r){` +
        'var s=r&&typeof r.status=="number"?r.status:0;' +
        'var h=s===404?"This Microsoft account has no Minecraft: Java Edition profile. Sign in with the account that owns Java Edition (and has launched it once).":' +
        's===401||s===403?"Microsoft/Mojang rejected the session token. Open Wispcraft Settings and add the account again.":' +
        '"The Minecraft profile endpoint returned an unexpected response.";' +
        'var d="";try{var c=r.clone();var x=await c.text();var j=JSON.parse(x);' +
        'd=String(j&&(j.errorMessage||j.error)||"").slice(0,120).replace(/[<>]/g,"")}catch(e){}' +
        'return "Minecraft profile fetch failed (HTTP "+s+"). "+h+(d?" ["+d+"]":"")}';

      // Inject the helper just before the statement that defines the relay default,
      // which sits inside the bundle's own scope; fall back to the file start.
      let injectAt = 0;
      if (defaultId) {
        const declAt = js.search(new RegExp(`(const|let|var)\\s+[^;]{0,120}\\b${defaultId}\\s*=`));
        if (declAt >= 0) injectAt = declAt;
      }
      js = js.slice(0, injectAt) + helperSrc + "\n" + js.slice(injectAt);

      const at = js.indexOf(ORIGINAL_THROW);
      js = js.slice(0, at) + `throw new Error(await ${HELPER}(${binding[1]}))` + js.slice(at + ORIGINAL_THROW.length);
      changed++;
      lines.push(`[fix]  profile error patch applied (response var \`${binding[1]}\`, helper ${HELPER})`);
    }
  }
}

// ---------------------------------------------------------------- patch 3: expose the relay fetch
// The bundle owns an epoxy client (a full HTTP client that speaks HTTPS through the wisp relay), so
// it can reach endpoints a page cannot - sessionserver.mojang.com sends no CORS headers, which is
// what kills an online-mode join. The client itself is module-scoped; this publishes it on the
// launcher namespace so the page's fetch shim can hand those requests to the relay instead of a
// third-party proxy. The identifier is discovered from the `return await <A>,await <B>.fetch(` shape.
const RELAY_MARKER = ".fetchViaRelay=";
const nsId = (js.match(/([A-Za-z_$][\w$]*)\.wispUrl\s*=/) || [])[1];
const fetchFn = (js.match(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]{0,24}\)\s*\{\s*return await [A-Za-z_$][\w$]*,\s*await [A-Za-z_$][\w$]*\.fetch\(/) || [])[1];

const alreadyExported = nsId && new RegExp("\\n" + nsId.replace(/\$/g, "\\$") + "\\.fetchViaRelay=").test(js);
if (alreadyExported) {
  lines.push("[ok]   relay fetch export already present");
} else if (!nsId || !fetchFn) {
  lines.push("[skip] relay fetch export: could not find the namespace or the relay-fetch helper");
} else {
  /* the namespace object owns wispUrl, so this line is module scope: a function declared later is
     hoisted, and the closure only runs when a request is actually made */
  const anchor = new RegExp(`(${nsId.replace(/\$/g, "\\$")}\\.wispUrl\\s*=\\s*void 0;)`);
  if (!anchor.test(js)) {
    lines.push("[skip] relay fetch export: no `<ns>.wispUrl=void 0` anchor at module scope");
  } else {
    js = js.replace(anchor, `$1\n${nsId}.fetchViaRelay=function(u,i){return ${fetchFn}(u,i)};`);
    changed++;
    lines.push(`[fix]  relay fetch exported as ${nsId}.fetchViaRelay (helper ${fetchFn})`);
  }
}

// ---------------------------------------------------------------- patch 7: the relay fetch heals itself
// The epoxy client owns one wisp multiplexor, created once at boot. When the relay drops it (an idle
// page, or the game's own wisp join closing the socket) every later request fails in 1 ms with
// `Wisp(MuxTaskEnded)` - which is what turns a working session join into "Could not reach Minecraft
// session authentication". The settings UI already knows how to rebuild it (a fresh client plus
// replace_stream_provider), so the exported fetch retries through that once before giving up.
const RELAY_REPAIR = "repairRelay";
const repairMatch = js.match(
  /async function ([A-Za-z_$][\w$]*)\(A,I\)\{return await ([A-Za-z_$][\w$]*),await ([A-Za-z_$][\w$]*)\.fetch\(/
);
const readyMatch = js.match(/([A-Za-z_$][\w$]*)=new Promise\(A=>([A-Za-z_$][\w$]*)=A\)/);
/* the init function is the async function that constructs the client: `KA=new NA(A,I)` */
function findInitFn(clientVar) {
  const at = js.search(new RegExp("\\b" + clientVar.replace(/\$/g, "\\$") + "=new [A-Za-z_$][\\w$]*\\(A,I\\)"));
  if (at < 0) return null;
  const head = js.slice(Math.max(0, at - 500), at);
  const found = [...head.matchAll(/async function ([A-Za-z_$][\w$]*)\s*\(A\)\s*\{/g)];
  return found.length ? found[found.length - 1][1] : null;
}
const initFn = repairMatch ? findInitFn(repairMatch[3]) : null;
const exportMatch = js.match(/([A-Za-z_$][\w$]*)\.fetchViaRelay=function\(u,i\)\{return ([A-Za-z_$][\w$]*)\(u,i\)\};/);

if (js.includes('.' + RELAY_REPAIR + '=')) {
  lines.push("[ok]   relay repair patch already present");
} else if (!repairMatch || !readyMatch || !initFn || !exportMatch) {
  lines.push("[skip] relay repair: could not resolve the epoxy client, its ready promise or the init function");
} else {
  const [, fetchFn, readyPromise, client] = repairMatch;
  const [, promiseId, resolver] = readyMatch;
  const ns = exportMatch[1];
  /* single flight: the profile and session requests fail together, and rebuilding the client twice
     at once would swap the multiplexor out from under the first repair */
  const repair =
    `${ns}.${RELAY_REPAIR}=function(){if(!${ns}.__repairPending){` +
    `var p=${ns}.__repairPending=(async function(){try{${promiseId}=new Promise(function(r){${resolver}=r}),` +
    `${initFn}(${ns}.wispUrl),await ${promiseId},await ${client}.replace_stream_provider();return true}` +
    `catch(e){return String((e&&e.message)||e)}})();` +
    `p.then(function(){if(${ns}.__repairPending===p)${ns}.__repairPending=null})}` +
    `return ${ns}.__repairPending};\n` +
    `${ns}.fetchViaRelay=async function(u,i){try{return await ${fetchFn}(u,i)}catch(e){` +
    `var m=String((e&&e.message)||e);if(/MuxTaskEnded|Multiplexor task ended/.test(m)){` +
    `await ${ns}.${RELAY_REPAIR}();return await ${fetchFn}(u,i)}throw e}};`;
  js = js.replace(exportMatch[0], repair);
  changed++;
  lines.push(`[fix]  relay fetch retries through a rebuilt multiplexor (${client}, ${initFn}, ${promiseId})`);
}

// ---------------------------------------------------------------- patch 4: SRV for every Java connect
// The bundle resolves `_minecraft._tcp.<host>` with a fetch through its own epoxy client. That fetch
// only works while the wisp multiplexor is healthy: when it is not, the SRV lookup throws, the catch
// swallows it and the relay is asked for the bare host (minemen.club times out; geo.minemen.club is
// the real target). The launcher page owns a two-provider resolver with a 6 hour cache, so prefer it
// and keep the upstream lookup as the fallback.
const SRV_MARKER = 'window.wispcraftResolveSrv=="function"';
const SRV_ANCHOR = "async forward(A){let I;try{";

if (js.includes(SRV_MARKER)) {
  lines.push("[ok]   srv resolution patch already present");
} else if (!js.includes(SRV_ANCHOR)) {
  lines.push("[skip] srv resolution: the java forward() anchor was not found");
} else {
  const srvSrc =
    "if(typeof window.wispcraftResolveSrv==\"function\"){try{var __srv=await window.wispcraftResolveSrv(this.url.hostname);" +
    "if(__srv&&__srv.host){I=new URL(\"java://\"+__srv.host+\":\"+(__srv.port||25565))," +
    "window.wispcraftNote&&window.wispcraftNote(\"srv \"+this.url.hostname+\" -> \"+__srv.host+\":\"+(__srv.port||25565))}}catch(e){}}";
  js = js.replace(SRV_ANCHOR, SRV_ANCHOR + srvSrc);
  changed++;
  lines.push("[fix]  srv resolution routed through window.wispcraftResolveSrv");
}

// ---------------------------------------------------------------- patch 5: quick play opens in Wisp mode
// Quick Play (?server=<host>) makes the client dial wss://<host>: an EaglerX socket, which no Java
// server answers ("connection dropped without a WebSocket close frame (code 1006)"). The bundle's
// window.WebSocket proxy is where the transport is chosen - java:// addresses become the Wisp stream
// (VI) - so when the launcher publishes window.wispcraftJavaQuickPlay, the same host arriving as
// wss:// is routed to the Wisp stream instead. The Wisp stream's own SRV step then applies the
// _minecraft._tcp record, so minemen.club reaches geo.minemen.club:25565. The java:// URL shape is
// the bundle's own double form: the proxy splits java://java://<host>:<port> into host "java" plus
// the real address, which is what the stream class parses.
const QP_MARKER = "window.wispcraftJavaQuickPlay";
const QP_ANCHOR = 'return Q&&"settings"==B.hostname?new mI:new xI(g,C)}});';

if (js.includes(QP_MARKER)) {
  lines.push("[ok]   quick play wisp patch already present");
} else if (!js.includes(QP_ANCHOR)) {
  lines.push("[skip] quick play wisp: the WebSocket proxy tail was not found");
} else {
  const qpSrc =
    'if(Q&&"settings"==B.hostname)return new mI;' +
    'if("wss:"==B.protocol||"ws:"==B.protocol){var __qp=window.wispcraftJavaQuickPlay;' +
    'if(__qp){var __h=String(B.hostname||"").toLowerCase(),__want=[__qp.request,__qp.host];' +
    'if(__want.indexOf(__h)>=0||__want.indexOf(__h.replace(/^www\\./,""))>=0){' +
    'var __s=new VI("java://java://"+__qp.host+":"+(__qp.port||25565));' +
    'window.wispcraftNote&&window.wispcraftNote("quick play "+__h+" -> wisp "+__qp.host+":"+(__qp.port||25565));' +
    'return __s.start(),__s}}}' +
    'return new xI(g,C)}});';
  js = js.replace(QP_ANCHOR, qpSrc);
  changed++;
  lines.push("[fix]  quick play routed into wisp mode for the launcher's java target");
}

// ---------------------------------------------------------------- patch 6: launcher-supplied server entry
// The launcher cannot write the client's server list (the client owns it), and the client's own
// networking runs in a wasm worker a page cannot patch, so Quick Play cannot be moved onto Wisp from
// the page. What the launcher can do is hand the client an entry: eaglercraftXOpts is read at
// startup, and this setter is where the list is built (it already injects the settings:// entry).
// Appending window.wispcraftJavaEntry here survives the client's own later assignment of the same
// property, which would otherwise replace the list and drop the entry.
const ENTRY_MARKER = 'window.wispcraftJavaEntry&&';
const ENTRY_ANCHOR = 'set(A){$I=A,$I?.servers?$I.servers.unshift(Ag):$I.servers=[Ag]}';

if (js.includes(ENTRY_MARKER)) {
  lines.push("[ok]   launcher server entry patch already present");
} else if (!js.includes(ENTRY_ANCHOR)) {
  lines.push("[skip] launcher server entry: the eaglercraftXOpts setter was not found");
} else {
  const entrySrc =
    'set(A){$I=A,$I?.servers?$I.servers.unshift(Ag):$I.servers=[Ag],' +
    'window.wispcraftJavaEntry&&($I.servers.push(window.wispcraftJavaEntry),' +
    'window.wispcraftNote&&window.wispcraftNote("server list: added "+window.wispcraftJavaEntry.addr))}';
  js = js.replace(ENTRY_ANCHOR, entrySrc);
  changed++;
  lines.push("[fix]  launcher-supplied server entry appended to eaglercraftXOpts.servers");
}

// ---------------------------------------------------------------- patch 8: the relay can be switched at run time
// The bundle resolves its relay once, at module init (`A.wispUrl = ... || localStorage[..] || OI`),
// and builds the epoxy client (and its wisp multiplexor) from that value. Writing the localStorage
// key afterwards therefore changes nothing the client dials - a page that "switches relay" that way
// only fools itself, and the join still fails with code 1006. The settings picker already knows the
// real sequence (rebuild the client, then replace the wasm side's stream provider); this publishes
// it as `window.wispcraft.switchRelay(url)` so the launcher can move a live join to a relay that can
// reach the server, and report the address the client now dials.
//
// A rebuild swaps the stream provider under every stream the client has open, so switchRelay also
// owns the gate the java stream uses around connect_tcp: it waits for the connections that are
// still opening (a Multiplayer ping sweep is a burst of them) and holds new ones back until the
// rebuild is done. If they do not finish in time it refuses the switch instead of pulling the
// provider out from under them.
const SWITCH_MARKER = ".switchRelay=";
const SWITCH_ANCHOR = "A.setWispUrl=TI,";
const GATE_MARKER = ".__enterConnect=";

if (js.includes(SWITCH_MARKER) && js.includes(GATE_MARKER)) {
  lines.push("[ok]   runtime relay switch already present");
} else if (!repairMatch || !readyMatch || !initFn || js.split(SWITCH_ANCHOR).length - 1 !== 1) {
  lines.push("[skip] runtime relay switch: could not resolve the client, its ready promise or the export tail");
} else {
  const client = repairMatch[3], readyPromise = repairMatch[2], resolver = readyMatch[2];
  const gateSrc =
    "A.__connects=0,A.__idleWaiters=[],A.__connectWaiters=[];" +
    "A.__enterConnect=function(){if(!A.__switching){A.__connects++;return Promise.resolve()}" +
    "return new Promise(function(r){A.__connectWaiters.push(function(){A.__connects++,r()})})};" +
    "A.__leaveConnect=function(){if(A.__connects>0)A.__connects--;" +
    "if(!A.__connects){var w=A.__idleWaiters;A.__idleWaiters=[];for(var i=0;i<w.length;i++)w[i]()}};" +
    /* resolves false when the connects that were running have not finished within ms */
    "A.__idle=function(ms){if(!A.__connects)return Promise.resolve(true);" +
    "return new Promise(function(res){var d=0,t=setTimeout(function(){if(!d){d=1,res(false)}},ms);" +
    "A.__idleWaiters.push(function(){if(!d){d=1,clearTimeout(t),res(true)}})})};" +
    "A.__releaseConnects=function(){var w=A.__connectWaiters;A.__connectWaiters=[];for(var i=0;i<w.length;i++)w[i]()};";
  const switchSrc =
    "A.switchRelay=function(url){" +
    "var run=function(){var prev=A.wispUrl;return (async function(){" +
    /* the boot build may still be in flight; it resolves this promise and would otherwise do so
       again after the rebuild, leaving the two clients swapped */
    `await ${readyPromise};` +
    'var want;try{want=new URL(String(url));want.pathname.endsWith("/")||(want.pathname+="/"),want=want.href}' +
    'catch(e){return {ok:false,why:"invalid url"}}' +
    `if(want===A.wispUrl&&${client})return {ok:true,relay:want,unchanged:true};` +
    "A.__switching=!0;var idle=await A.__idle(6000);" +
    "if(!idle){A.__switching=!1,A.__releaseConnects();" +
    'return {ok:false,why:"other connections are still opening"}};' +
    "try{" +
    `A.wispUrl=want,${readyPromise}=new Promise(function(r){${resolver}=r}),${initFn}(want),` +
    `await ${readyPromise},await ${client}.replace_stream_provider();` +
    'try{localStorage.setItem("wispcraft_wispurl",want)}catch(e){}' +
    "return {ok:true,relay:want,previous:prev}" +
    "}finally{A.__switching=!1,A.__releaseConnects()}" +
    "})()};" +
    "var p=(A.__relaySwitch||Promise.resolve()).then(run);" +
    "A.__relaySwitch=p.then(function(r){return r},function(e){return {ok:false,why:String((e&&e.message)||e)}});" +
    "return A.__relaySwitch};";
  js = js.replace(SWITCH_ANCHOR, gateSrc + switchSrc + SWITCH_ANCHOR);
  changed++;
  lines.push(`[fix]  runtime relay switch with a connect gate (${client}, ${initFn}, ${readyPromise})`);
}

// ---------------------------------------------------------------- patch 9: a join checks its relay first, a ping does not
// The java stream is used for two very different things: the Multiplayer screen pings every entry to
// draw its MOTD, and the player joins one server. Both arrive as `java://` sockets, and they look
// identical until the client's first frame - a ping sends the string "accept: motd", a join sends its
// binary handshake. So the stream dispatches `open` before it dials, waits for that first frame, and
// only a join waits on the launcher's reach probe and possibly a relay switch. A status ping never
// touches the relay choice, which is what keeps a Multiplayer screen from probing for servers nobody
// is joining. The dial itself is deferred until then, so a switch still happens before the join's TCP
// is opened, and it is bracketed by the connect gate patch 8 publishes.
const DIAL_INTENT_MARKER = "__wispDialIntent";
/* forward() runs before the dial now, so a dial that throws has to be able to reach the socket */
const DIAL_FAIL_MARKER = "__onFail";
const FWD_OPEN_ANCHOR = "async forward(A){let I;try{";
/* the trailing A() is the original "connected" callback: open is dispatched before the dial now, so
   it is consumed by the replacement instead of firing twice */
const DIAL_ANCHOR = "const g=await async function(A){return await SA,await KA.connect_tcp(A)}(I?I.host:this.url.host);A();";
const SEND_ANCHOR = 'send(A){let I;if("string"!=typeof A){';
const MOTD_ANCHOR = 'else"accept: motd"==A.toLowerCase()&&this.inner.ping()}';
const IMPL_ANCHOR = "this.impl=B}ping(){";
const START_ANCHOR = 'this.inner.forward(()=>{this.readyState=WebSocket.OPEN,this.dispatchEvent(new Event("open"))})';
const CLOSE_ANCHOR = "close(){if(this.readyState!=WebSocket.CLOSING&&this.readyState!=WebSocket.CLOSED){";

const dialAnchors = [FWD_OPEN_ANCHOR, DIAL_ANCHOR, SEND_ANCHOR, MOTD_ANCHOR, IMPL_ANCHOR, START_ANCHOR, CLOSE_ANCHOR];
const dialAnchorOk = dialAnchors.every((a) => js.split(a).length - 1 === 1);

if (js.includes(DIAL_INTENT_MARKER) && js.includes(DIAL_FAIL_MARKER)) {
  lines.push("[ok]   join-only reach check already present");
} else if (!dialAnchorOk) {
  lines.push("[skip] join-only reach check: the java stream anchors were not all found once");
} else {
  /* open first: the client identifies itself in its first frame, and a join buffers that handshake
     until the connection below is established. The second argument is the socket's failure callback,
     which the original code never passed because open could not fail before the dial.
     A() has to run *outside* the block below: that block declares `const A = await LA(...)`, so the
     parameter is in its temporal dead zone inside it and calling A() there throws into the SRV
     catch - the open event would never fire at all. */
  js = js.replace(
    FWD_OPEN_ANCHOR,
    /* a microtask, not a direct call: WI.start() runs inside the socket's constructor (the bundle's
       WebSocket proxy does this), so dispatching open there reaches nobody - a caller that does
       `s = new WebSocket(..); s.onopen = ..` attaches its handler after the constructor returns. A
       real socket delivers open asynchronously for the same reason. The frame wait below still
       keeps open ahead of the dial. */
    "async forward(A,__onFail){var __open=A;queueMicrotask(function(){try{__open()}catch(e){__onFail&&__onFail(e)}});let I;try{"
  );

  /* VI.__fail(): open already fired, so a dial that never connects has to end in the events a real
     socket would send - error, then close - or the join waits forever on an open, silent socket */
  js = js.replace(
    CLOSE_ANCHOR,
    "__fail(){if(this.readyState===WebSocket.CLOSED||this.readyState===WebSocket.CLOSING)return;" +
      "this.readyState=WebSocket.CLOSING;try{this.inner.eaglerIn.abort()}catch(e){}" +
      'try{this.dispatchEvent(new Event("error"))}catch(e){}' +
      'this.readyState=WebSocket.CLOSED;this.dispatchEvent(new Event("close"))}' +
      CLOSE_ANCHOR
  );
  js = js.replace(START_ANCHOR, START_ANCHOR.slice(0, -1) + ",()=>this.__fail())");

  js = js.replace(
    SEND_ANCHOR,
    "send(A){var __f=typeof A===\"string\"&&\"accept: motd\"===A.toLowerCase()?\"motd\":\"data\";" +
      "if(void 0===this.inner.__frame){this.inner.__frame=__f;var __d=this.inner.__decide;" +
      "__d&&(this.inner.__decide=null,__d(__f))}" +
      SEND_ANCHOR.slice("send(A){".length)
  );
  /* the anchor ends with the brace that closes send(), so the replacement has to keep it */
  js = js.replace(MOTD_ANCHOR, 'else if("accept: motd"==A.toLowerCase()){this.inner.impl?this.inner.ping():this.inner.__wantPing=1}}');
  js = js.replace(IMPL_ANCHOR, "this.impl=B,this.__wantPing&&(this.__wantPing=0,this.ping())}ping(){");

  const dial =
    "/* __wispDialIntent: wait for the client's first frame before dialing */" +
    "var __self=this,__h=I?I.hostname:this.url.hostname," +
    '__p=parseInt((I?I.port:this.url.port)||"25565",10)||25565,' +
    "__t=I?I.host:this.url.host,__fm=parseInt(window.wispcraftFrameTimeout,10)||4000;" +
    "if(void 0===__self.__frame){await new Promise(function(r){var d=0;" +
    '__self.__decide=function(v){if(d)return;d=1,r(v)};' +
    /* bounded: a socket that never sends a frame is treated as a join and dialled, rather than waiting
       forever for a first packet that is not coming */
    'setTimeout(function(){if(!d){d=1,r("data")}},__fm)})}' +
    'if(__self.__frame!=="motd"&&window.wispcraftEnsureRelayReaches&&__h){' +
    "try{await window.wispcraftEnsureRelayReaches(__h,__p)}catch(e){}}" +
    "var __ns=window.wispcraft,__g,__bad;" +
    "if(__ns&&__ns.__enterConnect)await __ns.__enterConnect();" +
    /* a relay can accept the stream and then never answer, and its connect_tcp never settles: without a
       bound the socket would sit open forever. window.wispcraftDialTimeout overrides the 15 s. */
    "var __ms=parseInt(window.wispcraftDialTimeout,10)||15000,__timer," +
    "__dial=(async function(x){return await SA,await KA.connect_tcp(x)})(__t);" +
    "__dial.catch(function(){});" +
    "try{__g=await Promise.race([__dial,new Promise(function(_,rej){__timer=setTimeout(function(){" +
    "rej(new Error(\"the relay did not connect within \"+__ms+\" ms\"))},__ms)})])}catch(e){__bad=e}" +
    "finally{clearTimeout(__timer),__ns&&__ns.__leaveConnect&&__ns.__leaveConnect()}" +
    /* a failed dial is reported to the socket: it has already dispatched open, so staying quiet
       would leave the join on a socket that looks connected and never answers */
    "if(!__g){" +
    'var __why=String((__bad&&(__bad.message||__bad))||"did not connect");' +
    "window.wispcraftNote&&window.wispcraftNote(\"relay dial failed for \"+__t+\": \"+__why);" +
    "__onFail&&__onFail(__bad);return}" +
    "const g=__g;";
  js = js.replace(DIAL_ANCHOR, dial);
  changed++;
  lines.push("[fix]  java stream asks for the reach check only for a join, and dials behind the connect gate");
}

// ---------------------------------------------------------------- patch 10: a failure after the dial still ends the socket
// connect_tcp is only the relay's answer. The target is dialled behind it, so a server that refuses
// or drops the stream fails *after* the socket has already dispatched open. The bundle wires the
// connected stream into two detached `for(;;)` loops and drops both promises on the floor, so that
// failure arrives as an unhandled rejection while the socket sits at open forever - measured live,
// a join through a relay that accepted the stream left Multiplayer waiting with no error and no
// close. This depends on patch 9: `__onFail` (the forward() failure callback) and `__fail()` (the
// error-then-close path on the socket) are what the loops report into.
const STREAM_MARKER = "java stream failed after connect";
const WIRE_ANCHOR = "const C=WA(g.write.getWriter(),A=>A.inner);this.rawEpoxy=C.getWriter();";
const READ_LOOP_END = "if(g||!C)return;await B.epoxyRead(C),A--}})()";
const SEND_LOOP_END = "if(g||!C)return;await B.eaglerRead(C),A--}})()";
const IMPL_TAIL_ANCHOR = ",this.impl=B,this.__wantPing&&(this.__wantPing=0,this.ping())}ping(){";
const OUT_LOOP_ANCHOR =
  'this.readyState=WebSocket.CLOSING,this.dispatchEvent(new Event("close")),this.readyState=WebSocket.CLOSED}' +
  'catch(A){console.error(A),this.dispatchEvent(new Event("error"))}})()}';

const streamAnchors = [WIRE_ANCHOR, READ_LOOP_END, SEND_LOOP_END, IMPL_TAIL_ANCHOR, OUT_LOOP_ANCHOR];
if (js.includes(STREAM_MARKER)) {
  lines.push("[ok]   post-connect failure patch already present");
} else if (!js.includes("__fail(){") || !streamAnchors.every((a) => js.split(a).length - 1 === 1)) {
  lines.push("[skip] post-connect failure: the socket or the stream wiring anchor was not found once");
} else {
  /* one reporter for everything that can go wrong after the dial: the note names the reason for the
     player, and the socket's own failure callback does the error then close */
  const failSrc =
    "var __sf=function(e){window.wispcraftNote&&window.wispcraftNote(\"java stream failed after connect: \"+" +
    "String((e&&(e.message||e))||\"stream error\"));__onFail&&__onFail(e)};try{";
  js = js.replace(WIRE_ANCHOR, failSrc + WIRE_ANCHOR);
  /* a stream that ends is as dead as one that throws: both would otherwise leave an open, silent
     socket behind, and the normal close path is already guarded by __fail()'s readyState check */
  js = js.replace(READ_LOOP_END, "if(g||!C)return void __sf();await B.epoxyRead(C),A--}})().catch(__sf)");
  js = js.replace(SEND_LOOP_END, "if(g||!C)return void __sf();await B.eaglerRead(C),A--}})().catch(__sf)");
  js = js.replace(
    IMPL_TAIL_ANCHOR,
    ",this.impl=B,this.__wantPing&&(this.__wantPing=0,this.ping())}catch(__e){__sf(__e)}}ping(){"
  );
  /* the socket's own outbound loop had the same hole: a read that threw dispatched error and left
     readyState at OPEN, and a second close after __fail() would fire twice */
  js = js.replace(
    OUT_LOOP_ANCHOR,
    'this.readyState!==WebSocket.CLOSED&&(this.readyState=WebSocket.CLOSING,' +
      'this.dispatchEvent(new Event("close")),this.readyState=WebSocket.CLOSED)}' +
      "catch(A){console.error(A),this.__fail()}})()}"
  );
  changed++;
  lines.push("[fix]  post-connect stream failures end the socket with error then close");
}

// ---------------------------------------------------------------- validate before writing
if (!fatal && changed) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wispcraft-patch-")), "check.js");
  fs.writeFileSync(tmp, js);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    lines.push("[ok]   patched bundle parses (node --check)");
  } catch (err) {
    fatal = `patched bundle failed to parse, nothing written:\n${err.stderr ? err.stderr.toString() : err.message}`;
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

for (const line of lines) console.log(line);

if (fatal) {
  console.error(`\n[fail] ${fatal}`);
  process.exit(2);
}

if (checkOnly) {
  const missing = !alreadyApplied && changed === 0;
  if (changed > 0) {
    console.log("\n[check] patches are missing; run without --check to apply them.");
    process.exit(1);
  }
  if (missing) process.exit(1);
  console.log(`\n[check] ${path.basename(file)} carries every patch.`);
  process.exit(0);
}

if (changed === 0) {
  console.log(`\n[done] ${path.basename(file)} already up to date, nothing written.`);
} else {
  fs.writeFileSync(file, js);
  console.log(`\n[done] wrote ${file} (${js.length} bytes)`);
}
