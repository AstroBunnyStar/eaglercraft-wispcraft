/**
 * Drives the SRV hook that `play.html` installs on WebSocket.prototype.send.
 *
 * The client's wisp socket is created with its own reference to the native WebSocket, so a page-level
 * window.WebSocket proxy never sees it (measured: no construction at all during a join) while every
 * instance shares the prototype. The hook therefore sits on the prototype, recognises the wisp CONNECT
 * a join opens with, and sends it to the `_minecraft._tcp` target instead of the name the player typed.
 *
 * These checks run the hook from the shipped page in a vm against crafted frames: the CONNECT must be
 * held for the answer, rewritten, and sent before anything the client queued behind it, while a
 * frame that is not a CONNECT is never touched and a lookup that never answers still releases the
 * frame unchanged.
 *
 * Run with: node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("play.html", "utf8");
const check = (name, ok, detail) => assert.ok(ok, name + (detail ? ` [${detail}]` : ""));

const start = html.indexOf("(function () {\n    var proto = window.WebSocket && window.WebSocket.prototype;");
if (start < 0) throw new Error("the srv hook is missing from play.html");
const end = html.indexOf("  })();", start);
const hookSource = html.slice(start, end + "  })();".length);

function connectFrame(host, port = 25565) {
  const out = new Uint8Array(8 + host.length);
  out[0] = 1; /* CONNECT */
  out[4] = 1; /* stream id 1, little endian */
  out[5] = 1; /* TCP */
  out[6] = port & 0xff;
  out[7] = (port >> 8) & 0xff;
  for (let i = 0; i < host.length; i++) out[8 + i] = host.charCodeAt(i);
  return out;
}
function dataFrame(text) {
  const body = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const out = new Uint8Array(5 + body.length);
  out[0] = 2; /* DATA */
  out[4] = 1; /* stream id 1 */
  out.set(body, 5);
  return out;
}
function hostOf(frame) {
  const u8 = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  let host = "";
  for (let i = 8; i < u8.length; i++) { if (!u8[i]) break; host += String.fromCharCode(u8[i]); }
  return { host, port: u8[6] | (u8[7] << 8), type: u8[0] };
}

/* one socket that records what actually went out, with the hook installed as the page installs it */
function makePage(answer, { hang = false } = {}) {
  const sent = [];
  const notes = [];
  const asked = [];
  class FakeSocket {
    send(frame) { sent.push(frame instanceof Uint8Array ? new Uint8Array(frame) : frame); }
  }
  const window = {
    WebSocket: FakeSocket,
    wispcraftNote: (m) => notes.push(String(m)),
  };
  const ctx = {
    window,
    Uint8Array, ArrayBuffer, Promise, String, RegExp, parseInt, setTimeout, clearTimeout, Math, Error,
    resolveSrv: (host) => {
      asked.push(host);
      return hang ? new Promise(() => {}) : Promise.resolve(answer(host));
    },
  };
  vm.createContext(ctx);
  vm.runInContext("var resolveSrv=this.resolveSrv;" + hookSource, ctx);
  return { socket: new FakeSocket(), sent, notes, asked, FakeSocket };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the wisp CONNECT is sent to the srv target, ahead of what the client queued", async () => {
  const page = makePage(() => "geo.minemen.club");
  page.socket.send(connectFrame("minemen.club"));
  page.socket.send(dataFrame("handshake"));
  await sleep(20);

  check("the record is asked for the name the player typed", page.asked.join(",") === "minemen.club", page.asked.join(",") || "none");
  check("the join dials the record's target", page.sent.length === 2 && hostOf(page.sent[0]).host === "geo.minemen.club", JSON.stringify(page.sent.map(hostOf)));
  check("the target keeps the port", hostOf(page.sent[0]).port === 25565, String(hostOf(page.sent[0]).port));
  check("the rewritten frame is still a CONNECT for stream 1", hostOf(page.sent[0]).type === 1, String(hostOf(page.sent[0]).type));
  check("the queued DATA frame follows it unchanged",
    page.sent.length === 2 && Buffer.from(page.sent[1]).equals(Buffer.from(dataFrame("handshake"))),
    page.sent.length + " frames");
  check("the launcher log names the swap once", page.notes.join(" | ") === "srv minemen.club -> geo.minemen.club", page.notes.join(" | ") || "no notes");
});

test("a record with its own port replaces the port too", async () => {
  const page = makePage(() => "geo.example.net:25566");
  page.socket.send(connectFrame("example.net"));
  await sleep(20);
  check("the target host and port are both used",
    page.sent.length === 1 && hostOf(page.sent[0]).host === "geo.example.net" && hostOf(page.sent[0]).port === 25566,
    JSON.stringify(page.sent.map(hostOf)));
});

test("a host with no record keeps the address the player typed", async () => {
  const page = makePage(() => undefined);
  page.socket.send(connectFrame("plain.example.org"));
  await sleep(20);
  check("the frame goes out as written",
    page.sent.length === 1 && Buffer.from(page.sent[0]).equals(Buffer.from(connectFrame("plain.example.org"))),
    JSON.stringify(page.sent.map(hostOf)));
  check("nothing is claimed in the log", page.notes.length === 0, page.notes.join(" | "));
});

test("a lookup that never answers still releases the frame", async () => {
  const page = makePage(() => undefined, { hang: true });
  page.socket.send(connectFrame("slow.example.net"));
  page.socket.send(dataFrame("queued"));
  await sleep(50);
  check("nothing goes out while the record is pending", page.sent.length === 0, `${page.sent.length} frames`);
  await sleep(2600);
  check("the frame and its queue are released after the timeout",
    page.sent.length === 2 && hostOf(page.sent[0]).host === "slow.example.net", `${page.sent.length} frames`);
});

test("only wisp CONNECT frames are looked at", async () => {
  const page = makePage(() => "geo.minemen.club");
  const data = dataFrame("accept: motd");
  page.socket.send(data);
  page.socket.send("a string frame");
  await sleep(20);
  check("an ordinary frame is passed straight through",
    page.sent.length === 2 && Buffer.from(page.sent[0]).equals(Buffer.from(data)) && page.sent[1] === "a string frame",
    `${page.sent.length} frames`);
  check("no lookup is made for it", page.asked.length === 0, page.asked.join(","));
});
