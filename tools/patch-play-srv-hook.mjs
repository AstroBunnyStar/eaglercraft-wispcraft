#!/usr/bin/env node
/**
 * Re-applies the page-level SRV hook to play.html.
 *
 * Why the hook exists (see PATCHES.md, "Joining a Java server without touching its entry"): a join's
 * wisp socket is built from the client's own reference to the native WebSocket, so a page-level
 * window.WebSocket proxy never sees it - only the shared prototype does. The first frame on that
 * socket is the wisp CONNECT naming the server, and for an SRV-only host that name is exactly what no
 * relay can reach (minemen.club:25565 times out; geo.minemen.club:25565 answers in ~100 ms). The hook
 * holds that one frame for the `_minecraft._tcp` answer and sends it to the record's target, releasing
 * everything the client queued behind it in order; a lookup that never answers releases the frame
 * unchanged after 2.5 s. No other frame is touched.
 *
 * play.html is a rebuilt artifact (the EPK payload is regenerated), so the hook is a local edit that a
 * rebuild silently drops - exactly like the bundle patches that tools/patch-wispcraft.mjs re-applies.
 * This is the same kind of tool for the page: it inserts the hook after its anchor, replaces an older
 * copy of it, verifies the result parses, and --check reports whether the page carries it.
 *
 * Usage:
 *   node tools/patch-play-srv-hook.mjs                # patch ./play.html
 *   node tools/patch-play-srv-hook.mjs --check        # verify only, no writes
 *   node tools/patch-play-srv-hook.mjs --file path.html
 *
 * Exit codes: 0 patched/already-patched, 1 --check found the hook missing or stale, 2 anchor unusable.
 *
 * The script is idempotent and never guesses: if a rebuilt page no longer has the
 * `window.wispcraftNote` line it anchors on, it stops with exit 2 and says so.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/* the launcher publishes its log sink here; the hook goes immediately after it */
const ANCHOR = 'window.wispcraftNote = function (msg) { try { console.log("[wispcraft] " + msg); } catch (e) {} };';
/* first line of the hook, and the line that closes it - both unique to this block */
const HOOK_START = "  /* The client's wisp socket keeps its own reference to the native WebSocket, so replacing";
/* the block ends at its own marker rather than at the first `})();` after the start line: a hook
   body that one day nests such a call would otherwise be sliced in half and the page half-edited,
   and the guard count would not notice because it only counts what is left */
const HOOK_CLOSE = "  /* end of the join hook */";
const HOOK_END = `\n${HOOK_CLOSE}\n  })();`;
/* pages patched before the marker existed end at the first closing line instead */
const HOOK_END_LEGACY = "\n  })();";
/* the re-entry guard the hook installs, used to prove there is exactly one copy */
const HOOK_MARK = "proto.__wispcraftSrv = 1;";

const HOOK = `
  /* The client's wisp socket keeps its own reference to the native WebSocket, so replacing
     window.WebSocket never sees it; the shared prototype does. A join's first frame on that socket is
     the wisp CONNECT naming the server, and for a host whose _minecraft._tcp record points somewhere
     else that name is what no relay can reach (minemen.club:25565 times out; the record's
     geo.minemen.club:25565 answers in about 100 ms). The CONNECT is held for the record and sent to
     its target instead; the frames the client queues behind it go out, in order, once it has gone. */
  (function () {
    var proto = window.WebSocket && window.WebSocket.prototype;
    if (!proto || proto.__wispcraftSrv) return;
    proto.__wispcraftSrv = 1;
    var nativeSend = proto.send;
    /* wisp CONNECT: [0x01][streamID u32 LE][streamType 0x01 TCP][port u16 LE][hostname utf8] */
    function connectOf(u8) {
      if (!u8 || u8.length < 12 || u8[0] !== 1 || u8[5] !== 1) return null;
      var host = "";
      for (var i = 8; i < u8.length; i++) {
        var c = u8[i];
        if (!c) break;
        host += String.fromCharCode(c);
      }
      if (host.indexOf(".") < 0 || !/^[a-z0-9][a-z0-9.-]*$/i.test(host)) return null;
      return { host: host.toLowerCase(), port: u8[6] | (u8[7] << 8), bytes: u8 };
    }
    function rewrite(info, target) {
      var colon = target.lastIndexOf(":"), host = target, port = 0;
      if (colon > 0) { host = target.slice(0, colon); port = parseInt(target.slice(colon + 1), 10) || 0; }
      var out = new Uint8Array(8 + host.length);
      out.set(info.bytes.subarray(0, 8), 0);
      port = port || info.port;
      out[6] = port & 0xff;
      out[7] = (port >> 8) & 0xff;
      for (var i = 0; i < host.length; i++) out[8 + i] = host.charCodeAt(i) & 0xff;
      return out;
    }
    function flush(socket, first) {
      var queue = socket.__wispQueue || [];
      socket.__wispQueue = null;
      if (first) nativeSend.call(socket, first);
      for (var i = 0; i < queue.length; i++) nativeSend.call(socket, queue[i]);
    }
    proto.send = function (data) {
      var u8 = null;
      try {
        if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else if (data && data.buffer instanceof ArrayBuffer) u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      } catch (e) {}
      var info = connectOf(u8);
      if (!info) {
        /* nothing goes out ahead of a CONNECT that is still waiting for its record */
        if (this.__wispQueue) { this.__wispQueue.push(data); return; }
        return nativeSend.apply(this, arguments);
      }
      if (this.__wispQueue) { this.__wispQueue.push(data); return; }
      var socket = this, sent = false;
      function go(frame) {
        if (sent) return;
        sent = true;
        clearTimeout(timer);
        flush(socket, frame);
      }
      /* a DNS answer that never comes must not leave the join parked: after 2.5 s the frame goes out
         exactly as the client wrote it, which is the behaviour before this hook */
      var timer = setTimeout(function () { go(data); }, 2500);
      socket.__wispQueue = [];
      resolveSrv(info.host).then(function (target) {
        if (target && target !== info.host) {
          try { window.wispcraftNote && window.wispcraftNote("srv " + info.host + " -> " + target); } catch (e) {}
          go(rewrite(info, target));
        } else {
          go(data);
        }
      }, function () { go(data); });
    };
${HOOK_CLOSE}
  })();`;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const checkOnly = argv.includes("--check");
const file = path.resolve(opt("--file", "play.html"));

const lines = [];
const fail = (msg) => {
  for (const line of lines) console.log(line);
  console.error(`\n[fail] ${msg}`);
  process.exit(2);
};

let html;
try {
  html = fs.readFileSync(file, "utf8");
} catch (err) {
  fail(`cannot read ${file}: ${err.message}`);
}

/* the hook is compared with indentation ignored, so a rebuild that re-indents the page does not read
   as a stale hook while any change to what the hook does does */
const norm = (s) => String(s).replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).join("\n");
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/** the whole block, from its first comment line to the marker that closes it */
function installedHook(source) {
  const at = source.indexOf(HOOK_START);
  if (at < 0) return null;
  const end = source.indexOf(HOOK_END, at);
  if (end >= 0) return { at, text: source.slice(at, end + HOOK_END.length) };
  /* an older copy, from before the hook carried its closing marker */
  const legacy = source.indexOf(HOOK_END_LEGACY, at);
  if (legacy < 0) return { at, text: null };
  return { at, text: source.slice(at, legacy + HOOK_END_LEGACY.length) };
}

const found = installedHook(html);
const wanted = norm(HOOK.trim());

/* ---------------------------------------------------------------- sanity of the block itself */
/* the page's inline script cannot contain these; inserting one would break the document */
if (/<\/?script/i.test(HOOK)) fail("the hook text itself contains a script tag - refusing to touch the page");
if (countOf(HOOK, HOOK_MARK) !== 1) fail("the hook text does not carry its own re-entry guard exactly once");

/* ---------------------------------------------------------------- apply or verify */
if (found && found.text && norm(found.text) === wanted) {
  lines.push("[ok]   srv hook already present");
} else if (found && found.text) {
  /* an older copy of the hook: replace it in place so a page can be upgraded, not only patched once */
  if (checkOnly) {
    lines.push("[stale] srv hook: the page carries an older version of it");
  } else {
    lines.push("[fix]  srv hook was stale; replaced with the current version");
    /* the block already sits after a newline, so replacing it in place must not add another */
    html = html.slice(0, found.at) + HOOK.replace(/^\n/, "") + html.slice(found.at + found.text.length);
  }
} else if (found && !found.text) {
  fail(`the srv hook starts at byte ${found.at} but its closing "})();" is missing - the page looks half-edited`);
} else {
  const anchors = countOf(html, ANCHOR);
  if (anchors !== 1) {
    fail(
      `${anchors === 0 ? "not found" : `found ${anchors} times`}: ${JSON.stringify(ANCHOR.slice(0, 40) + "...")}
       the page was rebuilt with a different wispcraftNote line; update ANCHOR in this script after
       checking where the launcher now publishes its log sink.`
    );
  }
  if (checkOnly) {
    lines.push("[miss] srv hook: the page does not carry it");
  } else {
    html = html.replace(ANCHOR, ANCHOR + HOOK);
    lines.push("[fix]  srv hook inserted after window.wispcraftNote");
  }
}

/* ---------------------------------------------------------------- validate before writing */
if (!checkOnly) {
  const applied = installedHook(html);
if (applied && applied.text && norm(applied.text) !== wanted) {
  fail("the page does not read back the hook that was just written - refusing to save it");
}
if (applied && countOf(html, HOOK_MARK) !== 1) {
  fail(`the page ends up with ${countOf(html, HOOK_MARK)} copies of the hook; expected one`);
}
if (!applied && countOf(html, HOOK_MARK) > 0) {
  fail("the page carries the hook's guard without its block - the page looks half-edited");
}
}

if (!checkOnly) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "play-srv-hook-")), "hook.js");
  fs.writeFileSync(tmp, HOOK);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    lines.push("[ok]   hook parses (node --check)");
  } catch (err) {
    fail(`the hook text fails to parse, nothing written:\n${err.stderr ? err.stderr.toString() : err.message}`);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

for (const line of lines) console.log(line);

if (checkOnly) {
  if (!found || !found.text || norm(found.text) !== wanted) {
    console.log("\n[check] the srv hook is missing or stale; run without --check to apply it.");
    process.exit(1);
  }
  console.log(`\n[check] ${path.basename(file)} carries the srv hook.`);
  process.exit(0);
}

if (html === fs.readFileSync(file, "utf8")) {
  console.log(`\n[done] ${path.basename(file)} already up to date, nothing written.`);
} else {
  fs.writeFileSync(file, html);
  console.log(`\n[done] wrote ${file} (${html.length} bytes)`);
}
