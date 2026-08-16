// Text-to-text encoding/obfuscation functions (Base64, Base32, Hex, Z85).
import { stripTag } from './utils.js';

export const TT_TYPES = [
  { value: 'base64', label: 'Base64' },
  { value: 'base32', label: 'Base32' },
  { value: 'hex', label: 'Hex' },
  { value: 'z85', label: 'Z85' },
];

const TYPE_TAGS = { base64: 'Base64', base32: 'Base32', hex: 'Hex', z85: 'Z85', sealed: 'Sealed' };
const TAG_TO_TYPE = { Base64: 'base64', Base32: 'base32', Hex: 'hex', Z85: 'z85', Sealed: 'sealed' };

export function tagFor(type) {
  return TYPE_TAGS[type] ?? type;
}

export function typeFromTag(tag) {
  return TAG_TO_TYPE[tag] ?? null;
}

// Best-effort detection of the encoding of an untagged string. Returns a
// TT type or null. Order matters: strict checks first (hex, base32, base64 —
// each validated by exact decode/re-encode round-trip), then z85, whose
// alphabet covers almost all printable ASCII so it is checked last.
export function detectType(s) {
  const flat = s.replace(/\s/g, '');
  if (!flat) return null;

  const isHex = /^[0-9a-fA-F]+$/.test(flat) && flat.length % 2 === 0;
  if (isHex && bytesToHex(hexToBytes(flat.toLowerCase())) === flat.toLowerCase()) return 'hex';

  const upper = flat.toUpperCase();
  const isB32 = /^[A-Z2-7]+={0,6}$/.test(upper) && upper.length >= 8 && upper.length % 8 === 0;
  if (isB32 && base32EncodeBytes(base32DecodeBytes(upper)) === upper) return 'base32';

  if (
    /^[A-Za-z0-9+/=]+$/.test(flat) &&
    flat.length >= 4 &&
    flat.length % 4 === 0 &&
    canRoundTripB64(flat)
  ) {
    return 'base64';
  }

  const isZ85 =
    /^[0-9a-zA-Z.\-:+=^!/*?&<>()\[\]{}@%$#]+$/.test(flat) &&
    flat.length >= 5 &&
    flat.length % 5 === 0;
  if (isZ85 && z85EncodeBytes(z85DecodeBytes(flat)) === flat) return 'z85';

  // Sealed is a heuristic last resort: unseal must yield a known-tagged
  // string. Can occasionally misfire on weird inputs — the app warns.
  if (flat.length >= 5) {
    const inner = unsealPayload(flat);
    if (inner !== null && stripTag(inner).tag) return 'sealed';
  }

  return null;
}

function canRoundTripB64(s) {
  try {
    return btoa(atob(s)) === s;
  } catch {
    return false;
  }
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const Z85_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function bytesToBinary(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return bin;
}

export function encodeText(text, type) {
  switch (type) {
    case 'base64':
      return btoa(bytesToBinary(new TextEncoder().encode(text)));
    case 'base32':
      return base32EncodeBytes(new TextEncoder().encode(text));
    case 'hex':
      return textToHex(text);
    case 'z85':
      return z85EncodeBytes(new TextEncoder().encode(text));
    default:
      return text;
  }
}

export function decodeText(text, type) {
  const { rest } = stripTag(text);
  if (type === 'sealed') {
    const inner = unsealPayload(rest);
    if (inner === null) return 'Invalid Sealed input';
    const { tag: itag, rest: irest } = stripTag(inner);
    const itype = (itag ? typeFromTag(itag) : null) ?? 'base64';
    return decodeText(irest, itype);
  }
  try {
    let bytes;
    switch (type) {
      case 'base64':
        bytes = Uint8Array.from(atob(rest.trim()), (c) => c.charCodeAt(0));
        break;
      case 'base32':
        bytes = base32DecodeBytes(rest);
        break;
      case 'hex':
        bytes = hexToBytes(rest);
        break;
      case 'z85':
        bytes = z85DecodeBytes(rest);
        break;
      default:
        return rest;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return 'Invalid ' + tagFor(type) + ' input';
  }
}

export function textToHex(s) {
  return bytesToHex(new TextEncoder().encode(s));
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(s) {
  const cleaned = s.replace(/\s/g, '');
  if (cleaned.length % 2 !== 0) throw new Error('odd hex length');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    const b = parseInt(cleaned.slice(i, i + 2), 16);
    if (Number.isNaN(b)) throw new Error('bad hex char');
    bytes[i / 2] = b;
  }
  return bytes;
}

// RFC 4648 base32: 5 bits/char, A-Z and 2-7, '=' padding to multiple of 8.
function base32EncodeBytes(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

function base32DecodeBytes(s) {
  const cleaned = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const val = B32_ALPHABET.indexOf(ch);
    if (val < 0) throw new Error('bad base32 char');
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xFF);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

// Z85 (ZeroMQ RFC 32): 4 bytes -> 5 chars. Encode pads with 0x00 to a
// multiple of 4; decode strips the trailing NULs (safe for UTF-8 text).
function z85EncodeBytes(bytes) {
  const padLen = ((bytes.length + 3) >> 2) << 2;
  const padded = new Uint8Array(padLen);
  padded.set(bytes);
  let out = '';
  for (let i = 0; i < padLen; i += 4) {
    let n = ((padded[i] * 256 + padded[i + 1]) * 256 + padded[i + 2]) * 256 + padded[i + 3];
    let chunk = '';
    for (let j = 0; j < 5; j++) {
      chunk = Z85_ALPHABET[n % 85] + chunk;
      n = Math.floor(n / 85);
    }
    out += chunk;
  }
  return out;
}

function z85DecodeBytes(s) {
  const cleaned = s.replace(/\s/g, '');
  if (cleaned.length % 5 !== 0) throw new Error('z85 length not a multiple of 5');
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) {
      const idx = Z85_ALPHABET.indexOf(cleaned[i + j]);
      if (idx < 0) throw new Error('bad z85 char');
      n = n * 85 + idx;
    }
    bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  const out = new Uint8Array(bytes);
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  return out.slice(0, end);
}

// ---------------- Sealed codec ----------------
// The payload is a standard base64 body (padding stripped) with 1-8 random
// filler chars inserted at positions chosen by a PRNG seeded from the salt.
// The 4-char salt is appended at the end (last 4 chars = the key). Decode
// removes the fillers, re-pads and base64-decodes. The PRNG, alphabet and
// math are byte-identical across JS/Rust so messages round-trip everywhere.
const SEAL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function makeSealRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
}

function seedFromSalt(salt) {
  let seed = 0;
  for (let i = 1; i < 4; i++) {
    const idx = SEAL_ALPHABET.indexOf(salt[i]);
    seed = ((seed << 8) | (idx < 0 ? 0 : idx)) >>> 0;
  }
  if (seed === 0) seed = 0x9e3779b9;
  return seed >>> 0;
}

// Wrap an already-encoded (tagged) string in a sealed layer.
export function seal(inner) {
  return '[Sealed] ' + sealPayload(inner);
}

export function sealPayload(inner) {
  const body = btoa(bytesToBinary(new TextEncoder().encode(inner))).replace(/=+$/, '');
  const l = body.length;
  const m = 1 + Math.floor(Math.random() * 8);
  const salt =
    SEAL_ALPHABET[8 * Math.floor(Math.random() * 8) + (m - 1)] +
    SEAL_ALPHABET[Math.floor(Math.random() * 64)] +
    SEAL_ALPHABET[Math.floor(Math.random() * 64)] +
    SEAL_ALPHABET[Math.floor(Math.random() * 64)];
  const next = makeSealRng(seedFromSalt(salt));
  const positions = [];
  for (let k = 0; k < m; k++) positions.push(next() % (l + 1));
  positions.sort((a, b) => a - b);
  let out = '';
  let fi = 0;
  for (let i = 0; i <= l; i++) {
    while (fi < m && positions[fi] === i) {
      out += SEAL_ALPHABET[next() % 64];
      fi++;
    }
    if (i < l) out += body[i];
  }
  return out + salt;
}

// Remove the "[Sealed] " tag and unseal, returning the inner tagged string.
export function unseal(s) {
  const { tag, rest } = stripTag(s);
  if (tag !== 'Sealed') return null;
  return unsealPayload(rest);
}

// Undo sealPayload; null on invalid input.
export function unsealPayload(s) {
  const cleaned = String(s).replace(/\s/g, '');
  if (cleaned.length < 4) return null;
  const salt = cleaned.slice(-4);
  const received = cleaned.slice(0, -4);
  for (const ch of salt) if (SEAL_ALPHABET.indexOf(ch) < 0) return null;
  const idx0 = SEAL_ALPHABET.indexOf(salt[0]);
  if (idx0 < 0) return null;
  const m = 1 + (idx0 % 8);
  if (received.length < m) return null;
  const l = received.length - m;
  const next = makeSealRng(seedFromSalt(salt));
  const positions = [];
  for (let k = 0; k < m; k++) positions.push(next() % (l + 1));
  positions.sort((a, b) => a - b);
  let body = '';
  let fi = 0;
  for (const ch of received) {
    if (fi < m && positions[fi] === body.length) {
      fi++;
      continue;
    }
    body += ch;
  }
  if (fi !== m) return null;
  const pad = (4 - (body.length % 4)) % 4;
  try {
    const bin = atob(body + '='.repeat(pad));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}