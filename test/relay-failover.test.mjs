/**
 * Proves the launcher's relay failover behaviour without a browser:
 *   1. a healthy relay costs exactly one probe and touches no other relay;
 *   2. a broken relay is followed by a SEQUENTIAL sweep (never two sockets at once), stopping at the
 *      first relay that answers;
 *   3. the win is applied through the bundle's switchRelay and the reported relay is the live one;
 *   4. a refused switch is reported, not assumed, and the stored key is put back;
 *   5. results are cached per target, and two concurrent checks share one sweep.
 * It also pins the two bundle patches the switch depends on, and that the boot sweep is gone.
 * The page's reach code is cut out of play.html and run in a vm with a fake WebSocket, so this drives
 * the code the browser runs. Run with: node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/* every point is an assertion: the message names the check, the detail reports what was seen */
const check = (name, ok, detail) => assert.ok(ok, name + (detail ? ` [${detail}]` : ""));

/* ---------------------------------------------------------------- extract the launcher's reach code */
const html = fs.readFileSync("play.html", "utf8");
const from = html.indexOf('  var RELAY_KEY = "wispcraft_wispurl"');
const to = html.indexOf("  window.wispcraftEnsureRelayReaches = ensureRelayReaches;");
if (from < 0 || to < 0) { throw new Error("could not extract the reach block"); }
const reachCode = html.slice(from, to + "  window.wispcraftEnsureRelayReaches = ensureRelayReaches;".length);

const RELAYS = ["wss://relay-a/wisp/", "wss://relay-b/wisp/", "wss://relay-c/wisp/", "wss://relay-d/wisp/", "wss://relay-e/wisp/"];
const page = RELAYS.map((u) => `"${u}"`).join(",");

function setup(behaviour, switchImpl) {
  const state = { log: [], active: 0, max: 0, switched: [], notes: [] };
  const vals = {};
  /* `state.stored` is the relay key; every other key (the caches) lives in `vals` too, so a cached
     verdict is visible to the code exactly as localStorage would show it */
  Object.defineProperty(state, "stored", {
    get: () => ("wispcraft_wispurl" in vals ? vals.wispcraft_wispurl : null),
    set: (v) => { vals.wispcraft_wispurl = v; },
  });

  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = "";
      this._done = false;
      state.log.push(url);
      state.active++;
      state.max = Math.max(state.max, state.active);
      const end = () => { if (!this._done) { this._done = true; state.active--; } };
      this._end = end;
      setTimeout(() => {
        const mode = behaviour(url);
        if (mode === "ok") {
          this.readyState = 1;
          if (this.onopen) this.onopen();
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: new Uint8Array([2, 1, 0, 0, 0, 65]).buffer });
            end();
          }, 1);
        } else if (mode === "dead") {
          end();
          if (this.onerror) this.onerror();
        } else {
          end();
          this.readyState = 3;
          if (this.onclose) this.onclose();
        }
      }, 0);
    }
    send() {}
    close() { this._end(); this.readyState = 3; }
  }

  const ctx = {
    window: {
      wispcraft: {
        wispUrl: null,
        switchRelay(url) {
          state.switched.push(url);
          return switchImpl(url, state);
        },
      },
      wispcraftNote: (m) => state.notes.push(String(m)),
    },
    localStorage: {
      getItem: (k) => (k in vals ? vals[k] : null),
      setItem: (k, v) => { vals[k] = String(v); },
    },
    WebSocket: FakeWS,
    fetch: (u) => Promise.resolve({ text: () => Promise.resolve(`<script>var LIST=[${page}]</script>`) }),
    URL, Uint8Array, Promise, JSON, Object, Array, String, Number, Date, console,
    setTimeout, clearTimeout, parseInt, Math,
  };
  ctx.window.window = ctx.window;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(reachCode, ctx);
  state.ctx = ctx;
  return { api: ctx.window.wispcraftEnsureRelayReaches, state, ctx };
}

test("relay failover: sequential sweep, a refused switch, and the join-only check", async () => {
  /* 1. healthy relay: one probe, nothing else opened */
  {
    const { api, state } = setup((u) => (u === RELAYS[0] ? "ok" : (state.log.push("UNEXPECTED " + u), "ok")));
    state.ctx.window.wispcraft.wispUrl = RELAYS[0];
    state.stored = RELAYS[0];
    const res = await api("geo.minemen.club", 25565);
    check("healthy relay answers on the first probe", res && res.ok === true && res.switched !== true, JSON.stringify(res));
    check("healthy relay opens exactly one socket", state.log.length === 1 && state.log[0] === RELAYS[0], state.log.join(" "));
  }

  /* 2. broken relay -> sequential sweep, stops at the first that answers */
  {
    const { api, state } = setup((u) => {
      if (u === "wss://broken.example/wisp/") return "dead";
      if (u === RELAYS[0]) return "dead";          /* first candidate fails */
      return "ok";                                  /* relay-b answers */
    }, (url) => {
      state.stored = url;
      state.ctx.window.wispcraft.wispUrl = url;
      return Promise.resolve({ ok: true, relay: url });
    });
    state.ctx.window.wispcraft.wispUrl = "wss://broken.example/wisp/";
    state.stored = "wss://broken.example/wisp/";
    const res = await api("geo.minemen.club", 25565);
    check("sweep is sequential (never two sockets at once)", state.max === 1, `max concurrency ${state.max}`);
    check("sweep opens current, then candidates in order, and stops",
      state.log.join(",") === ["wss://broken.example/wisp/", RELAYS[0], RELAYS[1]].join(","), state.log.join(" "));
    check("the winner is applied through switchRelay", state.switched.length === 1 && state.switched[0] === RELAYS[1], state.switched.join(" "));
    check("result reports the switched relay", res && res.ok && res.switched === true && res.relay === RELAYS[1], JSON.stringify(res));
    check("the stored relay is the one now dialed", state.stored === RELAYS[1] && state.ctx.window.wispcraft.wispUrl === RELAYS[1], state.stored);
    check("the note names the relay the client dials",
      state.notes.some((n) => /switched to relay-b/.test(n) && /client dials relay-b/.test(n)), state.notes.join(" | "));
    check("relay-c/d/e are never probed", !state.log.some((u) => u === RELAYS[2] || u === RELAYS[3] || u === RELAYS[4]), state.log.join(" "));

    /* 3. same target again: served from the cache, no new sockets */
    const before = state.log.length;
    const again = await api("geo.minemen.club", 25565);
    check("a cached verdict does not probe again", state.log.length === before && again.relay === RELAYS[1], `${state.log.length} vs ${before}`);
  }

  /* 4. a refused switch is reported and the stored key is put back */
  {
    const { api, state } = setup((u) => (u === "wss://broken.example/wisp/" ? "dead" : (u === RELAYS[0] ? "ok" : "dead")),
      () => Promise.resolve({ ok: false, why: "no client" }));
    state.ctx.window.wispcraft.wispUrl = "wss://broken.example/wisp/";
    state.stored = "wss://broken.example/wisp/";
    const res = await api("geo.minemen.club", 25565);
    check("refused switch is not reported as success", res && res.ok === false && res.why === "switch refused", JSON.stringify(res));
    check("refused switch restores the stored relay", state.stored === "wss://broken.example/wisp/", state.stored);
    check("refused switch says so", state.notes.some((n) => /refused the switch/.test(n)), state.notes.join(" | "));
  }

  /* 5. nothing reachable: bounded sequential attempts, no switch */
  {
    const { api, state } = setup(() => "dead");
    state.ctx.window.wispcraft.wispUrl = "wss://broken.example/wisp/";
    state.stored = "wss://broken.example/wisp/";
    const res = await api("geo.minemen.club", 25565);
    check("unreachable target tries the current relay plus a bounded set", state.log.length === 5, `${state.log.length} probes`);
    check("unreachable target switches nothing", state.switched.length === 0 && res.ok === false, JSON.stringify(res));
    check("max concurrency is still one", state.max === 1, `max ${state.max}`);
  }

  /* 6. two concurrent checks for the same target share one sweep */
  {
    const { api, state } = setup((u) => (u === "wss://broken.example/wisp/" ? "dead" : "ok"), (url) => {
      state.stored = url; state.ctx.window.wispcraft.wispUrl = url;
      return Promise.resolve({ ok: true, relay: url });
    });
    state.ctx.window.wispcraft.wispUrl = "wss://broken.example/wisp/";
    state.stored = "wss://broken.example/wisp/";
    const [a, b] = await Promise.all([api("geo.minemen.club", 25565), api("geo.minemen.club", 25565)]);
    check("concurrent checks for one target share a sweep", state.log.length === 2 && state.switched.length === 1, `${state.log.length} sockets, ${state.switched.length} switches`);
    check("both callers get the same result", a === b, JSON.stringify([a, b]));
  }

  /* 7. the boot sweep is gone, and only the bundle's dial asks for a check */
  {
    const boot = html.slice(html.indexOf("function repairSavedServers()"), html.indexOf("window.wispcraftRepairSavedServers"));
    check("repairSavedServers no longer probes relays", !/ensureRelayReaches\s*\(/.test(boot), "boot block clean");
    check("the repair no longer references the undefined pairs list", !/\bpairs\b/.test(boot), "no `pairs`");
  }

  /* 8. the bundle carries both patches: a live switch, and a reach check for the join only */
  {
    const js = fs.readFileSync("wispcraft.js", "utf8");
    const switchAt = js.indexOf("A.switchRelay=");
    const body = switchAt < 0 ? "" : js.slice(switchAt, switchAt + 1200);
    check("bundle exports switchRelay", switchAt > 0, `${switchAt}`);
    check("switchRelay rebuilds the client and replaces the stream provider",
      /A\.wispUrl=want/.test(body) && /JA\(want\)/.test(body) && /replace_stream_provider\(\)/.test(body), body.slice(0, 80));
    check("switchRelay is serialised", /__relaySwitch/.test(body), "");
    check("switchRelay waits for the connections that are still opening",
      /__idle\(6000\)/.test(body) && /other connections are still opening/.test(body), "");
    check("switchRelay releases the held-back connects on every path",
      (body.match(/__releaseConnects\(\)/g) || []).length >= 2, `${(body.match(/__releaseConnects\(\)/g) || []).length} releases`);

    /* the java stream: open first, dial only once the first frame says ping or join */
    const fwd = js.indexOf("async forward(A,__onFail,__onDone){");
    const fwdBody = fwd < 0 ? "" : js.slice(fwd, fwd + 2600);
    check("the java stream dispatches open before it dials", /async forward\(A,__onFail,__onDone\)\{var __open=A;queueMicrotask\(/.test(js), "");
    check("open is delivered asynchronously, like a real socket", /queueMicrotask\(function\(\)\{try\{__open\(\)/.test(js), "");
    check("the dial is bounded by a timeout", /wispcraftDialTimeout/.test(fwdBody) && /Promise.race/.test(fwdBody), "");
    check("the frame wait is bounded too", /wispcraftFrameTimeout/.test(fwdBody), "");
    check("a failed dial is reported to the socket, not swallowed",
      /if\(!__g\)\{/.test(fwdBody) && /__onFail&&__onFail\(__bad\)/.test(fwdBody) && /__bad=e/.test(fwdBody), "");
    const failAt = js.indexOf("__fail(){");
    const failBody = failAt < 0 ? "" : js.slice(failAt, failAt + 320);
    check("that failure ends in error then close, not a silent open",
      failBody.indexOf('Event("error")') > 0 && failBody.indexOf('Event("error")') < failBody.indexOf('Event("close")'), failBody.slice(0, 60));
    const quietAt = js.indexOf("__quietClose(){");
    const quietBody = quietAt < 0 ? "" : js.slice(quietAt, quietAt + 320);
    check("the quiet close sends close only, once",
      quietAt > 0 && quietBody.indexOf('Event("error")') < 0 && quietBody.indexOf('CloseEvent("close")') > 0 &&
        quietBody.indexOf("WebSocket.CLOSED||this.readyState===WebSocket.CLOSING") > 0, quietBody.slice(0, 60));
    check("start() passes the failure callback to forward", /\.forward\(\(\)=>\{[^;]*\},\(\)=>this\.__fail\(\)/.test(js), "");
    /* a close nobody is sorry about: the client's own close, and a clean end of stream */
    check("start() also passes the quiet-close callback", /\.forward\(\(\)=>\{[^;]*\},\(\)=>this\.__fail\(\),\(\)=>this\.__quietClose\(\)\)/.test(js), "");
    check("a clean end of stream is reported as a quiet close",
      !/void __sf\(\)/.test(js) && (js.match(/void __done\(\)/g) || []).length === 2,
      `${(js.match(/void __done\(\)/g) || []).length} quiet ends`);
    const doneAt = js.indexOf("var __done=function(){");
    const doneBody = doneAt < 0 ? "" : js.slice(doneAt, doneAt + 280);
    check("a clean end names the address in the log once",
      /wispcraftNote\("java stream ended for "\+__t/.test(doneBody), doneBody.slice(0, 90));
    check("that note is skipped once the stream already failed or was closed",
      /!__self\.__wispQuiet&&!__self\.__wispFail&&window\.wispcraftNote/.test(doneBody) &&
        /__sf=function\(e\)\{if\(__self\.__wispQuiet\)return;__self\.__wispFail=1;/.test(js), doneBody.slice(0, 90));
    check("close() sends the event a real socket sends", /close\(\)\{this\.__quietClose\(\)\}/.test(js), "");
    check("the first frame classifies the socket",
      /send\(A\)\{var __f=typeof A==="string"&&"accept: motd"===A\.toLowerCase\(\)\?"motd":"data"/.test(js), "");
    /* the page resolver returns the record target as a string; the join must dial it, not the apex */
    check("the srv answer becomes the dial target, string form included",
      /__srv&&typeof __srv=="object"/.test(js) && /srv "\+this\.url\.hostname\+" -> "\+__srv/.test(js), "");
    check("the dial waits for that first frame",
      fwdBody.includes("__wispDialIntent") && fwdBody.includes("void 0===__self.__frame){await new Promise"), "");
    const reachAt = fwdBody.indexOf("window.wispcraftEnsureRelayReaches(__h,__p)");
    check("the reach check is skipped for a status ping",
      reachAt > 0 && /if\(__self\.__frame!=="motd"&&window\.wispcraftEnsureRelayReaches&&__h\)/.test(fwdBody), "");
    check("the join adds a reach check for the address actually being dialed",
      /__h=I\?I\.hostname:this\.url\.hostname/.test(fwdBody) && /__p=parseInt\(/.test(fwdBody), "");
    const dialAt = fwdBody.indexOf("connect_tcp(x)");
    check("the check and the switch run before the join's connect_tcp",
      reachAt > 0 && dialAt > reachAt, `reach ${reachAt}, dial ${dialAt}`);
    const enterAt = fwdBody.indexOf("__ns.__enterConnect");
    const leaveAt = fwdBody.indexOf("__ns.__leaveConnect");
    check("the dial is bracketed by the connect gate", enterAt > 0 && leaveAt > enterAt && dialAt > enterAt && dialAt < leaveAt,
      `enter ${enterAt}, dial ${dialAt}, leave ${leaveAt}`);
    check("a ping before the relay impl exists is replayed, not dropped",
      /__wantPing=1/.test(js) && /this\.impl=B,this\.__wantPing&&\(this\.__wantPing=0,this\.ping\(\)\)/.test(js), "");
  }

});
