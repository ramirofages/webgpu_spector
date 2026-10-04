// Generates the extension icons (a lens over a triangle) as PNGs, without dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

function crc32(buf)
{
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++)
  {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data)
{
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel)
{
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
  {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++)
    {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function inTri(px, py, ax, ay, bx, by, cx, cy)
{
  const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const u = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / d;
  const v = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / d;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function sample(u, v)
{
  // Rounded square background.
  const r = 0.22;
  const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(qx, qy) > r) return [0, 0, 0, 0];
  let col = [30, 24, 48];
  // RGB triangle (the "frame").
  if (inTri(u, v, 0.18, 0.80, 0.82, 0.80, 0.50, 0.22))
  {
    const t = (v - 0.22) / 0.58;
    col = [Math.round(124 + 80 * (1 - t)), Math.round(77 + 60 * u), 255];
  }
  // Lens ring.
  const d = Math.hypot(u - 0.60, v - 0.56);
  if (d < 0.20 && d > 0.13) col = [255, 255, 255];
  else if (d <= 0.13) col = col.map((c) => Math.min(255, c + 60));
  // Lens handle.
  const hx = u - 0.74, hy = v - 0.70;
  const along = (hx + hy) / Math.SQRT2, across = (hx - hy) / Math.SQRT2;
  if (along > 0 && along < 0.2 && Math.abs(across) < 0.045) col = [255, 255, 255];
  return [...col, 255];
}

fs.mkdirSync('static/icons', { recursive: true });
for (const size of [16, 32, 48, 128])
{
  const ss = 4;
  const buf = png(size, (x, y) =>
  {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++)
      for (let sx = 0; sx < ss; sx++)
      {
        const p = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
        acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
      }
    const a = acc[3] / (ss * ss);
    return a ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], a].map(Math.round) : [0, 0, 0, 0];
  });
  fs.writeFileSync(`static/icons/icon${size}.png`, buf);
}
console.log('icons written');
