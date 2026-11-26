/**
 * Guards the launch decision in index.html - the part that decides whether the game is handed the
 * tab immediately or after a relay test. The page has no module system, so the controller script is
 * cut out of index.html and run in a vm with a fake DOM, storage and WispRelays.
 *
 * What it pins down:
 *   - a pass this browser recorded for the relay in use is trusted and costs no socket;
 *   - a fresh browser tests the relay and remembers the pass;
 *   - a verdict for another relay, an expired verdict, or one that could not sign in while the
 *     player is signed out is not trusted;
 *   - a failed test is not remembered, and one working relay is asked for instead of the whole
 *     sweep - that wait is what the player sees as a black screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const CONTROLLER = scripts[scripts.length - 1];
assert.ok(
  /WispRelays/.test(CONTROLLER) && /location\.replace/.test(CONTROLLER),
  "the last inline script is the launch controller, not a block added after it",
);
const RELAY = "wss://relay.example/wisp/";
const OTHER = "wss://other.example/wisp/";
const VERDICT = "wispcraft_relay_check";

/** Timers are unref'd so a 9 s hard stop cannot keep the test process alive. */
function timer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle.unref) handle.unref();
  return handle;
}

function run({ store = {}, current = RELAY, probeResult, bestResult = null } = {}) {
  const data = { ...store };
  const navigations = [];
  const probes = [];
  const best = [];
  const saved = [];
  const hint = { textContent: "" };

  const relays = {
    DEFAULT: RELAY,
    current: () => current,
    set: (url) => { saved.push(url); return url; },
    probe: (url, timeout) => {
      probes.push({ url, timeout });
      return Promise.resolve(probeResult || { url, ok: true, signin: true, ms: 120 });
    },
    probeBest: (timeout, grace, needsSignin) => {
      best.push({ timeout, grace, needsSignin });
      return Promise.resolve(bestResult);
    },
  };

  const sandbox = {
    window: { WispRelays: relays },
    atob,
    document: { getElementById: () => hint },
    location: { replace: (target) => { navigations.push(target); } },
    localStorage: {
      getItem: (key) => (key in data ? data[key] : null),
      setItem: (key, value) => { data[key] = String(value); },
      removeItem: (key) => { delete data[key]; },
    },
    setTimeout: timer,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(CONTROLLER, sandbox, { filename: "index.html" });
  return { navigations, probes, best, saved, data, hint };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const pass = (url = RELAY, at = Date.now(), signin = true) =>
  JSON.stringify({ url, ok: true, signin, at });

test("a relay this browser passed already is trusted without opening a socket", async () => {
  const run09 = run({ store: { [VERDICT]: pass() } });
  await settle();
  assert.deepEqual(run09.navigations, ["play.html"], "the game is handed the tab");
  assert.equal(run09.probes.length, 0, "no probe on a fresh pass");
});

test("a fresh browser tests the relay and remembers the pass", async () => {
  const started = run({});
  await settle();
  assert.equal(started.probes.length, 1, "one probe");
  assert.deepEqual(started.navigations, ["play.html"]);
  assert.equal(JSON.parse(started.data[VERDICT]).url, RELAY, "the pass is recorded for the relay used");
});

test("a pass recorded for another relay is not trusted", async () => {
  const changed = run({ store: { [VERDICT]: pass(OTHER) } });
  await settle();
  assert.equal(changed.probes.length, 1, "switching relay in game earns a fresh test");
  assert.deepEqual(changed.navigations, ["play.html"]);
});

test("a pass older than ten minutes is not trusted", async () => {
  const old = run({ store: { [VERDICT]: pass(RELAY, Date.now() - 11 * 60 * 1000) } });
  await settle();
  assert.equal(old.probes.length, 1);
});

test("a pass that could not sign in is not trusted while the player is signed out", async () => {
  const signedOut = run({ store: { [VERDICT]: pass(RELAY, Date.now(), false) } });
  await settle();
  assert.equal(signedOut.probes.length, 1, "sign-in would fail through that relay");
});

test("a signed-in player does not need the sign-in test to pass", async () => {
  const signedIn = run({
    store: {
      wispcraft_accounts: JSON.stringify([{ username: "someone", token: "t" }]),
      [VERDICT]: pass(RELAY, Date.now(), false),
    },
  });
  await settle();
  assert.equal(signedIn.probes.length, 0, "the cached pass is enough to launch");
  assert.deepEqual(signedIn.navigations, ["play.html"]);
});

test("an account whose token has expired counts as signed out", async () => {
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const expired = `${b64u({ alg: "none" })}.${b64u({ exp: Math.floor(Date.now() / 1000) - 3600 })}.sig`;
  const run09 = run({
    store: {
      wispcraft_accounts: JSON.stringify([{ username: "someone", token: expired }]),
      [VERDICT]: pass(RELAY, Date.now(), false),
    },
  });
  await settle();
  assert.equal(run09.probes.length, 1, "an expired token cannot sign in, so the relay must be able to");
});

test("a failed test is not remembered and one working relay is found", async () => {
  const failed = run({
    store: { [VERDICT]: pass(OTHER) },
    probeResult: { url: RELAY, ok: false, signin: false, ms: 900 },
    bestResult: { url: OTHER, ok: true, signin: true, ms: 300 },
  });
  await settle();
  assert.equal(failed.probes.length, 1, "the saved relay was tested");
  assert.equal(failed.best.length, 1, "and one relay that can carry the session was asked for");
  assert.equal(failed.best[0].needsSignin, true, "signed out, so it must complete the handshake");
  assert.deepEqual(failed.saved, [OTHER], "the working relay is saved");
  assert.equal(JSON.parse(failed.data[VERDICT]).url, OTHER, "its pass is recorded");
  assert.deepEqual(failed.navigations, ["play.html"]);
});

test("no relay answering still launches, without saving anything", async () => {
  const none = run({ probeResult: { url: RELAY, ok: false, signin: false, ms: 400 } });
  await settle();
  assert.deepEqual(none.best, [{ timeout: 3000, grace: 500, needsSignin: true }], "one bounded search");
  assert.deepEqual(none.saved, [], "nothing to save");
  assert.deepEqual(none.navigations, ["play.html"], "the game still starts");
});

test("a pinned server still launches when its row cannot be written", async () => {
  /* no fetch and no indexedDB in this sandbox, so the SRV lookup throws before the write: that must
     end in the hand-off, not in a launch held by a promise that was never made */
  const pinned = run({ store: { wispcraft_pinned_java: "blocksmc.com" } });
  await settle();
  assert.deepEqual(pinned.navigations, ["play.html"], "the game is handed the tab");
});

test("a recent pass never starts the search", async () => {
  const cached = run({ store: { [VERDICT]: pass() } });
  await settle();
  assert.equal(cached.best.length, 0, "a passed relay costs neither a probe nor a search");
});
