import { unzlibSync, zlibSync } from 'fflate';

export interface RGBA {
  width: number;
  height: number;
  data: Uint8Array;
}

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function readU32(bytes: Uint8Array, p: number): number {
  return ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------- Encode ----------
export function encodePng(img: RGBA): Uint8Array {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const filt = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    for (let i = 0; i < stride; i++) cur[i] = data[rowStart + i];

    let bestFilter = 0;
    let bestSum = Infinity;
    let bestLine: Uint8Array | null = null;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let v;
        if (f === 0) v = cur[i];
        else if (f === 1) v = cur[i] - a;
        else if (f === 2) v = cur[i] - b;
        else if (f === 3) v = cur[i] - ((a + b) >> 1);
        else v = cur[i] - paeth(a, b, c);
        filt[i] = v & 0xff;
        sum += Math.abs(v);
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestFilter = f;
        bestLine = new Uint8Array(filt);
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    raw.set(bestLine as Uint8Array, y * (stride + 1) + 1);
    prev.set(cur);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const chunks = [
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  let size = 8;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let off = 8;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const c = new Uint8Array(12 + data.length);
  const dv = new DataView(c.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
  c.set(data, 8);
  dv.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
  return c;
}

// ---------- Decode ----------
export function decodePng(bytes: Uint8Array): RGBA {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    throw new Error('Not a PNG file');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  const palette = new Uint8Array(768);
  const paletteAlpha = new Uint8Array(256).fill(255);
  const idat: Uint8Array[] = [];

  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = readU32(bytes, pos + 8);
      height = readU32(bytes, pos + 12);
      bitDepth = bytes[pos + 16];
      colorType = bytes[pos + 17];
      interlace = bytes[pos + 20];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'PLTE') {
      palette.set(body.subarray(0, Math.min(body.length, 768)));
    } else if (type === 'tRNS') {
      if (colorType === 3) {
        for (let i = 0; i < body.length; i++) paletteAlpha[i] = body[i];
      }
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (interlace !== 0) throw new Error('Interlaced PNG not supported');
  if (width === 0 || height === 0) throw new Error('Invalid PNG dimensions');

  const channels = [1, 0, 3, 1, 2, 0, 4][colorType] as number;
  if (channels === 0) throw new Error('Unsupported PNG color type ' + colorType);
  if (bitDepth !== 8 && bitDepth !== 1 && bitDepth !== 2 && bitDepth !== 4) {
    throw new Error('Unsupported PNG bit depth ' + bitDepth);
  }
  if (bitDepth !== 8 && colorType !== 0 && colorType !== 3) {
    throw new Error('Unsupported PNG bit depth ' + bitDepth + ' for color type ' + colorType);
  }

  let total = 0;
  for (const d of idat) total += d.length;
  const idatAll = new Uint8Array(total);
  let o = 0;
  for (const d of idat) {
    idatAll.set(d, o);
    o += d.length;
  }
  const inflated = unzlibSync(idatAll);

  // bytes per pixel for filtering purposes (spec: max(1, channels*bitDepth/8))
  const bppFrac = (channels * bitDepth) / 8;
  const bpp = Math.max(1, bppFrac);
  const stride = Math.ceil(width * bppFrac);
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let ip = 0;

  for (let y = 0; y < height; y++) {
    const filter = inflated[ip++];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = inflated[ip++];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      line[i] = v;
    }
    let oo = y * width * 4;
    if (bitDepth === 8) {
      if (colorType === 6) {
        for (let x = 0; x < width; x++) {
          const s = x * 4;
          out[oo++] = line[s];
          out[oo++] = line[s + 1];
          out[oo++] = line[s + 2];
          out[oo++] = line[s + 3];
        }
      } else if (colorType === 2) {
        for (let x = 0; x < width; x++) {
          const s = x * 3;
          out[oo++] = line[s];
          out[oo++] = line[s + 1];
          out[oo++] = line[s + 2];
          out[oo++] = 255;
        }
      } else if (colorType === 4) {
        for (let x = 0; x < width; x++) {
          const s = x * 2;
          const v = line[s];
          out[oo++] = v;
          out[oo++] = v;
          out[oo++] = v;
          out[oo++] = line[s + 1];
        }
      } else if (colorType === 0) {
        for (let x = 0; x < width; x++) {
          const v = line[x];
          out[oo++] = v;
          out[oo++] = v;
          out[oo++] = v;
          out[oo++] = 255;
        }
      } else if (colorType === 3) {
        for (let x = 0; x < width; x++) {
          const idx = line[x];
          out[oo++] = palette[idx * 3];
          out[oo++] = palette[idx * 3 + 1];
          out[oo++] = palette[idx * 3 + 2];
          out[oo++] = paletteAlpha[idx];
        }
      }
    } else {
      // packed sub-byte grayscale or palette
      const samplesPerByte = 8 / bitDepth;
      const mask = (1 << bitDepth) - 1;
      for (let x = 0; x < width; x++) {
        const byte = line[Math.floor(x / samplesPerByte)];
        const shift = 8 - bitDepth * ((x % samplesPerByte) + 1);
        const val = (byte >> shift) & mask;
        if (colorType === 3) {
          out[oo++] = palette[val * 3];
          out[oo++] = palette[val * 3 + 1];
          out[oo++] = palette[val * 3 + 2];
          out[oo++] = paletteAlpha[val];
        } else {
          const v = Math.round((val * 255) / mask);
          out[oo++] = v;
          out[oo++] = v;
          out[oo++] = v;
          out[oo++] = 255;
        }
      }
    }
    prev.set(line);
  }
  return { width, height, data: out };
}
