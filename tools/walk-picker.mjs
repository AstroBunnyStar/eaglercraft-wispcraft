#!/usr/bin/env node
/**
 * Drives the launcher pick and the client that reads it, in one browser, end to end.
 *
 * Why this exists: the writer's contract (parse, write back, require the file byte-identical, then
 * append a Wisp row) is covered by test/servers-dat.test.mjs against fixtures, but nothing in the
 * suite proves a real pick reaches the client's own database and shows up in Multiplayer. That was
 * checked by hand, once, with a throwaway script; this is that walk, kept where a change to the
 * launcher will trip over it.
 *
 * What it does, on a brand-new browser profile (so servers.dat is deterministically absent):
 *   1. boots play.html until the client creates its PlatformFilesystem database;
 *   2. opens index.html?servers=1, clicks Play on the first directory row (BlocksMC), and reads the
 *      note the launcher shows before handing the tab over;
 *   3. reads servers.dat back out of the client's database and checks the row it asked for;
 *   4. boots the client on that list, walks Multiplayer -> row -> Join, and saves a screenshot of
 *      every step.
 * Steps 1-3 are asserted. Step 4 is driven and photographed, not asserted: the client paints its
 * menus on a canvas, so "the row shows a live status" and "the player is in world" are for a human
 * to look at in the saved frames (see the step table it prints). That split is also why --check is
 * static: the launcher contract can be checked on every push, the canvas walk cannot.
 *
 * servers.dat is read as latin1 text here and the assertions look for the row's own strings. Parsing
 * it again would mean a third copy of the reader whose agreement with the client the unit tests
 * already establish; the question this tool answers is only whether a real pick reaches the file.
 *
 * Usage:
 *   node tools/walk-picker.mjs          # the whole walk, frames in .tmp/walk
 *   node tools/walk-picker.mjs --check  # the contract the walk relies on, no browser
 *
 * The temporary browser profile is deleted when the walk passes. When it fails, or dies before it
 * can assert anything, the profile is left in place and its path printed: the client's database,
 * its console output and whatever the last frame showed are then there to inspect rather than to
 * reproduce from scratch.
 *
 * CHROME may name the browser binary; otherwise the common paths are tried.
 *
 * Exit codes: 0 everything the tool asserts passed (or --check found no misses), 1 an assertion
 * failed or a contract check missed, 2 the environment is unusable (no Chrome, no CDP, no server).
 *
 * The client half clicks the 1.8 menu by coordinate, measured at a 900x1000 viewport with the
 * client's own GUI scale. If a client rebuild moves those buttons the screenshots show it and the
 * STEPS table below is where the coordinates get updated; the launcher half needs no coordinates,
 * because the picker is real DOM.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const checkOnly = process.argv.includes("--check");
const OUT = path.join(ROOT, ".tmp/walk");
/* the client paints its loader, then its menu; the menu is up well inside this on a warm machine
   and the canvas half is photographed anyway, so a slow boot costs frames, not a false pass */
const BOOT_WAIT = 90000;

/* ---- the canvas-side steps, measured on Eaglercraft 26.3 at 900x1000 --------------------- */
const STEPS = {
  closePanel: [748, 130],   /* the Wispcraft panel's X, over the first-run screens */
  profileDone: [438, 505],  /* Edit Profile -> Done, which a fresh profile always lands on */
  guestName: [438, 513],    /* "Default Username Detected" -> Do not show this again */
  multiplayer: [438, 388],  /* main menu */
  proceed: [280, 578],      /* Caution: Third-Party Online Play -> Proceed */
  row2: [438, 197],         /* our row: the client injects its own ArchMC entry as the first row */
  join: [230, 816],         /* Join Server */
};

/* ---------------------------------------------------------------- contract (--check) */
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

function databaseName(source) {
  const m = /_net_lax1dude_[A-Za-z0-9_]*PlatformFilesystem_1_8_8_worlds/.exec(source);
  return m ? m[0] : null;
}

function contract() {
  const html = read("index.html");
  const page = read("play.html");
  const ids = ["servers", "host", "join", "list", "picksay", "plain"];
  const notes = {
    added: /added to your server list as a Wisp entry for/,
    updated: /in your server list now joins as a Wisp entry for/,
    noList: /has no server list yet, so /,
    unreadable: /could not read your server list, so /,
  };
  const checks = [
    ["picker markup", ids.every((id) => html.includes(`id="${id}"`))],
    ["?servers=1 hold", /\[\?&\]servers\(=1\|=\|&\|\$\)/.test(html)],
    ["server-list markers", html.includes("/* <server-list> */") && html.includes("/* </server-list> */")],
    ["four notes", Object.values(notes).every((re) => re.test(html))],
    ["wisp row shape", html.includes('"eagler-wisp:"') && html.includes('"?target="')],
    ["srv cache", html.includes('"wispcraft_srv_cache"')],
    ["pick is written before the hand-off", /installRow\(host\)/.test(html) && /location\.replace\(GAME\)/.test(html)],
    ["the first directory row is BlocksMC", /name: "BlocksMC", host: "blocksmc\.com"/.test(html)],
    ["launcher and client share one database", !!databaseName(html) && databaseName(html) === databaseName(page)],
    ["play.html carries the srv hook", page.includes("proto.__wispcraftSrv = 1;")],
  ];
  let misses = 0;
  for (const [what, ok] of checks) {
    console.log(ok ? `[ok]   ${what}` : `[miss] ${what}`);
    if (!ok) misses++;
  }
  console.log(
    misses
      ? `\n[fail] ${misses} contract check(s) missed: the walk's assumptions no longer hold`
      : `\n[check] the walk's assumptions hold (${checks.length} checks)`
  );
  return misses === 0;
}

/* ---------------------------------------------------------------- the browser half */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".epk": "application/octet-stream",
  ".png": "image/png",
  ".json": "application/json",
};

function serve() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end("not found"); return; }
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

async function launch(chrome, profile) {
  /* A short profile path matters on Windows: Chrome's IndexedDB files under a deep checkout can
     pass MAX_PATH, and the browser then refuses every database with "Internal error opening
     backing store" - which looks exactly like the client never writing its list. */
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=900,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", () => {});
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
      if (port) return { child, port };
    } catch (e) { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  return { child, port: 0 };
}

function connect(port) {
  return new Promise(async (resolve, reject) => {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
        target = pages[0];
      } catch (e) { /* not listening yet */ }
      if (!target) await new Promise((r) => setTimeout(r, 200));
    }
    if (!target) return reject(new Error("no page target"));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const logs = [];
    const send = (method, params = {}) => new Promise((res, rej) => {
      const n = ++id;
      pending.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        logs.push((msg.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(" "));
      }
    };
    ws.onerror = () => reject(new Error("cdp connect failed"));
    ws.onopen = () => resolve({ ws, send, logs });
  });
}

async function walk(chrome) {
  const problems = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wispcraft-walk-"));
  let server = null, child = null, ws = null, send = null, logs = [], base = "";
  let died = false;
  /* a failed walk keeps its state: the profile is the only copy of what the client wrote, so it is
     left on disk (and named) whenever the walk dies, and removed only once everything passed */
  const cleanup = () => {
    try { if (ws) ws.close(); } catch (e) {}
    /* SIGKILL on Windows is TerminateProcess, which releases the profile's files at once */
    try { if (child) child.kill("SIGKILL"); } catch (e) {}
    try { if (server) server.close(); } catch (e) {}
    if (died || problems.length) { console.log(`  profile kept at ${profile}`); return; }
    /* Chrome's helpers can hold files for a moment after the kill, so a locked delete is retried */
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (...a) => console.log(...a);
  fs.mkdirSync(OUT, { recursive: true });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 300);
    return r.result && r.result.value;
  };
  let frame = 0;
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `${String(++frame).padStart(2, "0")}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    say(`  frame ${path.relative(ROOT, file)}`);
  };
  const click = async (x, y, wait = 900) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(wait);
  };
  const nav = async (url) => { say(`  -> ${url}`); await send("Page.navigate", { url }); await sleep(1500); };

  /* poll a page-side condition; a timeout is a problem the caller does not have to report again */
  const until = async (what, check, timeoutMs) => {
    const t0 = Date.now();
    for (;;) {
      if (await check()) return true;
      if (Date.now() - t0 > timeoutMs) {
        problems.push(`${what} (gave up after ${Math.round(timeoutMs / 1000)}s)`);
        return false;
      }
      await sleep(2000);
    }
  };
  const hasFilesystem = async () => {
    const dbs = await evaluate("indexedDB.databases ? indexedDB.databases().then(l => l.map(d => d.name)) : []");
    const found = Array.isArray(dbs) && dbs.some((n) => String(n).includes("PlatformFilesystem_1_8_8_worlds"));
    if (found) say("  client filesystem present");
    return found;
  };

  /* the client's servers.dat as latin1 text: every string a pick writes is ASCII, and the row's
     encoding itself is test/servers-dat.test.mjs's subject, not this tool's */
  const DB = databaseName(read("index.html"));
  const listText = () => evaluate(`(async () => {
    const open = await new Promise((res, rej) => { const o = indexedDB.open(${JSON.stringify(DB)}); o.onerror = () => rej(o.error); o.onsuccess = () => res(o.result); });
    const recs = await new Promise((res) => {
      const out = [];
      const r = open.transaction("filesystem", "readonly").objectStore("filesystem").openCursor();
      r.onsuccess = (e) => { const c = e.target.result; if (!c) return res(out); out.push(c.value); c.continue(); };
      r.onerror = () => res(out);
    });
    open.close();
    const rec = recs.find((v) => v && v.path && /servers\\.dat$/.test(String(v.path)) && String(v.path).indexOf("_old") < 0);
    if (!rec) return null;
    const d = rec.data, b = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer || d);
    return new TextDecoder("latin1").decode(b);
  })().catch((e) => "ERR " + e)`);

  try {
    server = await serve();
    base = `http://127.0.0.1:${server.address().port}`;
    const launched = await launch(chrome, profile);
    child = launched.child;
    if (!launched.port) throw new Error("Chrome never reported a debugging port");
    const connection = await connect(launched.port);
    ws = connection.ws;
    send = connection.send;
    logs = connection.logs;

    await send("Runtime.enable", {});
    await send("Page.enable", {});

    /* 1 ---- the client boots once, so its filesystem exists and the launcher has a list to write */
    say("[1] boot the client");
    await nav(`${base}/play.html`);
    if (!(await until("the client never created its filesystem", hasFilesystem, 180000))) return problems;

    /* 2 ---- the picker, on a page that is real DOM: no coordinates needed */
    say("[2] pick BlocksMC");
    await nav(`${base}/index.html?servers=1`);
    await shot("picker");
    const play = await evaluate(`(() => {
      const button = [...document.querySelectorAll("#list button")].find((b) => b.textContent === "Play");
      if (!button) return null;
      const row = button.closest(".row"), r = button.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
        name: (row.querySelector(".name") || {}).textContent, host: (row.querySelector(".ip") || {}).textContent };
    })()`);
    if (!play || typeof play !== "object") {
      problems.push("the picker has no Play button (#list .row button)");
      return problems;
    }
    say(`  row: ${play.name} (${play.host})`);
    if (play.host !== "blocksmc.com") problems.push(`the first row is ${play.host}, not blocksmc.com`);
    logs.length = 0;
    await click(play.x, play.y, 0);
    await shot("note");
    /* read the footer inside the launcher's 1.6 s hold, in one round trip */
    const notes = await evaluate(`(async () => {
      const out = [];
      for (let i = 0; i < 30; i++) {
        const box = document.getElementById("picksay"), text = box ? box.textContent : "";
        if (text && out[out.length - 1] !== text) out.push(text);
        await new Promise((r) => setTimeout(r, 40));
      }
      return out;
    })()`);
    const said = (Array.isArray(notes) ? notes : []).find((t) => /server list/.test(t)) || "";
    say(`  note: ${said || "(none)"}`);
    if (!/added to your server list as a Wisp entry for \S+:\d+/.test(said) &&
        !/now joins as a Wisp entry for \S+:\d+/.test(said)) {
      problems.push(`the launcher said ${JSON.stringify(said || (Array.isArray(notes) ? notes.join(" | ") : notes))}`);
    }
    if (!(await until("the pick never handed the tab to play.html",
      async () => String(await evaluate("location.pathname")) === "/play.html", 15000))) return problems;
    const landed = await evaluate("location.pathname + location.search");
    if (landed !== "/play.html") problems.push(`the hand-off went to ${landed}, not a plain play.html`);

    /* 3 ---- the row the client will read */
    say("[3] servers.dat");
    await until("servers.dat was not readable after the hand-off", async () => (await listText()) !== null, 20000);
    const text = await listText();
    if (typeof text !== "string" || /^(EXC|ERR)/.test(text)) {
      problems.push(`servers.dat could not be read back (${String(text).slice(0, 120)})`);
    } else {
      /* the ip field's bytes end where the next tag's control byte starts, so stop at non-printable */
      const ip = /eagler-wisp:[\x21-\x7e]+/.exec(text);
      say(`  ${text.length} B, row ${ip ? decodeURIComponent(ip[0]) : "(none)"}`);
      if (!ip) problems.push("servers.dat holds no wisp row");
      const wanted = /for (\S+):(\d+)/.exec(said);
      if (ip && wanted && !ip[0].endsWith(`?target=${wanted[1]}:${wanted[2]}`)) {
        problems.push(`the row points at ${decodeURIComponent(ip[0])}, the note said ${wanted[1]}:${wanted[2]}`);
      }
    }

    /* 4 ---- the client on that list: Multiplayer -> row -> Join */
    say("[4] the client: Multiplayer, the row, Join");
    await sleep(BOOT_WAIT);
    await shot("menu");
    await click(...STEPS.closePanel, 600);
    await click(...STEPS.profileDone, 1200);
    await click(...STEPS.guestName, 1200);
    await click(...STEPS.multiplayer, 2500);
    await shot("caution");
    await click(...STEPS.proceed, 3000);
    await shot("multiplayer");
    await click(...STEPS.row2, 1200);
    await shot("row");
    await click(...STEPS.join, 1000);
    say("  joining: the last two frames are the join (the world, if the relay carried it)");
    await sleep(15000);
    await shot("join");
    await sleep(15000);
    await shot("join-later");
    for (const line of logs.slice(-10)) say(`  client: ${line.slice(0, 160)}`);
    return problems;
  } catch (err) {
    died = true;
    throw err;
  } finally {
    cleanup();
  }
}

/* ---------------------------------------------------------------- main */
if (checkOnly) {
  process.exit(contract() ? 0 : 1);
}

const chrome = findChrome();
if (!chrome) {
  console.error("[fail] no Chrome found: set CHROME=/path/to/chrome");
  process.exit(2);
}
let problems;
try {
  problems = await walk(chrome);
} catch (err) {
  console.error(`[fail] ${err && err.message ? err.message : err}`);
  process.exit(2);
}
if (problems.length) {
  console.error(`\n[fail] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`\n[ok]   the pick landed: note shown, row written where the client reads it`);
console.log(`[note] the Multiplayer status and the join are in the frames under ${path.relative(ROOT, OUT)}`);
process.exit(0);
