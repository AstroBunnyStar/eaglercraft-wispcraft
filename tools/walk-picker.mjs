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
 * Usage:
 *   node tools/walk-picker.mjs                 # the whole walk, screenshots in .tmp/walk
 *   node tools/walk-picker.mjs --check         # the contract the walk relies on, no browser
 *   node tools/walk-picker.mjs --out dir       # where the screenshots go
 *   node tools/walk-picker.mjs --keep-profile  # keep the temporary browser profile
 *   node tools/walk-picker.mjs --boot-wait 90  # seconds to wait for the client menu (default 90)
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
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const checkOnly = argv.includes("--check");
const keepProfile = argv.includes("--keep-profile");
const OUT = path.resolve(opt("--out", path.join(ROOT, ".tmp/walk")));
const BOOT_WAIT = Number(opt("--boot-wait", 90)) * 1000;

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
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = await launch(chrome, profile);
  const child = started.child;
  if (!started.port) throw new Error("Chrome never reported a debugging port");
  const { ws, send, logs } = await connect(started.port);
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
  const databases = () => evaluate("indexedDB.databases ? indexedDB.databases().then(l => l.map(d => d.name)) : []");

  /* the client's servers.dat, read through its own database; the row shape this returns is what the
     assertions below look at, so it only understands the tags a server list holds */
  const DB = databaseName(read("index.html"));
  const readServers = () => evaluate(`(async () => {
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
    let at = 1;
    const u16 = () => { const v = (b[at] << 8) | b[at + 1]; at += 2; return v; };
    const i32 = () => { const v = (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]; at += 4; return v; };
    const str = () => { const n = u16(); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]); at += n; return s; };
    str(); at += 1; str();
    const inner = b[at++], count = i32(), rows = [];
    for (let k = 0; k < count; k++) {
      const row = {};
      for (;;) {
        const t = b[at++];
        if (t === 0) break;
        const name = str();
        if (t === 8) row[name] = str();
        else if (t === 1) row[name] = b[at++];
        else return "tag " + t + " in " + name;
      }
      rows.push(row);
    }
    return { bytes: b.length, inner, count, rows: rows.map((r) => ({ mode: r.connectionMode, ip: r.ip, name: r.name, hidden: r.hidden, icon: r.icon ? r.icon.length : 0 })) };
  })().catch((e) => "ERR " + e)`);

  const waitFilesystem = async (what, timeoutMs = 180000) => {
    const t0 = Date.now();
    for (;;) {
      const dbs = await databases();
      if (Array.isArray(dbs) && dbs.some((n) => String(n).includes("PlatformFilesystem_1_8_8_worlds"))) {
        say(`  client filesystem after ${Math.round((Date.now() - t0) / 1000)}s`);
        return true;
      }
      if (Date.now() - t0 > timeoutMs) {
        problems.push(`${what}: the client never created its filesystem (${JSON.stringify(dbs)})`);
        return false;
      }
      await sleep(2500);
    }
  };

  try {
    await send("Runtime.enable", {});
    await send("Page.enable", {});

    /* 1 ---- the client boots once, so its filesystem exists and the launcher has a list to write */
    say("[1] boot the client");
    await nav(`${base}/play.html`);
    if (!(await waitFilesystem("first boot"))) return problems;
    await sleep(3000);

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
    const notes = [];
    for (let i = 0; i < 40; i++) {
      const text = await evaluate(`(document.getElementById("picksay") || {}).textContent || ""`);
      if (typeof text === "string" && text && notes[notes.length - 1] !== text) notes.push(text);
      await sleep(40);
    }
    await shot("note");
    const said = notes.find((t) => /server list/.test(t)) || "";
    say(`  note: ${said || "(none)"}`);
    if (!/added to your server list as a Wisp entry for \S+:\d+/.test(said) && !/now joins as a Wisp entry for \S+:\d+/.test(said)) {
      problems.push(`the launcher said ${JSON.stringify(said || notes.join(" | "))}`);
    }
    for (let i = 0; i < 40; i++) {
      if (String(await evaluate("location.pathname")) === "/play.html") break;
      await sleep(250);
    }
    const landed = await evaluate("location.pathname + location.search");
    if (landed !== "/play.html") problems.push(`the hand-off went to ${landed}, not a plain play.html`);
    await sleep(2500);

    /* 3 ---- the row the client will read */
    say("[3] servers.dat");
    const list = await readServers();
    say(`  ${JSON.stringify(list)}`);
    if (!list || typeof list !== "object" || !Array.isArray(list.rows) || !list.rows.length) {
      problems.push(`servers.dat could not be read back (${JSON.stringify(list)})`);
    } else {
      const row = list.rows[list.rows.length - 1];
      const wanted = /for (\S+):(\d+)/.exec(said);
      if (row.mode !== "wisp") problems.push(`the row is ${row.mode}, not a wisp row`);
      if (!/\?target=\S+:\d+$/.test(String(row.ip))) problems.push(`the row's ip is ${row.ip}`);
      if (wanted && !String(row.ip).endsWith(`target=${wanted[1]}:${wanted[2]}`)) {
        problems.push(`the row points at ${row.ip}, the note said ${wanted[1]}:${wanted[2]}`);
      }
      if (wanted && row.name !== wanted[1]) problems.push(`the row is named ${row.name}, the note said ${wanted[1]}`);
    }

    /* 4 ---- the client on that list: Multiplayer -> row -> Join */
    say("[4] the client: Multiplayer, the row, Join");
    if (!(await waitFilesystem("second boot"))) return problems;
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
  } finally {
    try { ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    server.close();
    if (!keepProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
    else say(`profile kept at ${profile}`);
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
