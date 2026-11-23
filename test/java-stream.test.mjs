/**
 * Runs the patched code straight out of wispcraft.js (class VI, class WI and the patch-8 gate block)
 * in a vm, with the relay dial stubbed, to prove:
 *   1. a Multiplayer status ping never asks for the reach check;
 *   2. a join asks for it once, for the address it dials, before connect_tcp;
 *   3. the join's dial is bracketed by the connect gate;
 *   4. switchRelay refuses while a connect is open and rebuilds nothing;
 *   5. once the connects drain, the same switch rebuilds the client;
 *   6. a connect that arrives during a switch is held, then released;
 *   7. open reaches a listener that attaches after the constructor, and a failed dial ends in
 *      error then close rather than a socket that looks connected forever;
 *   8. a stream that fails *after* a successful dial - the relay accepted the stream but the target
 *      refused or dropped it - ends the socket the same way, as does the connected-stream setup
 *      throwing and the socket's own outbound read loop throwing;
 *   9. a close nobody is sorry about stays quiet: the client hanging up, and a stream that simply
 *      ends, give exactly one close event and no error (a clean end-of-stream used to be reported as
 *      an error, and close() used to send no event at all).
 *
 * The classes and the gate block are cut out of the shipped wispcraft.js, so this drives the code the
 * browser runs rather than a copy of it. Run with: node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const js = fs.readFileSync("wispcraft.js", "utf8");
/* every point is an assertion: the message names the check, the detail reports what was seen */
const check = (name, ok, detail) => assert.ok(ok, name + (detail ? ` [${detail}]` : ""));

function sliceClass(start) {
  let i = js.indexOf(start);
  if (i < 0) throw new Error("missing " + start);
  let depth = 0, j = js.indexOf("{", i);
  for (let k = j; k < js.length; k++) {
    const c = js[k];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return js.slice(i, k + 1); }
  }
  throw new Error("unterminated " + start);
}

const VI = sliceClass("class VI extends EventTarget");
const WI = sliceClass("class WI{");
const gateFrom = js.indexOf("A.__connects=0,A.__idleWaiters=[]");
const gateTo = js.indexOf("A.setWispUrl=TI,");
const gate = js.slice(gateFrom, gateTo);
if (gateFrom < 0 || gateTo < 0 || !gate.includes("A.switchRelay=function(url){")) {
  throw new Error("could not extract the gate block");
}

/* a readable that never yields: the stream loops then park instead of spinning */
const NEVER = { read: () => new Promise(() => {}), getReader() { return this; } };

function makeCtx() {
  const log = [];
  const ctx = {
    notes: [],
    log,
    reach: [],
    connects: 0,
    connectSeq: 0,
    /* a minimal stand-in for the two stream pairs WI builds; the first pair feeds the socket's own
       outbound loop, which is another place a post-connect failure can surface */
    tI: () => [
      ctx.outReadFails
        ? { getReader: () => ({ read: () => Promise.reject(new Error("eaglerOut read failed")), getReader() { return this; } }) }
        : { getReader: () => NEVER },
      { getWriter: () => ({ write: () => Promise.resolve(), abort() {}, close: () => Promise.resolve() }) },
    ],
    tA: class {
      constructor(u) { this.inner = u; }
      static new() { return { length: 0, writeVarInt() {}, extend() {}, readVarInt() { return 0; }, take() { return {}; } }; }
    },
    dI: class {
      constructor() {
        /* the real one reads epoxyclientoptions; if it throws, forward() would reject silently */
        if (ctx.implThrows) throw new TypeError("Cannot read properties of undefined (reading 'epoxyclientoptions_new_default')");
        this.compressor = { transform: async (v) => v };
        this.decompressor = { transform: async (v) => v };
        this.decryptor = { transform: new TransformStream() };
        this.encryptor = { transform: new TransformStream() };
      }
      ping() { globalThis.__implPings = (globalThis.__implPings || 0) + 1; }
      eaglerRead() { return new Promise(() => {}); }
      epoxyRead() { return new Promise(() => {}); }
    },
    nA: (x) => x,
    WA: () => ({ getWriter: () => ({ write: () => Promise.resolve() }) }),
    LA: async () => ({ json: async () => ({}) }),
    fI: {},
    URL, Uint8Array, Promise, JSON, Object, Array, String, Number, Date, console, TransformStream, performance,
    setTimeout, clearTimeout, parseInt, Math, Error, queueMicrotask,
    EventTarget, Event,
    /* Node's EventTarget rejects anything that is not a real Event, so the bundle's events must be too */
    MessageEvent: globalThis.MessageEvent || class extends Event { constructor(t, o) { super(t); this.data = o && o.data; } },
    CloseEvent: globalThis.CloseEvent || class extends Event { constructor(t) { super(t); } },
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    localStorage: { getItem: () => null, setItem() {} },
  };
  ctx.SA = Promise.resolve();
  ctx.yA = null;
  ctx.jaDelay = 0;
  /* a stream this test settles later, so the socket can be closed while its loops are still reading */
  ctx.streamLater = false;
  ctx.JA = (w) => { log.push("init:" + w); setTimeout(() => ctx.yA && ctx.yA(w), ctx.jaDelay); };
  ctx.KA = {
    replace_stream_provider: async () => { log.push("replace_stream_provider"); },
    connect_tcp: async (addr) => {
      const n = ++ctx.connectSeq;
      log.push("connect_tcp:" + addr);
      /* a relay that accepts the stream and then never answers: no timer, so the test leaves no handle */
      if (ctx.dialHangs) return new Promise(() => {});
      await new Promise((r) => setTimeout(r, 20));
      if (ctx.failDial) throw new Error("Wisp destination host could not be reached (code 1006)");
      log.push("connect_done:" + n);
      /* the relay accepted the stream; what happens behind it decides whether the join lives */
      /* the bundle calls getReader(), wraps the reader, then calls getReader() again on the result */
      const reader = (read) => ({ read, getReader() { return this; } });
      const later = ctx.streamLater
        ? new Promise((res, rej) => {
            ctx.settleStream = (how) => (how === "end" ? res({ done: true }) : rej(new Error("stream reset by relay (code 1006)")));
          })
        : null;
      const leaf = ctx.streamFails
        ? { getReader: () => reader(() => Promise.reject(new Error("stream reset by relay (code 1006)"))) }
        : ctx.streamEnds
          ? { getReader: () => reader(() => Promise.resolve({ done: true })) }
          : later
            ? { getReader: () => reader(() => later) }
            : NEVER;
      return {
        write: { getWriter: () => ({ write: () => Promise.resolve() }) },
        read: { pipeThrough: () => ({ pipeThrough: () => ({ pipeThrough: () => ({ pipeThrough: () => leaf }) }) }) },
      };
    },
  };
  ctx.window = {
    wispcraftEnsureRelayReaches: (h, p) => {
      log.push("reach:" + h + ":" + p);
      ctx.reach.push(h + ":" + p);
      if (ctx.reachRejects) return Promise.reject(new Error("probe failed"));
      return new Promise((r) => setTimeout(() => { log.push("reach_done"); r({ ok: true }); }, 15));
    },
    wispcraftNote(m) { ctx.notes.push(String(m)); },
    wispcraft: {
      __enterConnect: () => { log.push("enter"); ctx.connects++; return Promise.resolve(); },
      __leaveConnect: () => { log.push("leave"); ctx.connects--; },
    },
  };
  ctx.wispcraft = ctx.window.wispcraft;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(VI + "\n" + WI + "\n;globalThis.__VI=VI;", ctx);
  return ctx;
}

function openSocket(ctx) {
  const ws = new ctx.__VI("java://java://geo.test.example:25565");
  ctx.events = [];
  ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => { ctx.events.push(t); ctx.log.push(t); }));
  ws.start();
  return ws;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("java stream: a ping is not probed, a join is, and a failed dial closes the socket", async () => {
  /* 1. a status ping */
  {
    const ctx = makeCtx();
    const ws = openSocket(ctx);
    /* forward() must dispatch open itself. It used to be called from inside the SRV try block, where
       the parameter is shadowed by the const A = await LA(...) declaration, so the call died in the
       temporal dead zone and the event never fired at all. */
    /* open is delivered in a microtask, the way a real socket delivers it: WI.start() runs inside
       the proxy's constructor, so a synchronous dispatch would reach no listener at all */
    await sleep(10);
    check("open is dispatched before the dial", ctx.events.join(",") === "open", ctx.events.join(",") || "no events");
    check("the socket is open at that point", ws.readyState === 1, String(ws.readyState));
    ws.send("accept: motd");
    await sleep(200);
    check("a status ping asks for no reach check", ctx.reach.length === 0, ctx.reach.join(" ") || "none");
    check("a status ping still dials the relay", ctx.log.some((l) => l.startsWith("connect_tcp:")), ctx.log.join(" "));
    check("its frame is recorded as motd", ws.inner.__frame === "motd", String(ws.inner.__frame));
  }

  /* 2./3. a join */
  {
    const ctx = makeCtx();
    const ws = openSocket(ctx);
    await sleep(10);
    check("a join also gets its open event before the dial", ctx.events.join(",") === "open", ctx.events.join(",") || "no events");
    ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
    await sleep(200);
    check("the successful dial leaves the socket open", ws.readyState === 1 && ctx.events.join(",") === "open", ctx.events.join(","));
    check("a join asks for the reach check once", ctx.reach.length === 1, ctx.reach.join(" "));
    check("it names the host and port being dialed", ctx.reach[0] === "geo.test.example:25565", ctx.reach[0] || "");
    const reachAt = ctx.log.indexOf("reach:geo.test.example:25565");
    const dialAt = ctx.log.findIndex((l) => l.startsWith("connect_tcp:"));
    check("the check runs before the dial", reachAt >= 0 && dialAt > reachAt, ctx.log.join(" "));
    check("the dial waits for the check to finish", ctx.log.indexOf("reach_done") < dialAt, ctx.log.join(" "));
    const enterAt = ctx.log.indexOf("enter");
    const leaveAt = ctx.log.indexOf("leave");
    check("the dial is inside the connect gate", enterAt >= 0 && dialAt > enterAt && leaveAt > dialAt, ctx.log.join(" "));
    check("open was dispatched before that dial", ctx.log.indexOf("open") >= 0 && ctx.log.indexOf("open") < dialAt, ctx.log.join(" "));
  }

  /* a dial that never connects must not leave the socket looking connected */
  {
    const ctx = makeCtx();
    ctx.failDial = true;
    const events = [];
    const ws = new ctx.__VI("java://java://geo.test.example:25565");
    ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => events.push(t)));
    ws.start();
    ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
    await sleep(300);
    check("a failed dial reports error then close, after the open it already sent",
      events.join(",") === "open,error,close", events.join(",") || "no events");
    check("the socket ends closed, not left open", ws.readyState === 3, String(ws.readyState));
    check("the failure is noted for the player",
      ctx.notes.some((n) => /dial failed for geo.test.example:25565/.test(n) && /1006/.test(n)), ctx.notes.join(" | "));
    check("it did not reach the post-connect wiring", !ctx.log.some((l) => l === "leave" && false), "");
  }

  /* a relay that accepts the stream and then never answers must not leave the socket open forever */
  {
    const ctx = makeCtx();
    ctx.dialHangs = true;
    ctx.window.wispcraftDialTimeout = 120;      /* the launcher override, so the test is quick */
    const events = [];
    const ws = new ctx.__VI("java://java://geo.test.example:25565");
    ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => events.push(t)));
    ws.start();
    ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
    await sleep(400);
    check("a dial that never settles times out into error then close",
      events.join(",") === "open,error,close", events.join(",") || "no events");
    check("the timed-out socket ends closed", ws.readyState === 3, String(ws.readyState));
    check("the note names the bound",
      ctx.notes.some((n) => /dial failed for geo.test.example:25565/.test(n) && /within 120 ms/.test(n)), ctx.notes.join(" | "));
    check("the connect gate was released on timeout", ctx.connects === 0 && ctx.log.includes("leave"), ctx.log.join(" "));
  }

  /* a socket that never sends a frame is still bounded: it becomes a join, not an endless wait */
  {
    const ctx = makeCtx();
    ctx.window.wispcraftFrameTimeout = 100;
    const ws = openSocket(ctx);
    await sleep(10);
    await sleep(300);
    check("the frame wait is bounded and falls through to the dial",
      ctx.log.some((l) => l.startsWith("connect_tcp:")), ctx.log.join(" "));
    check("the frameless socket is treated as a join", ctx.reach.length === 1, ctx.reach.join(" ") || "none");
    check("and the socket stays open while the dial succeeds", ws.readyState === 1 && ctx.events.join(",") === "open", ctx.events.join(","));
  }

  /* the same when the launcher's probe itself throws */
  {
    const ctx = makeCtx();
    ctx.failDial = true;
    ctx.reachRejects = true;
    const events = [];
    const ws = new ctx.__VI("java://java://geo.test.example:25565");
    ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => events.push(t)));
    ws.start();
    ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
    await sleep(300);
    check("a throwing reach check still dials, and a failed dial still closes the socket",
      events.join(",") === "open,error,close", events.join(",") || "no events");
  }

  /* a dial that succeeds is not a connection: the target is dialled behind it, and a refusal or a
     drop arrives on the stream after open. Each of these used to end as an unhandled rejection on a
     socket that stayed at open with no error and no close. */
  for (const [name, setup, why] of [
    ["a stream that errors after a successful dial", (c) => { c.streamFails = true; }, /stream reset by relay/],
    ["the connected-stream setup throwing", (c) => { c.implThrows = true; }, /epoxyclientoptions_new_default/],
    ["the socket's own outbound read throwing", (c) => { c.outReadFails = true; }, /eaglerOut read failed/],
  ]) {
    const ctx = makeCtx();
    setup(ctx);
    const events = [];
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
    let ws;
    process.on("unhandledRejection", onUnhandled);
    try {
      ws = new ctx.__VI("java://java://geo.test.example:25565");
      ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => events.push(t)));
      ws.start();
      ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
      await sleep(300);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    check(`${name} ends the socket with error then close`,
      events.join(",") === "open,error,close", events.join(",") || "no events");
    check(`${name} leaves the socket closed`, ws.readyState === 3, String(ws.readyState));
    check(`${name} is reported to the player`,
      ctx.notes.some((n) => /java stream failed after connect/.test(n) && why.test(n)), ctx.notes.join(" | ") || "no notes");
    check(`${name} leaves no unhandled rejection`, unhandled.length === 0, unhandled.join(" | "));
    check(`${name} releases the connect gate`, ctx.connects === 0 && ctx.log.includes("leave"), ctx.log.join(" "));
  }

  /* 9. a close nobody is sorry about. A stream that ENDS is the ordinary end of a session, not a
     failure: it used to go through patch 10's reporter and reach the game as `error` then `close`.
     It is now one quiet close, with no failure note. */
  {
    const ctx = makeCtx();
    ctx.streamEnds = true;
    const events = [];
    const ws = new ctx.__VI("java://java://geo.test.example:25565");
    ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => events.push(t)));
    ws.start();
    ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
    await sleep(300);
    check("a clean end-of-stream ends the socket with one close and no error",
      events.join(",") === "open,close", events.join(",") || "no events");
    check("the clean end leaves the socket closed", ws.readyState === 3, String(ws.readyState));
    check("a clean end is not reported as a stream failure",
      !ctx.notes.some((n) => /java stream failed after connect/.test(n)), ctx.notes.join(" | ") || "no notes");
    check("the clean end releases the connect gate", ctx.connects === 0 && ctx.log.includes("leave"), ctx.log.join(" "));
  }

  /* and a client-initiated close sends the close event the game is waiting for - it used to send none
     at all - while the read loops that are still running wind up without a second event or a note. */
  for (const [name, settle] of [
    ["the client closing a join it had opened", "reject"],
    ["the client closing before its read loops end", "end"],
  ]) {
    const ctx = makeCtx();
    ctx.streamLater = true;
    const events = [];
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(String((e && e.message) || e));
    let ws;
    process.on("unhandledRejection", onUnhandled);
    try {
      ws = new ctx.__VI("java://java://geo.test.example:25565");
      ["open", "error", "close"].forEach((t) => ws.addEventListener(t, () => events.push(t)));
      ws.start();
      ws.send(new Uint8Array([6, 0, 4, 9, 1, 2, 3]).buffer);
      await sleep(200);
      check(`${name}: the join is open before the close`,
        ws.readyState === 1 && events.join(",") === "open", events.join(",") || "no events");
      ws.close();
      await sleep(100);
      /* the loops are still reading; the stream settles only after the socket was closed */
      ctx.settleStream(settle);
      await sleep(200);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    check(`${name} sends exactly one close and no error`,
      events.join(",") === "open,close", events.join(",") || "no events");
    check(`${name} leaves the socket closed`, ws.readyState === 3, String(ws.readyState));
    check(`${name} reports nothing as a stream failure`,
      !ctx.notes.some((n) => /java stream failed after connect|relay dial failed/.test(n)),
      ctx.notes.join(" | ") || "no notes");
    check(`${name} leaves no unhandled rejection`, unhandled.length === 0, unhandled.join(" | "));
    check(`${name} releases the connect gate`, ctx.connects === 0 && ctx.log.includes("leave"), ctx.log.join(" "));
    /* a second close is still not an event: a real socket reports the close once */
    ws.close();
    await sleep(50);
    check(`${name} does not close twice`, events.filter((t) => t === "close").length === 1, events.join(","));
  }

  /* 4.-6. the switch gate, running patch 8's own code */
  {
    const ctx = makeCtx();
    const A = { wispUrl: "wss://old.example/wisp/", setWispUrl: (u) => { A.wispUrl = u; } };
    ctx.__A = A;
    vm.runInContext("var A=__A;" + gate, ctx);

    A.__connects = 1;
    const t0 = Date.now();
    const refused = await A.switchRelay("wss://new.example/wisp/");
    check("a switch is refused while a connect is open",
      refused && refused.ok === false && refused.why === "other connections are still opening", JSON.stringify(refused));
    check("it waited for the open connects, then gave up", Date.now() - t0 >= 5500, `${Date.now() - t0} ms`);
    check("a refused switch rebuilds nothing",
      !ctx.log.some((l) => l.startsWith("init:") || l === "replace_stream_provider") && A.wispUrl === "wss://old.example/wisp/",
      ctx.log.join(" "));

    A.__connects = 0;
    const ok = await A.switchRelay("wss://new.example/wisp/");
    check("once they drain, the switch rebuilds the client",
      ok && ok.ok === true && ctx.log.includes("init:wss://new.example/wisp/") && ctx.log.includes("replace_stream_provider"),
      JSON.stringify(ok));
    check("the client's relay really changed", A.wispUrl === "wss://new.example/wisp/", A.wispUrl);

    /* a connect that arrives mid-switch is held, then released */
    ctx.log.length = 0;
    let entered = false;
    A.__connects = 0;
    ctx.jaDelay = 100;                 /* keep the rebuild in flight while the connect arrives */
    const sw = A.switchRelay("wss://third.example/wisp/");
    await sleep(10);
    const enter = A.__enterConnect().then(() => { entered = true; });
    await sleep(20);
    const heldDuringSwitch = entered === false;
    await sw;
    await enter;
    check("a connect that arrives during a switch waits for it", heldDuringSwitch && entered, `held during the switch: ${heldDuringSwitch}`);
  }

});
