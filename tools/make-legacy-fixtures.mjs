/**
 * Single source of truth for the legacy-skin fixtures in test/fixtures/:
 *   legacy64x32.png      a pre-1.8 64x32 skin, 8-bit RGBA
 *   legacy-expected.json its 64x64 completion as A,R,G,B, base64 (16,384 bytes)
 *
 * Both are checked in because test/seed-and-blob.test.mjs compares the client's output
 * against them. Regenerate with:
 *   node tools/make-legacy-fixtures.mjs
 * That test also asserts the checked-in files still match this generator.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const WIDTH = 64;
const HEIGHT = 32;
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

/** Deterministic full-opacity pattern: neighbouring texels never share every channel. */
export function legacyPixels() {
  const px = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      px[i] = (x * 4) & 255;
      px[i + 1] = (y * 8) & 255;
      px[i + 2] = (x * 3 + y * 5) & 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Minimal PNG writer for 8-bit RGBA with filter type 0 on every row. */
export function encodePng(rgba, width = WIDTH, height = rgba.length / width / 4) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha

  const stride = width * 4;
  const rows = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The 13 region copies of the client's SkinConverter.convert64x32to64x64, as
 * [destX, destY, srcX, srcY, width, height, mirrored]. The 64x32 block is carried over
 * untouched; the limbs are mirrored as they move into the modern layout.
 */
const COPIES = [
  [0, 0, 0, 0, 64, 32, false],
  [24, 48, 4, 16, 4, 4, true],
  [28, 48, 8, 16, 4, 4, true],
  [20, 52, 8, 20, 4, 12, true],
  [24, 52, 4, 20, 4, 12, true],
  [28, 52, 0, 20, 4, 12, true],
  [32, 52, 12, 20, 4, 12, true],
  [40, 48, 44, 16, 4, 4, true],
  [44, 48, 48, 16, 4, 4, true],
  [36, 52, 48, 20, 4, 12, true],
  [40, 52, 44, 20, 4, 12, true],
  [44, 52, 40, 20, 4, 12, true],
  [48, 52, 52, 20, 4, 12, true],
];

/** A 64x32 skin completed to 64x64 exactly as the client does it. */
export function completeLegacySkin(rgba = legacyPixels()) {
  const out = Buffer.alloc(64 * 64 * 4);
  for (const [dstX, dstY, srcX, srcY, width, height, mirrored] of COPIES) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = ((srcY + y) * WIDTH + srcX + x) * 4;
        const to = ((dstY + y) * 64 + dstX + (mirrored ? width - 1 - x : x)) * 4;
        rgba.copy(out, to, from, from + 4);
      }
    }
  }
  return out;
}

/** The same skin in the A,R,G,B order the profile blob stores. */
export function legacyArgb() {
  const rgba = completeLegacySkin();
  const argb = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    argb[i] = rgba[i + 3];
    argb[i + 1] = rgba[i];
    argb[i + 2] = rgba[i + 1];
    argb[i + 3] = rgba[i + 2];
  }
  return argb;
}

export const expectedJson = () => JSON.stringify({ argb: legacyArgb().toString("base64") });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, "legacy64x32.png"), encodePng(legacyPixels()));
  fs.writeFileSync(path.join(FIXTURES, "legacy-expected.json"), expectedJson());
  console.log("regenerated test/fixtures/legacy64x32.png and test/fixtures/legacy-expected.json");
}
