/**
 * Guards the sign-in pre-flight in relays.js:
 *   - the embedded ClientHello is a well-formed TLS record for the sign-in host;
 *   - a ServerHello record passes, even when a relay splits it across DATA packets;
 *   - a TLS alert, plain text or a handshake that is not a ServerHello fails;
 *   - a silent traffic test is retried once before a relay is called unusable.
 *
 * relays.js is loaded in a vm with a fake window and WebSocket, so these tests drive the real
 * probe rather than a copy of it. Run with: node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "relays.js"), "utf8");
const HOST = "login.microsoftonline.com";

const CONTINUE = 3, DATA = 2;

/* ---------------------------------------------------------------- wire format ---- */

/** [type][streamID u32 LE][payload] - the layout both Wisp versions share. */
function packet(type, stream, payload) {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = type;
  out.writeUInt32LE(stream, 1);
  payload.copy(out, 5);
  return out;
}

const toArrayBuffer = (buf) => {
  const out = new ArrayBuffer(buf.length);
  new Uint8Array(out).set(buf);
  return out;
};

/** A TLS 1.2 ServerHello record: the first thing Microsoft's endpoint returns. */
function serverHello() {
  const body = Buffer.alloc(38);
  body[0] = 3; body[1] = 3;                 // TLS 1.2
  body.fill(0x5a, 2, 34);                   // random
  body[34] = 0;                             // empty session id
  body.writeUInt16BE(0xc02f, 35);           // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
  body[37] = 0;                             // no compression
  const message = Buffer.concat([Buffer.from([2, 0, 0, body.length]), body]);
  const record = Buffer.alloc(5 + message.length);
  record[0] = 22; record[1] = 3; record[2] = 3;
  record.writeUInt16BE(message.length, 3);
  message.copy(record, 5);
  return record;
}

const tlsAlert = () => Buffer.from([21, 3, 3, 0, 2, 2, 40]);

/* ------------------------------------------------------------- fake relay ---- */

const HTTP_REPLY = packet(DATA, 1, Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));

/**
 * Replies with the stream-0 greeting, then answers the first CONNECT: on port 443 with the next
 * sign-in scenario (each attempt takes the next entry), on port 80 with a plain HTTP reply.
 */
let scenario = { signin: [], traffic: [true] };
let signinAttempts = 0;
let trafficAttempts = 0;

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.stream = null;
    this.replies = [];
    FakeSocket.last = this;
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.readyState = 1;
      if (this.onopen) this.onopen();
      this.deliver([packet(CONTINUE, 0, Buffer.alloc(0))]);
    });
  }
  send(bytes) {
    this.sent.push(Buffer.from(bytes));
    if (!this.stream) {
      this.stream = this.sent[0].readUInt16LE(6) === 443 ? "signin" : "traffic";
      this.replies = this.stream === "signin"
        ? scenario.signin[signinAttempts++] || []
        : (scenario.traffic[trafficAttempts++] ? [HTTP_REPLY] : []);
    }
    if (this.sent.length === 2) this.deliver(this.replies);
  }
  close() { this.readyState = 3; }
  deliver(chunks) {
    for (const chunk of chunks) {
      queueMicrotask(() => { if (this.onmessage) this.onmessage({ data: toArrayBuffer(chunk) }); });
    }
  }
}

function load() {
  const sandbox = { window: {}, URL, atob, WebSocket: FakeSocket, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "relays.js" });
  const relays = sandbox.window.WispRelays;
  assert.ok(relays && relays.probeSignIn && relays.signinHello, "relays.js exposes the probe");
  return relays;
}

async function probe(replies, timeout = 500) {
  scenario = { signin: [replies], traffic: true };
  signinAttempts = 0;
  const relays = load();
  const result = await relays.probeSignIn("wss://relay.example/wisp/", timeout);
  return { result, socket: FakeSocket.last, relays };
}

/**
 * Runs the full probe (traffic + sign-in). `traffic` is one boolean per traffic attempt (true = the
 * relay answers with HTTP), so a test can make the first attempt silent and the retry answer.
 */
async function fullRelay(signinTries, { traffic = true, timeout = 500 } = {}) {
  const tries = typeof traffic === "boolean" ? [traffic, traffic, traffic] : traffic;
  scenario = { signin: signinTries, traffic: tries };
  signinAttempts = 0;
  trafficAttempts = 0;
  const relays = load();
  const result = await relays.probe("wss://relay.example/wisp/", timeout);
  return { result, attempts: signinAttempts, trafficAttempts, relays };
}

/* --------------------------------------------------------- ClientHello parsing ---- */

/** Returns the SNI host name from a ClientHello record, or null when it carries none. */
function serverName(bytes) {
  let at = 9;                                          // skip record header + handshake header
  at += 2 + 32;                                        // client_version, random
  at += 1 + bytes[at];                                 // session id
  at += 2 + bytes.readUInt16BE(at);                    // cipher suites
  at += 1 + bytes[at];                                 // compression methods
  const extensions = bytes.readUInt16BE(at);
  at += 2;
  assert.equal(at + extensions, bytes.length, "extension block ends exactly at the record end");
  const end = at + extensions;
  while (at < end) {
    const type = bytes.readUInt16BE(at);
    const length = bytes.readUInt16BE(at + 2);
    at += 4;
    if (type === 0) {
      assert.equal(bytes.readUInt16BE(at) + 2, length, "server_name list fills the extension");
      assert.equal(bytes[at + 2], 0, "name type is host_name");
      const name = bytes.readUInt16BE(at + 3);
      assert.equal(5 + name, length, "the list holds exactly one name");
      return bytes.subarray(at + 5, at + 5 + name).toString("latin1");
    }
    at += length;
  }
  return null;
}

/* ---------------------------------------------------------------------- tests ---- */

test("the embedded ClientHello is a valid TLS record for the sign-in host", () => {
  const relays = load();
  const bytes = Buffer.from(relays.signinHello());

  assert.equal(bytes[0], 22, "content type is handshake");
  assert.equal(bytes[1], 3, "record version major is 3");
  assert.ok(bytes[2] >= 1 && bytes[2] <= 3, `record version minor is plausible (${bytes[2]})`);
  assert.equal(bytes.readUInt16BE(3), bytes.length - 5, "record length covers the handshake message");
  assert.equal(bytes[5], 1, "handshake type is ClientHello");
  assert.equal(
    (bytes[6] << 16) | (bytes[7] << 8) | bytes[8],
    bytes.length - 9,
    "handshake length covers the body",
  );
  assert.deepEqual([...bytes.subarray(9, 11)], [3, 3], "client version is TLS 1.2");
  assert.equal(serverName(bytes), relays.signinHost, "SNI matches the host the probe CONNECTs to");
  assert.equal(relays.signinHost, HOST, "the probe targets the Microsoft sign-in host");
});

test("a ServerHello record passes and the probe sends the captured hello", async () => {
  const { result, socket, relays } = await probe([packet(DATA, 1, serverHello())]);

  assert.equal(result.ok, true, "ServerHello is a completed handshake");

  const connect = socket.sent[0];
  assert.equal(connect[0], 0x01, "first packet is CONNECT");
  assert.equal(connect.readUInt32LE(1), 1, "stream 1");
  assert.equal(connect[5], 0x01, "stream type TCP");
  assert.equal(connect.readUInt16LE(6), 443, "port 443");
  assert.equal(connect.subarray(8).toString("latin1"), HOST, "connected to the sign-in host");

  const hello = socket.sent[1];
  assert.equal(hello[0], DATA, "second packet is DATA");
  assert.equal(hello.readUInt32LE(1), 1, "on the same stream");
  assert.deepEqual([...hello.subarray(5)], [...relays.signinHello()], "the captured hello is sent verbatim");
});

test("a ServerHello split across DATA packets still passes", async () => {
  const hello = serverHello();
  const { result } = await probe([
    packet(DATA, 1, hello.subarray(0, 4)),
    packet(DATA, 1, hello.subarray(4, 10)),
    packet(DATA, 1, hello.subarray(10)),
  ]);

  assert.equal(result.ok, true, "the record is accumulated, not judged by its first packet");
});

test("a TLS alert is a refusal, not a completed handshake", async () => {
  const { result } = await probe([packet(DATA, 1, tlsAlert())]);

  assert.equal(result.ok, false, "an alert means Microsoft refused the connection");
});

test("a failed sign-in handshake is retried once and the retry decides", async () => {
  const { result, attempts } = await fullRelay([[packet(DATA, 1, tlsAlert())], [packet(DATA, 1, serverHello())]]);

  assert.equal(attempts, 2, "the alert was retried, not believed");
  assert.equal(result.ok, true, "traffic still passes");
  assert.equal(result.signin, true, "the second handshake succeeded");
});

test("a relay is labelled sign-in fails only after both attempts fail", async () => {
  const { result, attempts } = await fullRelay([[packet(DATA, 1, tlsAlert())], [packet(DATA, 1, tlsAlert())]]);

  assert.equal(attempts, 2, "exactly one retry, no loop");
  assert.equal(result.signin, false, "two failures are evidence");
});

test("a relay that signs in first time is not retried", async () => {
  const { result, attempts } = await fullRelay([[packet(DATA, 1, serverHello())], [packet(DATA, 1, tlsAlert())]]);

  assert.equal(attempts, 1, "no second handshake");
  assert.equal(result.signin, true);
});

test("a relay that cannot proxy is not retried for sign-in", async () => {
  const { result, attempts } = await fullRelay([[packet(DATA, 1, tlsAlert())], [packet(DATA, 1, serverHello())]], { traffic: false });

  assert.equal(attempts, 1, "traffic already failed, so sign-in cannot count");
  assert.equal(result.ok, false);
  assert.equal(result.signin, false);
});

test("a silent traffic test is retried once and the retry decides", async () => {
  const { result, trafficAttempts } = await fullRelay([[packet(DATA, 1, serverHello())]], { traffic: [false, true] });

  assert.equal(trafficAttempts, 2, "the silent answer was retried");
  assert.equal(result.ok, true, "the second request carried traffic");
  assert.equal(result.signin, true);
});

test("a relay that fails traffic twice is labelled cannot proxy", async () => {
  const { result, trafficAttempts } = await fullRelay([[packet(DATA, 1, tlsAlert())]], { traffic: [false, false] });

  assert.equal(trafficAttempts, 2, "exactly one traffic retry, no loop");
  assert.equal(result.ok, false);
  assert.equal(result.signin, false);
});

test("a relay that carries traffic first time does not retry it", async () => {
  const { result, trafficAttempts } = await fullRelay([[packet(DATA, 1, serverHello())]], { traffic: [true] });

  assert.equal(trafficAttempts, 1, "no second request");
  assert.equal(result.ok, true);
  assert.equal(result.signin, true);
});

test("a handshake that failed while traffic was down is retried once traffic passes", async () => {
  const { result, attempts, trafficAttempts } = await fullRelay(
    [[packet(DATA, 1, tlsAlert())], [packet(DATA, 1, serverHello())]],
    { traffic: [false, true] },
  );

  assert.equal(trafficAttempts, 2, "traffic was retried");
  assert.equal(attempts, 2, "the stale handshake failure was not believed");
  assert.equal(result.signin, true);
});

test("plain text and a handshake that is not a ServerHello both fail", async () => {
  const http = await probe([packet(DATA, 1, Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"))]);
  assert.equal(http.result.ok, false, "a plain response is not TLS");

  const certificate = serverHello();
  certificate[5] = 11;                                  // handshake type: Certificate
  const wrong = await probe([packet(DATA, 1, certificate)]);
  assert.equal(wrong.result.ok, false, "only a ServerHello proves the handshake started");
});
