import { Buffer } from 'buffer';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { decodePng, encodePng, RGBA } from './png';

// jpeg-js references the global `Buffer`, which React Native doesn't provide.
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;

export { encodePng, decodePng, RGBA } from './png';

export const RAMP = "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ";

export type ImgFormat = 'png' | 'jpeg';

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// Tolerates whitespace, a leading "data:image/...;base64," prefix and
// encoding tags like '[JPG] ' or '[Base64] '.
export function parseB64(raw: string): string {
  const { rest } = stripTag(raw);
  let s = rest.trim();
  const i = s.toLowerCase().indexOf('base64,');
  if (i >= 0) s = s.slice(i + 7);
  return s.replace(/\s/g, '');
}

export const TAGS: Record<string, string> = {
  base64: 'Base64',
  base32: 'Base32',
  hex: 'Hex',
  z85: 'Z85',
  jpg: 'JPG',
  png: 'PNG',
  ascii: 'ASCII',
  sealed: 'Sealed',
};

const TAG_RE = /^\[(Base64|Base32|Hex|Z85|JPG|PNG|ASCII|Sealed)\]\s*/i;

// Strip a leading encoding tag; returns { tag, rest } (tag is null when
// the string has no tag). The tag is canonicalized ('[jPg]' -> 'JPG').
export function stripTag(s: string): { tag: string | null; rest: string } {
  const trimmed = s.trim();
  const m = trimmed.match(TAG_RE);
  if (!m) return { tag: null, rest: s };
  return { tag: TAGS[m[1].toLowerCase()] ?? m[1], rest: trimmed.slice(m[0].length) };
}

export function detectFormat(bytes: Uint8Array): ImgFormat | 'other' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return 'other';
}

export function decodeRgba(bytes: Uint8Array): RGBA {
  const fmt = detectFormat(bytes);
  if (fmt === 'png') return decodePng(bytes);
  if (fmt === 'jpeg') {
    const j = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: j.width, height: j.height, data: new Uint8Array(j.data.buffer, j.data.byteOffset, j.data.byteLength) };
  }
  throw new Error('Unsupported image format (PNG/JPEG only)');
}

export function boxResize(img: RGBA, outW: number, outH: number): RGBA {
  const src = img.data;
  const out = new Uint8Array(outW * outH * 4);
  const { width: iw, height: ih } = img;
  for (let r = 0; r < outH; r++) {
    const y0 = Math.floor((r * ih) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * ih) / outH));
    for (let c = 0; c < outW; c++) {
      const x0 = Math.floor((c * iw) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * iw) / outW));
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * iw + x) * 4;
          rr += src[o];
          gg += src[o + 1];
          bb += src[o + 2];
          aa += src[o + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (r * outW + c) * 4;
      out[o] = Math.round(rr / n);
      out[o + 1] = Math.round(gg / n);
      out[o + 2] = Math.round(bb / n);
      out[o + 3] = Math.round(aa / n);
    }
  }
  return { width: outW, height: outH, data: out };
}

export function downscaleToMax(img: RGBA, maxDim: number): RGBA {
  const scale = Math.min(1, maxDim / img.width, maxDim / img.height);
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  return boxResize(img, w, h);
}

export function asciiFromRgba(img: RGBA, cols: number): string {
  // Monospace cells are ~2x taller than wide; divide by 1.7 (not 2) so the
  // rendered art looks a bit taller / less squashed.
  const rows = Math.max(1, Math.round((cols * img.height) / img.width / 1.7));
  const small = boxResize(img, cols, rows);
  const n = RAMP.length;
  const d = small.data;
  let s = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const o = (r * cols + c) * 4;
      const lum = (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000;
      s += RAMP[Math.round((lum * (n - 1)) / 255)];
    }
    s += '\n';
  }
  return s;
}

const yieldJS = () => new Promise<void>((res) => setTimeout(res, 0));

// Async variant that yields every `every` rows so the JS thread can paint the
// busy/skeleton UI while a big image is being converted.
export async function asciiFromRgbaAsync(img: RGBA, cols: number, every = 16): Promise<string> {
  const rows = Math.max(1, Math.round((cols * img.height) / img.width / 1.7));
  const small = boxResize(img, cols, rows);
  const n = RAMP.length;
  const d = small.data;
  let s = '';
  for (let r = 0; r < rows; r++) {
    if (r % every === 0) await yieldJS();
    for (let c = 0; c < cols; c++) {
      const o = (r * cols + c) * 4;
      const lum = (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000;
      s += RAMP[Math.round((lum * (n - 1)) / 255)];
    }
    s += '\n';
  }
  return s;
}

export function asciiToRgba(text: string, scale: number): RGBA {
  let lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (!lines.length) lines = [' '];
  const cols = Math.max(...lines.map((l) => l.length));
  const rows = lines.length;
  // Monospace cells are ~2x taller than wide, so render each char 2x tall.
  const cellH = Math.max(1, Math.round(scale * 2));
  const w = Math.max(1, cols * scale);
  const h = Math.max(1, rows * cellH);
  const n = RAMP.length;
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < rows; r++) {
    const line = lines[r];
    for (let c = 0; c < cols; c++) {
      const ch = c < line.length ? line[c] : ' ';
      let idx = RAMP.indexOf(ch);
      if (idx < 0) idx = (ch.codePointAt(0) ?? 0) % n;
      const g = Math.round((idx * 255) / (n - 1));
      for (let dy = 0; dy < cellH; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((r * cellH + dy) * w + c * scale + dx) * 4;
          data[o] = g;
          data[o + 1] = g;
          data[o + 2] = g;
          data[o + 3] = 255;
        }
      }
    }
  }
  return { width: w, height: h, data };
}

// Async variant of asciiToRgba that yields every `every` rows so the JS thread
// can paint the busy/loading UI while a big block of text is being rendered.
export async function asciiToRgbaAsync(text: string, scale: number, every = 16): Promise<RGBA> {
  let lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (!lines.length) lines = [' '];
  const cols = Math.max(...lines.map((l) => l.length));
  const rows = lines.length;
  const cellH = Math.max(1, Math.round(scale * 2));
  const w = Math.max(1, cols * scale);
  const h = Math.max(1, rows * cellH);
  const n = RAMP.length;
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < rows; r++) {
    if (r % every === 0) await yieldJS();
    const line = lines[r];
    for (let c = 0; c < cols; c++) {
      const ch = c < line.length ? line[c] : ' ';
      let idx = RAMP.indexOf(ch);
      if (idx < 0) idx = (ch.codePointAt(0) ?? 0) % n;
      const g = Math.round((idx * 255) / (n - 1));
      for (let dy = 0; dy < cellH; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((r * cellH + dy) * w + c * scale + dx) * 4;
          data[o] = g;
          data[o + 1] = g;
          data[o + 2] = g;
          data[o + 3] = 255;
        }
      }
    }
  }
  return { width: w, height: h, data };
}

export function encodeToBase64(img: RGBA, format: ImgFormat, quality: number): string {
  if (format === 'png') {
    return bytesToBase64(encodePng(img));
  }
  const buf = Buffer.from(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength);
  const jpeg = encodeJpeg({ data: buf, width: img.width, height: img.height }, quality);
  return bytesToBase64(jpeg.data);
}

// Picks a JPEG quality that balances size vs quality (the "knee" of the
// size-vs-quality curve): the quality right before the biggest size jump, so you
// keep raising quality while it's nearly free and stop when it gets expensive.
// Quality is on jpeg-js's 0-100 scale.
export function autoJpegQuality(img: RGBA): number {
  const ladder = [45, 60, 72, 82, 90];
  const sizes = ladder.map((q) => encodeToBase64(img, 'jpeg', q).length);
  let maxRatio = 1;
  let knee = ladder.length - 1;
  for (let i = 1; i < sizes.length; i++) {
    const ratio = sizes[i] / sizes[i - 1];
    if (ratio > maxRatio) {
      maxRatio = ratio;
      knee = i;
    }
  }
  if (maxRatio < 1.15) return ladder[ladder.length - 1];
  return ladder[Math.max(0, knee - 1)];
}

export function encodeAutoJpegToBase64(img: RGBA): { b64: string; quality: number } {
  const q = autoJpegQuality(img);
  return { b64: encodeToBase64(img, 'jpeg', q), quality: q };
}

export function encodeToBytes(img: RGBA, format: ImgFormat, quality: number): Uint8Array {
  if (format === 'png') return encodePng(img);
  const buf = Buffer.from(img.data.buffer as ArrayBuffer, img.data.byteOffset, img.data.byteLength);
  return encodeJpeg({ data: buf, width: img.width, height: img.height }, quality).data;
}

// Counts distinct RGB colors, bailing out early once we know there are more
// than `limit` (mirrors Pillow's image.getcolors(n) returning None on overflow).
export function uniqueColorCount(img: RGBA, limit = 256): number {
  const seen = new Set<number>();
  const d = img.data;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    seen.add((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]);
    if (seen.size > limit) return seen.size;
  }
  return seen.size;
}

interface ColorCount {
  key: number;
  r: number;
  g: number;
  b: number;
  count: number;
}

// Median-cut quantization to at most `targetColors` colors, followed by
// Floyd-Steinberg error diffusion (port of Pillow's
// quantize(colors=, method=MEDIANCUT, dither=FLOYDSTEINBERG)).
export function quantizeRgba(img: RGBA, targetColors: number, dither = true): RGBA {
  const target = Math.max(2, Math.min(Math.round(targetColors), 256));
  const src = img.data;
  const w = img.width;
  const h = img.height;
  const n = w * h;

  const hist = new Map<number, ColorCount>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const key = (src[o] << 16) | (src[o + 1] << 8) | src[o + 2];
    const e = hist.get(key);
    if (e) e.count++;
    else hist.set(key, { key, r: src[o], g: src[o + 1], b: src[o + 2], count: 1 });
  }

  let buckets: ColorCount[][] = [[...hist.values()]];

  if (buckets[0].length > target) {
    while (buckets.length < target) {
      let bi = -1;
      let bestRange = 0;
      let ch = 0;
      for (let b = 0; b < buckets.length; b++) {
        const bk = buckets[b];
        if (bk.length < 2) continue;
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (const c of bk) {
          if (c.r < minR) minR = c.r;
          if (c.r > maxR) maxR = c.r;
          if (c.g < minG) minG = c.g;
          if (c.g > maxG) maxG = c.g;
          if (c.b < minB) minB = c.b;
          if (c.b > maxB) maxB = c.b;
        }
        const rng = [maxR - minR, maxG - minG, maxB - minB];
        const cc = rng[0] >= rng[1] && rng[0] >= rng[2] ? 0 : rng[1] >= rng[2] ? 1 : 2;
        if (rng[cc] > bestRange) {
          bestRange = rng[cc];
          bi = b;
          ch = cc;
        }
      }
      if (bi < 0) break;
      const bk = buckets[bi];
      bk.sort((a, b) => (ch === 0 ? a.r - b.r : ch === 1 ? a.g - b.g : a.b - b.b));
      let total = 0;
      for (const c of bk) total += c.count;
      let acc = 0;
      let splitAt = 0;
      for (let i = 0; i < bk.length; i++) {
        acc += bk[i].count;
        if (acc * 2 >= total) {
          splitAt = i + 1;
          break;
        }
      }
      if (splitAt <= 0 || splitAt >= bk.length) splitAt = bk.length >> 1;
      buckets.splice(bi, 1, bk.slice(0, splitAt), bk.slice(splitAt));
    }
  } else {
    // Fewer unique colors than the target: keep them exact (each becomes its
    // own palette entry) instead of collapsing everything into one average.
    buckets = buckets[0].map((e) => [e]);
  }

  const palette: { r: number; g: number; b: number }[] = [];
  const keyToPalette = new Map<number, number>();
  for (let b = 0; b < buckets.length; b++) {
    const bk = buckets[b];
    if (!bk.length) continue;
    let r = 0, g = 0, bl = 0, c = 0;
    for (const e of bk) {
      r += e.r * e.count;
      g += e.g * e.count;
      bl += e.b * e.count;
      c += e.count;
    }
    const pi = palette.length;
    palette.push({ r: Math.round(r / c), g: Math.round(g / c), b: Math.round(bl / c) });
    for (const e of bk) keyToPalette.set(e.key, pi);
  }

  // Error-diffused output pass.
  const out = new Uint8Array(n * 4);
  if (!dither) {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const key = (src[o] << 16) | (src[o + 1] << 8) | src[o + 2];
      const pi = keyToPalette.get(key)!;
      out[o] = palette[pi].r;
      out[o + 1] = palette[pi].g;
      out[o + 2] = palette[pi].b;
      out[o + 3] = src[o + 3];
    }
    return { width: w, height: h, data: out };
  }
  const err = new Float64Array(n * 3);
  const pl = palette.length;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x;
      const o = i * 4;
      const eo = i * 3;
      let r = src[o] + err[eo];
      let g = src[o + 1] + err[eo + 1];
      let b = src[o + 2] + err[eo + 2];
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < pl; p++) {
        const dr = r - palette[p].r;
        const dg = g - palette[p].g;
        const db = b - palette[p].b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      const pr = palette[best].r;
      const pg = palette[best].g;
      const pb = palette[best].b;
      out[o] = pr;
      out[o + 1] = pg;
      out[o + 2] = pb;
      out[o + 3] = src[o + 3];
      const er = r - pr;
      const eg = g - pg;
      const eb = b - pb;
      if (x + 1 < w) {
        err[eo + 3] += (er * 7) / 16;
        err[eo + 4] += (eg * 7) / 16;
        err[eo + 5] += (eb * 7) / 16;
      }
      if (y + 1 < h) {
        const next = (y + 1) * w;
        if (x > 0) {
          const jo = (next + x - 1) * 3;
          err[jo] += (er * 3) / 16;
          err[jo + 1] += (eg * 3) / 16;
          err[jo + 2] += (eb * 3) / 16;
        }
        {
          const jo = (next + x) * 3;
          err[jo] += (er * 5) / 16;
          err[jo + 1] += (eg * 5) / 16;
          err[jo + 2] += (eb * 5) / 16;
        }
        if (x + 1 < w) {
          const jo = (next + x + 1) * 3;
          err[jo] += er / 16;
          err[jo + 1] += eg / 16;
          err[jo + 2] += eb / 16;
        }
      }
    }
  }
  return { width: w, height: h, data: out };
}

export type SmartEncodeMethod = 'jpg_quantized' | 'png';

export interface SmartEncodeResult {
  base64: string;
  original_size: number;
  compressed_size: number;
  base64_len: number;
  method_used: SmartEncodeMethod;
  quality?: number;
}

export interface SmartEncodeOptions {
  targetColors?: number;
  quality?: number | 'auto';
  auto?: boolean;
  method?: SmartEncodeMethod;
  dither?: boolean;
}

// Port of the encoder's preprocess_for_base64: quantize to targetColors and
// JPEG-encode (jpg_quantized), or PNG-encode when auto finds <=256 unique
// colors. Returns base64 plus the metrics dict. jpeg-js always emits 4:2:0
// subsampled JPEG, so that matches Pillow's subsampling='4:2:0'.
export function encodeSmartBase64(img: RGBA, opts: SmartEncodeOptions = {}): SmartEncodeResult {
  const targetColors = opts.targetColors ?? 64;
  const auto = opts.auto ?? false;

  const unique = uniqueColorCount(img);
  const usePng = opts.method ? opts.method === 'png' : auto && unique <= 256;

  const original_size = img.width * img.height * 4;

  if (usePng) {
    const payload = encodePng(img);
    return {
      base64: bytesToBase64(payload),
      original_size,
      compressed_size: payload.length,
      base64_len: bytesToBase64(payload).length,
      method_used: 'png',
    };
  }

  const qimg = quantizeRgba(img, targetColors, opts.dither ?? true);
  const quality = opts.quality === 'auto' ? autoJpegQuality(qimg) : Math.max(1, Math.min(100, opts.quality ?? 70));
  const payload = encodeToBytes(qimg, 'jpeg', quality);
  const b64 = bytesToBase64(payload);
  return {
    base64: b64,
    original_size,
    compressed_size: payload.length,
    base64_len: b64.length,
    method_used: 'jpg_quantized',
    quality,
  };
}

// ---------------- Aggressive downscale ----------------
// Aggressive downscale: divides each side by 1.5 above 700px,
// by 2.5 above 1500px, so big images get much smaller before encoding.
export function aggressiveDownscale(img: RGBA): RGBA {
  const m = Math.max(img.width, img.height);
  let div = 1;
  if (m > 1500) div = 2.5;
  else if (m > 700) div = 1.5;
  if (div === 1) return img;
  return boxResize(img, Math.max(1, Math.round(img.width / div)), Math.max(1, Math.round(img.height / div)));
}
