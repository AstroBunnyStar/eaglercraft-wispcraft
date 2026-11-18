/**
 * Guards the profile-editor skin work in play.html:
 *   - a fresh profile gets the account's skin seeded, exactly once;
 *   - a profile that already carries a skin is never rewritten;
 *   - with no cached profile there is nothing to seed;
 *   - a legacy 64x32 skin is completed with the client's own 13 region copies.
 *
 * The head script is extracted from play.html at run time, so this test tracks the real
 * client rather than a copy of it. Run with: node --test test/seed-and-blob.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const PLAY = path.join(ROOT, "play.html");
const FIXTURES = path.join(ROOT, "test", "fixtures");

const ACCOUNT = "Lunamix_";
const TEXTURE = "http://textures.minecraft.net/texture/aa7e06956482c2e36150d947acd643a3933d5a95e738acd8f61e952ad470e14f";
const BLOB_BYTES = 16573;
const SKIN_BYTES = 16384;

/* ---------------------------------------------------------------- fixtures ---- */

function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  assert.equal(bitDepth, 8, "fixture is 8-bit");
  assert.equal(colorType, 6, "fixture is RGBA");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  const zero = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : zero;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(filter, 0, `unknown PNG filter ${filter}`);
      cur[x] = v & 255;
    }
  }
  return { width, height, data: out };
}

/* ------------------------------------------------------------ client harness ---- */

let head = null;
function headScript() {
  if (head) return head;
  const html = fs.readFileSync(PLAY, "utf8");
  const match = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(match, "play.html has an inline head script");
  head = match[1];
  assert.ok(head.length > 5000, "head script looks complete");
  return head;
}

class Storage {
  constructor(entries) { this.m = new Map(entries || []); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  removeItem(k) { this.m.delete(k); }
}
Storage.prototype.setItem = function setItem(k, v) { this.m.set(k, String(v)); };

/**
 * Runs the client's head script against a fake browser.
 * pixels is what the canvas returns, so a 64x32 buffer exercises the legacy path.
 */
function run({ entries, pixels, width = 64, height = 64 }) {
  const stats = { fetches: 0, reloads: 0 };
  const localStorage = new Storage(entries);
  const context = {
    Storage,
    localStorage,
    sessionStorage: new Storage(),
    btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    window: { wispcraft: { authstore: { user: { name: ACCOUNT, skins: [{ state: "ACTIVE", url: TEXTURE, variant: "SLIM" }] } } } },
    document: {
      readyState: "complete",
      addEventListener() {},
      querySelector() { return null; },
      getElementById() { return null; },
      createElement() {
        return {
          getContext: () => ({
            drawImage() {},
            getImageData: () => ({ data: pixels }),
          }),
        };
      },
    },
    location: { protocol: "https:", reload() { stats.reloads++; } },
    fetch: () => { stats.fetches++; return Promise.resolve({ ok: true, blob: () => null }); },
    createImageBitmap: () => Promise.resolve({ width, height }),
    setTimeout: (fn) => (typeof fn === "function" ? 0 : 0),
    setInterval: () => 0,
    clearInterval() {},
    clearTimeout() {},
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(headScript(), context, { filename: "play.html head" });
  return { stats, localStorage };
}

const ACCOUNT_ENTRIES = () => [
  ["wispcraft_accounts", JSON.stringify([{ username: ACCOUNT, token: "a.b.c", ms: "" }])],
  ["wispcraft_last_used_account", ACCOUNT],
  ["wispcraft_profile_cache", JSON.stringify({ name: ACCOUNT, skins: [{ state: "ACTIVE", url: TEXTURE, variant: "SLIM" }], capes: [] })],
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const latin1 = (b64) => Buffer.from(b64, "base64").toString("latin1");
const i32 = (raw, at) => (raw.charCodeAt(at) << 24) | (raw.charCodeAt(at + 1) << 16) | (raw.charCodeAt(at + 2) << 8) | raw.charCodeAt(at + 3);

/** Pulls the NBT skin payload out of the blob the way the client lays it out. */
function skinOf(blob) {
  const raw = latin1(blob);
  const at = raw.indexOf("\u0007\u0000\u0004data");
  assert.ok(at > -1, "blob carries a data field");
  const len = i32(raw, at + 7);
  return { raw, at, len, bytes: Buffer.from(raw.substr(at + 11, len), "latin1") };
}

/* ---------------------------------------------------------------------- tests ---- */

test("fresh profile gets the account skin seeded once", async () => {
  const session = run({ entries: ACCOUNT_ENTRIES(), pixels: new Uint8ClampedArray(64 * 64 * 4).fill(0x7f) });
  await settle();

  const blob = session.localStorage.getItem("_eaglercraftX.p");
  assert.ok(blob, "a profile blob was written");
  assert.equal(latin1(blob).length, BLOB_BYTES, "blob layout is unchanged");

  const raw = latin1(blob);
  const skinsAt = raw.indexOf("\u0009\u0000\u0005skins");
  assert.ok(skinsAt > -1, "skins list present");
  assert.equal(raw.charCodeAt(skinsAt + 8), 10, "skins list holds one compound entry");

  const skin = skinOf(blob);
  assert.equal(skin.len, SKIN_BYTES, "skin payload is 16,384 bytes");
  assert.deepEqual([...skin.bytes.subarray(0, 4)], [0x7f, 0x7f, 0x7f, 0x7f], "pixels stored as A,R,G,B");

  assert.equal(raw.charCodeAt(raw.indexOf("\u0001\u0000\u0005model") + 8), 1, "slim model preserved");
  assert.equal(i32(raw, raw.indexOf("presetSkin") + 10), -1, "presetSkin disabled");
  assert.equal(i32(raw, raw.indexOf("customSkin") + 10), 0, "customSkin flagged");
  assert.equal(raw.substr(raw.indexOf("username") + 10, ACCOUNT.length), ACCOUNT, "username preserved");

  assert.deepEqual(session.stats, { fetches: 1, reloads: 1 }, "one fetch and one reload");
});

test("a profile that already carries a skin is left untouched", async () => {
  const first = run({ entries: ACCOUNT_ENTRIES(), pixels: new Uint8ClampedArray(64 * 64 * 4).fill(0x7f) });
  await settle();
  const blob = first.localStorage.getItem("_eaglercraftX.p");

  const later = run({ entries: ACCOUNT_ENTRIES().concat([["_eaglercraftX.p", blob]]), pixels: new Uint8ClampedArray(64 * 64 * 4).fill(0x7f) });
  await settle();

  assert.deepEqual(later.stats, { fetches: 0, reloads: 0 }, "no network and no reload loop");
  assert.equal(later.localStorage.getItem("_eaglercraftX.p"), blob, "blob untouched");
});

test("no cached profile means nothing to seed", async () => {
  const entries = ACCOUNT_ENTRIES().filter(([k]) => k !== "wispcraft_profile_cache");
  const session = run({ entries, pixels: new Uint8ClampedArray(64 * 64 * 4).fill(0x7f) });
  await settle();

  assert.equal(session.stats.fetches, 0, "does not fetch without a profile");
  const blob = session.localStorage.getItem("_eaglercraftX.p") || "";
  assert.ok(latin1(blob).length < 400, "only a name-only blob, no skin invented");
});

test("legacy 64x32 skin is completed exactly as the client's converter does", async () => {
  const png = decodePng(fs.readFileSync(path.join(FIXTURES, "legacy64x32.png")));
  assert.deepEqual([png.width, png.height], [64, 32], "fixture is a legacy skin");

  const expected = Buffer.from(JSON.parse(fs.readFileSync(path.join(FIXTURES, "legacy-expected.json"), "utf8")).argb, "base64");
  assert.equal(expected.length, SKIN_BYTES, "reference skin is 16,384 bytes");

  const session = run({ entries: ACCOUNT_ENTRIES(), pixels: new Uint8ClampedArray(png.data), width: 64, height: 32 });
  await settle();

  const skin = skinOf(session.localStorage.getItem("_eaglercraftX.p"));
  assert.equal(skin.len, SKIN_BYTES, "legacy skin expanded to 64x64");
  const mismatches = [...expected].reduce((n, byte, i) => n + (skin.bytes[i] === byte ? 0 : 1), 0);
  assert.equal(mismatches, 0, "every byte matches the 13 region copies");
});
