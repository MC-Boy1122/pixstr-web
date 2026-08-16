import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Appearance,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Slider from '@react-native-community/slider';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;
import {
  aggressiveDownscale,
  asciiFromRgbaAsync,
  asciiToRgbaAsync,
  base64ToBytes,
  bytesToBase64,
  decodeRgba,
  detectFormat,
  downscaleToMax,
  encodeAutoJpegToBase64,
  encodeToBase64,
  parseB64,
  stripTag,
  uniqueColorCount,
} from './lib/image';

const DARK = {
  bg1: '#0b0e14',
  bg2: '#101728',
  card: '#151b27',
  card2: '#1a2233',
  border: '#26304a',
  border2: '#313d5c',
  text: '#e8ecf4',
  muted: '#93a0b4',
  accent: '#5b8cff',
  accent2: '#8b5bff',
  ok: '#37d399',
  danger: '#ff6b6b',
  dangerBg: 'rgba(255,107,107,0.12)',
  dangerBorder: 'rgba(255,107,107,0.35)',
  input: '#0d1119',
  skel: '#1b2333',
  segBg: 'rgba(0,0,0,0.25)',
  toastBg: 'rgba(20,26,40,0.95)',
  tabsBg: 'rgba(10,13,20,0.55)',
  tabBtn: 'rgba(21,27,39,0.6)',
  cardBg: 'rgba(26,34,51,0.85)',
};

const LIGHT = {
  bg1: '#f2f5fa',
  bg2: '#e6ecf7',
  card: '#ffffff',
  card2: '#eef1f7',
  border: '#d4dbe8',
  border2: '#bcc7da',
  text: '#101828',
  muted: '#56637a',
  accent: '#2f5fd0',
  accent2: '#6a42d6',
  ok: '#0f9d67',
  danger: '#c94b4b',
  dangerBg: 'rgba(201,75,75,0.1)',
  dangerBorder: 'rgba(201,75,75,0.35)',
  input: '#ffffff',
  skel: '#e2e8f2',
  segBg: 'rgba(0,0,0,0.06)',
  toastBg: 'rgba(255,255,255,0.97)',
  tabsBg: 'rgba(0,0,0,0.05)',
  tabBtn: '#f5f7fc',
  cardBg: '#ffffff',
};

let C = DARK;
type Colors = typeof DARK;
let s = StyleSheet.create(buildStyles());

const initialScheme = Appearance.getColorScheme();
if (initialScheme === 'light') {
  C = LIGHT;
  s = StyleSheet.create(buildStyles());
}

function applyTheme(theme: 'dark' | 'light') {
  C = theme === 'dark' ? DARK : LIGHT;
  s = StyleSheet.create(buildStyles());
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const TABS = [
  { label: 'Image to Text' },
  { label: 'Text to Image' },
  { label: 'Text to Text' },
];

interface Img {
  uri: string;
  bytes: Uint8Array;
  fileSize: number;
  width: number;
  height: number;
}

type ImgMode = 'ascii' | 'image';

type TextMode = 'ascii' | 'base64';

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
  return (n / 1048576).toFixed(1) + ' MB';
}

const MAX_DISPLAY = 4000;
const MAX_OUTPUT_LINES = 20;

function truncate(s: string, n: number = MAX_DISPLAY): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[+${s.length - n} chars hidden]`;
}

// Show only the first MAX_OUTPUT_LINES *wrapped* lines for display (a line that
// wraps in the box counts as multiple wrapped lines); copy/share always use the
// full untruncated text. cpl = chars that fit per wrapped line.
function wrappedLineCount(s: string, cpl: number): number {
  if (cpl < 1) cpl = 1;
  let n = 0;
  for (const line of s.split('\n')) n += Math.max(1, Math.ceil(line.length / cpl));
  return n;
}

function truncateWrapped(s: string, cpl: number): string {
  if (cpl < 1) cpl = 1;
  const lines = s.split('\n');
  let out = '';
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wraps = Math.max(1, Math.ceil(line.length / cpl));
    if (used + wraps > MAX_OUTPUT_LINES) {
      return out + line.slice(0, Math.max(0, (MAX_OUTPUT_LINES - used) * cpl));
    }
    out += line + '\n';
    used += wraps;
  }
  return s;
}

function truncationNote(s: string, cpl: number): string {
  return wrappedLineCount(s, cpl) > MAX_OUTPUT_LINES
    ? `Showing first ${MAX_OUTPUT_LINES} wrapped lines — Copy for the full text.`
    : '';
}

// Monospace glyph advance is ~0.6× font size.
const MONO_OUT_FONT = 10;
const MONO_OUT_PADDING = 24; // 12 left + 12 right
function charsPerLine(boxWidth: number): number {
  const usable = Math.max(60, (boxWidth || 300) - MONO_OUT_PADDING);
  return Math.max(1, Math.floor(usable / (MONO_OUT_FONT * 0.6)));
}

async function readUriBytes(uri: string): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function cacheJpegBytes(bytes: Uint8Array): Promise<string> {
  const path = `${FileSystem.cacheDirectory}pixstr_${Date.now()}.jpg`;
  await FileSystem.writeAsStringAsync(path, bytesToBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
  return path;
}

async function cacheRgbaAsJpeg(rgba: { width: number; height: number; data: Uint8Array }, quality = 95): Promise<string> {
  return cacheJpegBytes(base64ToBytes(encodeToBase64(rgba, 'jpeg', quality)));
}

async function cacheBase64(b64: string, name: string): Promise<string> {
  const path = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });
  return path;
}

function looksLikeBase64(s: string): boolean {
  const { rest } = stripTag(s);
  const trimmed = rest.trim();
  if (!trimmed) return false;
  if (trimmed.length < 20) return false;
  const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length > 3) return false;
  const b64Chars = /^[A-Za-z0-9+/=]+$/;
  return lines.every(l => b64Chars.test(l.replace(/\s/g, '')));
}

function looksLikeAscii(s: string): boolean {
  const { rest } = stripTag(s);
  const trimmed = rest.trim();
  if (!trimmed) return false;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return false;
  const rampSet = new Set("$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ".split(''));
  let rampChars = 0;
  let totalChars = 0;
  for (const line of lines.slice(0, 10)) {
    for (const ch of line) {
      totalChars++;
      if (rampSet.has(ch)) rampChars++;
    }
  }
  return totalChars > 0 && rampChars / totalChars > 0.3;
}

// Text-to-text encoding functions (Base64, Base32, Hex, Z85).
const TT_TYPES = [
  { value: 'base64', label: 'Base64' },
  { value: 'base32', label: 'Base32' },
  { value: 'hex', label: 'Hex' },
  { value: 'z85', label: 'Z85' },
] as const;

type TTType = typeof TT_TYPES[number]['value'];
const TT_LABELS: Record<TTType | 'sealed', string> = { base64: 'Base64', base32: 'Base32', hex: 'Hex', z85: 'Z85', sealed: 'Sealed' };
const TT_FROM_TAG: Record<string, TTType | 'sealed'> = { Base64: 'base64', Base32: 'base32', Hex: 'hex', Z85: 'z85', Sealed: 'sealed' };

type TTDecodeType = 'auto' | TTType | 'sealed';
const TT_DECODE_TYPES: readonly { value: TTDecodeType; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'sealed', label: 'Sealed' },
  ...TT_TYPES,
];

const SEAL_OPTIONS: readonly { value: 'off' | 'on' | 'auto'; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'auto', label: 'Auto' },
];

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const Z85_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

function hexEncodeBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function hexDecodeBytes(s: string): Uint8Array {
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
function base32EncodeBytes(bytes: Uint8Array): string {
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

function base32DecodeBytes(s: string): Uint8Array {
  const cleaned = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const val = B32_ALPHABET.indexOf(ch);
    if (val < 0) throw new Error('bad base32 char');
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

// Z85 (ZeroMQ RFC 32): 4 bytes -> 5 chars. Encode pads with 0x00 to a
// multiple of 4; decode strips trailing NULs (safe for UTF-8 text).
function z85EncodeBytes(bytes: Uint8Array): string {
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

function z85DecodeBytes(s: string): Uint8Array {
  const cleaned = s.replace(/\s/g, '');
  if (cleaned.length % 5 !== 0) throw new Error('z85 length not a multiple of 5');
  const bytes: number[] = [];
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

function makeSealRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
}

function seedFromSalt(salt: string): number {
  let seed = 0;
  for (let i = 1; i < 4; i++) {
    const idx = SEAL_ALPHABET.indexOf(salt[i]);
    seed = ((seed << 8) | (idx < 0 ? 0 : idx)) >>> 0;
  }
  if (seed === 0) seed = 0x9e3779b9;
  return seed >>> 0;
}

// Wrap an already-encoded (tagged) string in a sealed layer.
export function seal(inner: string): string {
  return '[Sealed] ' + sealPayload(inner);
}

export function sealPayload(inner: string): string {
  const body = Buffer.from(inner, 'utf-8').toString('base64').replace(/=+$/, '');
  const l = body.length;
  const m = 1 + Math.floor(Math.random() * 8);
  const salt =
    SEAL_ALPHABET[8 * Math.floor(Math.random() * 8) + (m - 1)] +
    SEAL_ALPHABET[Math.floor(Math.random() * 64)] +
    SEAL_ALPHABET[Math.floor(Math.random() * 64)] +
    SEAL_ALPHABET[Math.floor(Math.random() * 64)];
  const next = makeSealRng(seedFromSalt(salt));
  const positions: number[] = [];
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
export function unseal(s: string): string | null {
  const { tag, rest } = stripTag(s);
  if (tag !== 'Sealed') return null;
  return unsealPayload(rest);
}

// Undo sealPayload; null on invalid input.
export function unsealPayload(s: string): string | null {
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
  const positions: number[] = [];
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
  if (body.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]+$/.test(body)) return null;
  const pad = (4 - (body.length % 4)) % 4;
  try {
    const buf = Buffer.from(body + '='.repeat(pad), 'base64');
    const txt = buf.toString('utf-8');
    if (!buf.equals(Buffer.from(txt, 'utf-8'))) return null;
    return txt;
  } catch {
    return null;
  }
}

function encodeText(text: string, type: TTType): string {
  const bytes = new Uint8Array(Buffer.from(text, 'utf-8'));
  switch (type) {
    case 'base64':
      return Buffer.from(bytes).toString('base64');
    case 'base32':
      return base32EncodeBytes(bytes);
    case 'hex':
      return hexEncodeBytes(bytes);
    case 'z85':
      return z85EncodeBytes(bytes);
    default:
      return text;
  }
}

function decodeText(text: string, type: TTType | 'sealed'): string {
  const { rest } = stripTag(text);
  if (type === 'sealed') {
    const inner = unsealPayload(rest);
    if (inner === null) return 'Invalid Sealed input';
    const { tag: itag, rest: irest } = stripTag(inner);
    const itype: TTType | 'sealed' = (itag ? TT_FROM_TAG[itag] : undefined) ?? 'base64';
    return decodeText(irest, itype);
  }
  try {
    let bytes: Uint8Array;
    switch (type) {
      case 'base64': {
        const s = rest.trim();
        if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw new Error('bad base64 char');
        bytes = new Uint8Array(Buffer.from(s, 'base64'));
        const norm = (x: string) => x.replace(/\s/g, '').replace(/=+$/, '');
        if (Buffer.from(bytes).toString('base64').replace(/=+$/, '') !== norm(s)) {
          throw new Error('bad base64');
        }
        break;
      }
      case 'base32':
        bytes = base32DecodeBytes(rest);
        break;
      case 'hex':
        bytes = hexDecodeBytes(rest);
        break;
      case 'z85':
        bytes = z85DecodeBytes(rest);
        break;
      default:
        return rest;
    }
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return `Invalid ${TT_LABELS[type]} input`;
  }
}

// Best-effort detection of the encoding of an untagged string. Mirrors the
// web version: candidates are validated by exact decode/re-encode round-trip
// (hex, base32, base64), then z85 last.
function detectTTType(s: string): TTType | 'sealed' | null {
  const flat = s.replace(/\s/g, '');
  if (!flat) return null;

  if (/^[0-9a-fA-F]+$/.test(flat) && flat.length % 2 === 0) {
    if (hexEncodeBytes(hexDecodeBytes(flat)) === flat.toUpperCase()) return 'hex';
  }

  const upper = flat.toUpperCase();
  if (/^[A-Z2-7]+={0,6}$/.test(upper) && upper.length >= 8 && upper.length % 8 === 0) {
    if (base32EncodeBytes(base32DecodeBytes(upper)) === upper) return 'base32';
  }

  if (/^[A-Za-z0-9+/=]+$/.test(flat) && flat.length >= 4 && flat.length % 4 === 0) {
    try {
      const bytes = Buffer.from(flat, 'base64');
      if (Buffer.from(bytes).toString('base64') === flat) return 'base64';
    } catch {
      // not base64
    }
  }

  if (/^[0-9a-zA-Z.\-:+=^!/*?&<>()\[\]{}@%$#]+$/.test(flat) && flat.length >= 5 && flat.length % 5 === 0) {
    try {
      if (z85EncodeBytes(z85DecodeBytes(flat)) === flat) return 'z85';
    } catch {
      // not z85
    }
  }

  // Sealed is a heuristic last resort: unseal must yield a known-tagged
  // string. Can occasionally misfire on weird inputs — the app warns.
  if (flat.length >= 5) {
    const inner = unsealPayload(flat);
    if (inner !== null && stripTag(inner).tag) return 'sealed';
  }

  return null;
}

function recommendMode(img: Img): ImgMode {
  // Downsample to <=256px so counting unique colors is fast, then treat
  // high-color-ratio images (photos, gradients) as image, flat ones as ASCII.
  const small = downscaleToMax(decodeRgba(img.bytes), 256);
  const unique = uniqueColorCount(small, 65536);
  const totalPixels = small.width * small.height;
  if (totalPixels > 0 && unique / totalPixels > 0.04) return 'image';
  return 'ascii';
}

export default function App() {
  const systemScheme = useColorScheme();
  const [theme, setTheme] = useState<'dark' | 'light'>(
    systemScheme === 'light' ? 'light' : 'dark'
  );
  const fade = useRef(new Animated.Value(1)).current;

  const manualRef = useRef(false);
  useEffect(() => {
    if (!manualRef.current && (systemScheme === 'light' || systemScheme === 'dark')) {
      applyTheme(systemScheme);
      setTheme(systemScheme);
    }
  }, [systemScheme]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    manualRef.current = true;
    Animated.sequence([
      Animated.timing(fade, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => {
      applyTheme(next);
      setTheme(next);
      Animated.timing(fade, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    });
  }

  const [activeTab, setActiveTab] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [img0, setImg0] = useState<Img | null>(null);
  const [b64Input0, setB64Input0] = useState('');
  const [mode0, setMode0] = useState<ImgMode | null>(null);
  const [rec0, setRec0] = useState<ImgMode | null>(null);
  const [width, setWidth] = useState(100);
  const [asciiText, setAsciiText] = useState('');
  const [asciiPreviewUri, setAsciiPreviewUri] = useState<string | null>(null);
  const [qualityMode0, setQualityMode0] = useState<'auto' | 'manual'>('auto');
  const [quality0, setQuality0] = useState(80);
  const [maxDim0, setMaxDim0] = useState(1000);
  const [out0, setOut0] = useState('');
  const [stats0, setStats0] = useState('');
  const [encCount0, setEncCount0] = useState(0);
  const [outW, setOutW] = useState(300);
  const lastEncodeKeyRef = useRef<string | null>(null);
  const [status0, setStatus0] = useState('Pick an image or paste base64 to begin.');

  const [text1, setText1] = useState('');
  const [detectedMode1, setDetectedMode1] = useState<TextMode | null>(null);
  const [scale1, setScale1] = useState(8);
  const [img1Uri, setImg1Uri] = useState<string | null>(null);
  const [status1, setStatus1] = useState('Paste ASCII art or a base64 string.');

  // Text → Text state
  const [tt2EncodeInput, setTt2EncodeInput] = useState('');
  const [tt2EncodeType, setTt2EncodeType] = useState<TTType>('base64');
  const [tt2DecodeInput, setTt2DecodeInput] = useState('');
  const [tt2DecodeType, setTt2DecodeType] = useState<TTDecodeType>('auto');
  const [tt2Result, setTt2Result] = useState('');
  const [tt2Busy, setTt2Busy] = useState(false);

  // Sealed mode: 'off' | 'on' | 'auto' — persistent, decode always works.
  const [sealedMode, setSealedMode] = useState<'off' | 'on' | 'auto'>('off');
  const [sealDialogVisible, setSealDialogVisible] = useState(false);
  const [tt2SealedNote, setTt2SealedNote] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem('pixstr.sealedMode');
        if (v === 'off' || v === 'on' || v === 'auto') setSealedMode(v);
        else setSealDialogVisible(true);
      } catch {
        setSealDialogVisible(true);
      }
    })();
  }, []);

  async function saveSealedMode(mode: 'off' | 'on' | 'auto') {
    setSealedMode(mode);
    setSealDialogVisible(false);
    try {
      await AsyncStorage.setItem('pixstr.sealedMode', mode);
    } catch {}
  }

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 1900);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const showToast = (msg: string) => setToastMsg(msg);

  async function pickImage(): Promise<Img | null> {
    try {
      let res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
      if (res.canceled || !res.assets?.length) return null;
      let asset = res.assets[0];
      let bytes = await readUriBytes(asset.uri);
      if (detectFormat(bytes) === 'other') {
        const res2 = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.95 });
        if (res2.canceled || !res2.assets?.length) return null;
        asset = res2.assets[0];
        bytes = await readUriBytes(asset.uri);
      }
      if (detectFormat(bytes) === 'other') {
        showToast('Unsupported image format (PNG/JPEG only)');
        return null;
      }
      return { uri: asset.uri, bytes, fileSize: asset.fileSize ?? bytes.length, width: asset.width ?? 0, height: asset.height ?? 0 };
    } catch {
      showToast('Could not read that image');
      return null;
    }
  }

  async function saveToGallery(uri: string) {
    try {
      const originalWarn = console.warn;
      console.warn = () => {};
      let MediaLibrary: any;
      try {
        MediaLibrary = require('expo-media-library/legacy');
      } finally {
        console.warn = originalWarn;
      }
      try {
        const perm = await MediaLibrary.requestPermissionsAsync();
        if (perm.granted) {
          await MediaLibrary.saveToLibraryAsync(uri);
          showToast('Saved to gallery');
          return;
        }
        showToast('Permission denied — opening share instead');
      } catch (saveErr: any) {
        console.log('saveToLibraryAsync failed:', saveErr?.message, '| uri:', uri);
        showToast('Gallery save unavailable — opening share');
      }
      const Sharing = require('expo-sharing');
      await Sharing.shareAsync(uri, { mimeType: uri.endsWith('.png') ? 'image/png' : 'image/jpeg', dialogTitle: 'Save image' });
    } catch {
      showToast('Could not save to gallery');
    }
  }

  async function copyText(text: string) {
    await Clipboard.setStringAsync(text);
    showToast('Copied to clipboard');
  }

  function shareText(text: string) {
    Share.share({ message: text }).catch(() => {});
  }

  async function withBusyFeedback(fn: () => Promise<void>) {
    const MIN_MS = 650;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 0));
    const started = Date.now();
    try {
      await fn();
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed < MIN_MS) await new Promise((r) => setTimeout(r, MIN_MS - elapsed));
      setBusy(false);
    }
  }

  async function onPick0() {
    const img = await pickImage();
    if (!img) return;
    setImg0(img);
    setB64Input0('');
    setMode0(null);
    setRec0(recommendMode(img));
    setAsciiText('');
    setAsciiPreviewUri(null);
    setOut0('');
    setStats0('');
    setStatus0(`${img.bytes.length} bytes loaded — choose how to process it below.`);
  }

  async function onPasteB64_0() {
    const b64 = parseB64(unseal(b64Input0) ?? b64Input0);
    if (!b64 || base64ToBytes(b64).length === 0) {
      showToast('Not a valid base64 string');
      return;
    }
    const bytes = base64ToBytes(b64);
    if (detectFormat(bytes) === 'other') {
      showToast('Not a recognized image format');
      return;
    }
    let uri = '';
    try {
      uri = await cacheBase64(b64, `paste_${Date.now()}.png`);
    } catch {
      uri = '';
    }
    let dw = 0, dh = 0;
    try {
      const rgba = decodeRgba(bytes);
      dw = rgba.width;
      dh = rgba.height;
    } catch {}
    const img: Img = { uri, bytes, fileSize: bytes.length, width: dw, height: dh };
    setImg0(img);
    setB64Input0('');
    setMode0(null);
    setRec0(recommendMode(img));
    setAsciiText('');
    setAsciiPreviewUri(null);
    setOut0('');
    setStats0('');
    setStatus0(`${bytes.length} bytes loaded — choose a processing mode below.`);
  }

  function onModeSelect0(mode: ImgMode) {
    setMode0(mode);
    if (mode === 'ascii') {
      setStatus0('ASCII mode — adjust width and hit Convert.');
    } else {
      setStatus0('Image mode — adjust settings and hit Encode.');
    }
  }

  function onBackToChoice0() {
    setMode0(null);
    setAsciiText('');
    setAsciiPreviewUri(null);
    setOut0('');
    setStats0('');
    setStatus0('Choose a processing mode below.');
  }

  async function onConvert0() {
    if (!img0) return;
    await withBusyFeedback(async () => {
      const rgba = decodeRgba(img0.bytes);
      const text = await asciiFromRgbaAsync(rgba, width);
      const preview = await asciiToRgbaAsync(text, 3);
      const uri = await cacheRgbaAsJpeg(preview);
      setAsciiText('[ASCII]\n' + text);
      setAsciiPreviewUri(uri);
      setStatus0(`Done — ${width} wide, ${text.length} characters.`);
    }).catch((e: any) => showToast(e?.message || 'Conversion failed'));
  }

  async function onEncode0() {
    if (!img0) return;
    const key = `${img0.uri}:${qualityMode0}:${quality0}:${maxDim0}`;
    if (lastEncodeKeyRef.current === key) {
      showToast('Settings unchanged — nothing to re-encode');
      return;
    }
    await withBusyFeedback(async () => {
      const decoded = decodeRgba(img0.bytes);
      let small = downscaleToMax(decoded, maxDim0);
      small = aggressiveDownscale(small);
      let b64: string;
      let usedQ: string;
      if (qualityMode0 === 'auto') {
        const res = encodeAutoJpegToBase64(small);
        b64 = res.b64;
        usedQ = `auto q${res.quality}`;
      } else {
        b64 = encodeToBase64(small, 'jpeg', quality0);
        usedQ = `q${quality0}`;
      }
      b64 = '[JPG] ' + b64;
      if (sealedMode !== 'off') {
        b64 = seal(b64);
      }
      setOut0(b64);
      lastEncodeKeyRef.current = key;
      setEncCount0((n) => n + 1);
      const saved = Math.max(0, Math.round((1 - b64.length / img0.fileSize) * 100));
      setStats0(
        `${small.width}×${small.height} px · ${usedQ} · input ${fmtBytes(img0.fileSize)} → string ${fmtBytes(b64.length)} (binary ≈ ${fmtBytes(Math.round(b64.length * 0.75))}) · ${saved}% smaller · re-encode #${encCount0 + 1}`
      );
      showToast('Encoded');
    }).catch((e: any) => showToast(e?.message || 'Encode failed'));
  }

  async function onView0() {
    if (!out0) return;
    setText1(out0);
    setActiveTab(1);
    await showImageFromB64(parseB64(unseal(out0) ?? out0));
  }

  async function showImageFromB64(b64: string) {
    await withBusyFeedback(async () => {
      if (!b64 || base64ToBytes(b64).length === 0) throw new Error('empty');
      const uri = await cacheBase64(b64, `view_${Date.now()}.png`);
      setImg1Uri(uri);
      setStatus1('Loaded.');
    }).catch(() => {
      setImg1Uri(null);
      setStatus1('Not a valid base64 image.');
      showToast('Not a valid base64 image');
    });
  }

  function onText1Change(text: string) {
    setText1(text);
    setImg1Uri(null);
    const { tag } = stripTag(text);
    if (tag === 'Sealed' || tag === 'JPG' || looksLikeBase64(text)) {
      setDetectedMode1('base64');
      setStatus1('Detected: ' + (tag === 'Sealed' ? 'Sealed base64' : 'Base64') + ' image — tap Show Image.');
    } else if (looksLikeAscii(text)) {
      setDetectedMode1('ascii');
      setStatus1('Detected: ASCII art — adjust scale and hit Render.');
    } else {
      setDetectedMode1(null);
      setStatus1('Paste ASCII art or a base64 string.');
    }
  }

  async function onRender1() {
    if (!text1.trim()) {
      showToast('Paste some text first');
      return;
    }
    if (detectedMode1 === 'base64') {
      await showImageFromB64(parseB64(unseal(text1) ?? text1));
    } else {
      await withBusyFeedback(async () => {
        const { rest } = stripTag(text1);
        const rgba = await asciiToRgbaAsync(rest, scale1);
        const uri = await cacheRgbaAsJpeg(rgba);
        setImg1Uri(uri);
      }).catch((e: any) => showToast(e?.message || 'Render failed'));
    }
  }

  async function onEncodeTT2() {
    if (!tt2EncodeInput.trim()) {
      showToast('Enter text to encode');
      return;
    }
    setTt2Busy(true);
    try {
      let result = `[${TT_LABELS[tt2EncodeType]}] ` + encodeText(tt2EncodeInput, tt2EncodeType);
      if (sealedMode !== 'off') {
        result = seal(result);
      }
      setTt2Result(result);
      showToast(`Encoded with ${TT_LABELS[tt2EncodeType]}`);
    } finally {
      setTt2Busy(false);
    }
  }

  async function onDecodeTT2() {
    if (!tt2DecodeInput.trim()) {
      showToast('Enter text to decode');
      return;
    }
    setTt2Busy(true);
    try {
      const autoDecode = tt2DecodeType === 'auto';
      const { tag, rest } = stripTag(tt2DecodeInput);
      let effective: TTType | 'sealed';
      if (tt2DecodeType !== 'auto') {
        effective = tt2DecodeType;
      } else if (tag && TT_FROM_TAG[tag]) {
        effective = TT_FROM_TAG[tag];
      } else {
        effective = detectTTType(rest) ?? 'base64';
      }
      const result = decodeText(tt2DecodeInput, effective);
      setTt2Result(result);
      setTt2SealedNote(effective === 'sealed' && !tag);
      setTt2Result(result);
      if (autoDecode) {
        setTt2DecodeType(effective);
        showToast((tag && TT_FROM_TAG[tag] ? `Tag detected: ${tag} — ` : 'Auto detected: ') + TT_LABELS[effective]);
      } else {
        showToast(`Decoded with ${TT_LABELS[effective]}`);
      }
    } finally {
      setTt2Busy(false);
    }
  }

  async function onCopyTT2() {
    if (!tt2Result) return;
    await copyText(tt2Result);
  }

  async function onShareTT2() {
    if (!tt2Result) return;
    shareText(tt2Result);
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.safe}>
        <LinearGradient colors={[C.bg1, C.bg2]} style={s.bg}>
          <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />

          <View style={s.header}>
            <View style={s.logoRow}>
              <LinearGradient colors={[C.accent, C.accent2]} style={s.logoMark}>
                <Text style={s.logoMarkText}>P</Text>
              </LinearGradient>
              <Text style={s.logoTitle}>PixStr</Text>
              <View style={s.sealBadge}>
                <Text style={s.sealBadgeText}>SEAL v1.1</Text>
              </View>
            </View>
            <Text style={s.headerSub}>Turn images into text and back again</Text>
            <Pressable
              onPress={toggleTheme}
              style={({ pressed }) => [s.themeBtn, pressed && s.btn2Pressed]}
              accessibilityLabel="Toggle theme"
            >
              <Text style={s.themeBtnIcon}>{theme === 'dark' ? '☀' : '☾'}</Text>
            </Pressable>
          </View>

          <Animated.View style={[s.body, { opacity: fade }]}>
            <View style={s.tabs}>
              {TABS.map((t, i) => (
                <Pressable
                  key={i}
                  onPress={() => setActiveTab(i)}
                  style={({ pressed }) => [
                    s.tabBtn,
                    activeTab === i && s.tabBtnActive,
                    i % 2 === 1 && s.tabBtnNoRight,
                    pressed && s.tabBtnPressed,
                  ]}
                >
                  <Text style={[s.tabText, activeTab === i && s.tabTextActive]} numberOfLines={1}>
                    {t.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
              {/* ============ TAB 0: IMAGE INPUT ============ */}
              {activeTab === 0 && (
                <>
                  <Card title="Input Image" hint="Pick from gallery or paste a base64 string.">
                    <PickArea img={img0} onPick={onPick0} onRemove={() => { setImg0(null); setMode0(null); setRec0(null); setAsciiText(''); setAsciiPreviewUri(null); setOut0(''); setStats0(''); setStatus0('Pick an image or paste base64 to begin.'); }} />
                    {img0 && (
                      <Text style={s.meta}>
                        {img0.width > 0 ? `${img0.width}x${img0.height} px` : ''} · {fmtBytes(img0.fileSize)}
                      </Text>
                    )}
                    <View style={s.b64InputRow}>
                      <TextInput
                        value={b64Input0}
                        onChangeText={setB64Input0}
                        placeholder="Or paste base64 / data:image URL here…"
                        placeholderTextColor={C.muted}
                        style={s.monoIn}
                        autoCorrect={false}
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                      <View style={{ marginTop: 10 }}>
                        <PrimaryBtn label="Load" onPress={onPasteB64_0} disabled={!b64Input0.trim()} busy={busy} />
                      </View>
                    </View>
                  </Card>

                  {img0 && mode0 === null && rec0 && (
                    <Card title="Choose Output Mode">
                      <Text style={s.meta}>
                        {img0.width}x{img0.height} px · {fmtBytes(img0.fileSize)}
                      </Text>
                      <Text style={s.recText}>
                        This image looks like {rec0 === 'ascii' ? 'ASCII art' : 'a photo'} — it will work better as{' '}
                        <Text style={{ color: C.accent, fontWeight: '700' }}>
                          {rec0 === 'ascii' ? 'ASCII' : 'an image (JPG)'}
                        </Text>.
                      </Text>
                      <Text style={s.recQuestion}>Do you want ASCII (Recommended) or JPG?</Text>
                      <View style={s.btnRow}>
                        {rec0 === 'ascii' ? (
                          <>
                            <PrimaryBtn label="ASCII (Recommended)" onPress={() => onModeSelect0('ascii')} busy={busy} />
                            <PrimaryBtn label="JPG" onPress={() => onModeSelect0('image')} busy={busy} style={{ backgroundColor: C.card2 }} textColor={C.text} />
                          </>
                        ) : (
                          <>
                            <PrimaryBtn label="JPG (Recommended)" onPress={() => onModeSelect0('image')} busy={busy} />
                            <PrimaryBtn label="ASCII" onPress={() => onModeSelect0('ascii')} busy={busy} style={{ backgroundColor: C.card2 }} textColor={C.text} />
                          </>
                        )}
                      </View>
                    </Card>
                  )}

                  {img0 && mode0 === 'ascii' && (
                    <Card title="ASCII Settings">
                      <SliderRow label="Character width" value={width} min={40} max={180} onChange={setWidth} />
                      <PrimaryBtn label="Convert to ASCII" onPress={onConvert0} disabled={!img0} busy={busy} />
                      <Text style={s.meta}>{status0}</Text>
                      <View style={{ marginTop: 6 }}>
                        <SecondaryBtn label="← Back to ASCII or JPG choice" onPress={onBackToChoice0} />
                      </View>
                    </Card>
                  )}

                  {img0 && mode0 === 'image' && (
                    <Card title="Image Encode Settings">
                      <View style={s.field}>
                        <Text style={s.fieldLabel}>Quality</Text>
                        <Seg
                          value={qualityMode0}
                          onChange={(v) => setQualityMode0(v as 'auto' | 'manual')}
                          options={[
                            { value: 'auto', label: 'Auto' },
                            { value: 'manual', label: 'Manual' },
                          ]}
                        />
                      </View>
                      {qualityMode0 === 'manual' && (
                        <SliderRow label="Quality" value={quality0} min={10} max={100} onChange={setQuality0} />
                      )}
                      <SliderRow label="Max dimension (px)" value={maxDim0} min={128} max={2000} step={8} onChange={setMaxDim0} />
                      <View style={s.field}>
                        <Text style={s.fieldLabel}>Sealed</Text>
                        <Seg value={sealedMode} onChange={(v) => saveSealedMode(v as 'off' | 'on' | 'auto')} options={SEAL_OPTIONS} />
                      </View>
                      {sealedMode === 'auto' && (
                        <Text style={s.warnText}>Auto may not be as reliable as you think — verify your message after decoding.</Text>
                      )}
                      <PrimaryBtn label="Encode" onPress={onEncode0} disabled={!img0} busy={busy} />
                      <Text style={s.meta}>{status0}</Text>
                      <View style={{ marginTop: 6 }}>
                        <SecondaryBtn label="← Back to ASCII or JPG choice" onPress={onBackToChoice0} />
                      </View>
                    </Card>
                  )}

                  {(asciiPreviewUri || asciiText || busy) && mode0 === 'ascii' && (
                    <Card title="ASCII Result">
                      {busy && !asciiText && <SkeletonLines />}
                      {asciiPreviewUri && (
                        <Image source={{ uri: asciiPreviewUri }} style={s.resultImg} resizeMode="contain" />
                      )}
                      {asciiText ? (
                        <View>
                          <TextInput value={truncateWrapped(asciiText, charsPerLine(outW))} multiline editable={false} style={s.monoOut} onLayout={(e) => setOutW(e.nativeEvent.layout.width)} />
                          {truncationNote(asciiText, charsPerLine(outW)) ? (
                            <Text style={s.truncNote}>{truncationNote(asciiText, charsPerLine(outW))}</Text>
                          ) : null}
                        </View>
                      ) : null}
                      <View style={s.btnRow}>
                        <SecondaryBtn label="Copy" onPress={() => copyText(asciiText)} />
                        <SecondaryBtn label="Save JPEG" onPress={() => asciiPreviewUri && saveToGallery(asciiPreviewUri)} />
                        <SecondaryBtn label="Share" onPress={() => shareText(asciiText)} />
                      </View>
                    </Card>
                  )}

                  {out0 && mode0 === 'image' && (
                    <Card title="Encoded Result">
                      <TextInput value={truncateWrapped(out0, charsPerLine(outW))} multiline editable={false} style={s.monoOut} onLayout={(e) => setOutW(e.nativeEvent.layout.width)} />
                      {out0.startsWith('[Sealed] ') && (
                        <Text style={s.bubble}>Sealed — older clients can't read this.</Text>
                      )}
                      {truncationNote(out0, charsPerLine(outW)) ? (
                        <Text style={s.truncNote}>{truncationNote(out0, charsPerLine(outW))}</Text>
                      ) : null}
                      <Text style={[s.meta, { color: C.ok }]}>{stats0}</Text>
                      <View style={s.btnRow}>
                        <SecondaryBtn label="Copy" onPress={() => copyText(out0)} />
                        <SecondaryBtn label="View" onPress={onView0} />
                      </View>
                    </Card>
                  )}
                </>
              )}

              {/* ============ TAB 1: TEXT INPUT ============ */}
              {activeTab === 1 && (
                <Card title="Paste Text" hint="ASCII art or a base64 string (plain or data:image URL).">
                  <TruncatedInput
                    value={text1}
                    onChangeText={onText1Change}
                    placeholder="Paste ASCII art or base64 here…"
                    placeholderTextColor={C.muted}
                    style={s.monoIn}
                    autoCorrect={false}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  {detectedMode1 === 'base64' && (
                    <View style={s.detectedRow}>
                      <Text style={{ color: C.accent, fontWeight: '600', marginRight: 8 }}>Detected: Base64 Image</Text>
                    </View>
                  )}
                  {detectedMode1 === 'ascii' && (
                    <View style={s.detectedRow}>
                      <Text style={{ color: C.accent, fontWeight: '600', marginRight: 8 }}>Detected: ASCII Art</Text>
                      <SliderRow label="Pixel scale" value={scale1} min={1} max={32} onChange={setScale1} />
                    </View>
                  )}
                  <PrimaryBtn label={detectedMode1 === 'base64' ? 'Show Image' : 'Render to Image'} onPress={onRender1} busy={busy} />
                  {busy && !img1Uri && <LoadingBar />}
                  {img1Uri && (
                    <View>
                      <Image source={{ uri: img1Uri }} style={s.resultImg} resizeMode="contain" />
                      <SecondaryBtn label="Save JPEG to gallery" onPress={() => saveToGallery(img1Uri)} />
                    </View>
                  )}
                  <Text style={s.meta}>{status1}</Text>
                </Card>
              )}

              {/* ============ TAB 2: TEXT → TEXT ============ */}
              {activeTab === 2 && (
                <>
                  <Card title="Encode / Obfuscate" hint="Transform text with various encoding methods.">
                    <TruncatedInput
                      value={tt2EncodeInput}
                      onChangeText={setTt2EncodeInput}
                      placeholder="Enter text to encode…"
                      placeholderTextColor={C.muted}
                      style={s.monoIn}
                      autoCorrect={false}
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    <View style={s.field}>
                      <Text style={s.fieldLabel}>Method</Text>
                      <Seg value={tt2EncodeType} onChange={setTt2EncodeType} options={TT_TYPES} />
                    </View>
                    <View style={s.field}>
                      <Text style={s.fieldLabel}>Sealed</Text>
                      <Seg value={sealedMode} onChange={(v) => saveSealedMode(v as 'off' | 'on' | 'auto')} options={SEAL_OPTIONS} />
                    </View>
                    {sealedMode === 'auto' && (
                      <Text style={s.warnText}>Auto may not be as reliable as you think — verify your message after decoding.</Text>
                    )}
                    <PrimaryBtn label={tt2Busy ? 'Working…' : 'Encode'} onPress={onEncodeTT2} disabled={!tt2EncodeInput.trim()} busy={tt2Busy} />
                  </Card>

                  <Card title="Decode / Deobfuscate" hint="Reverse the transformation.">
                    <TruncatedInput
                      value={tt2DecodeInput}
                      onChangeText={setTt2DecodeInput}
                      placeholder="Enter encoded text to decode…"
                      placeholderTextColor={C.muted}
                      style={s.monoIn}
                      autoCorrect={false}
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    <View style={s.field}>
                      <Text style={s.fieldLabel}>Method</Text>
                      <Seg value={tt2DecodeType} onChange={setTt2DecodeType} options={TT_DECODE_TYPES} />
                    </View>
                    <PrimaryBtn label={tt2Busy ? 'Working…' : 'Decode'} onPress={onDecodeTT2} disabled={!tt2DecodeInput.trim()} busy={tt2Busy} />
                  </Card>

                  {tt2Result && (
                    <Card title="Result">
                      <TextInput value={truncateWrapped(tt2Result, charsPerLine(outW))} multiline editable={false} style={s.monoOut} onLayout={(e) => setOutW(e.nativeEvent.layout.width)} />
                      {tt2Result.startsWith('[Sealed] ') && (
                        <Text style={s.bubble}>Sealed — older clients can't read this.</Text>
                      )}
                      {tt2SealedNote && (
                        <Text style={s.warnText}>Sealed detected without a tag — auto may not be as reliable as you think.</Text>
                      )}
                      <View style={s.btnRow}>
                        <SecondaryBtn label="Copy" onPress={onCopyTT2} />
                        <SecondaryBtn label="Share" onPress={onShareTT2} />
                      </View>
                    </Card>
                  )}
                </>
              )}
            </ScrollView>

            {toastMsg && (
              <View style={s.toast}>
                <Text style={s.toastText}>{toastMsg}</Text>
              </View>
            )}
          </Animated.View>
        </LinearGradient>

        <Modal visible={sealDialogVisible} transparent animationType="fade" onRequestClose={() => saveSealedMode('off')}>
          <View style={s.dialogOverlay}>
            <View style={s.dialogCard}>
              <Text style={s.dialogTitle}>Enable Sealing?</Text>
              <Text style={s.dialogText}>
                Sealing hides your encoded text inside standard encodings (base64, hex…) with a secret salt, so online
                decoders can't read it. Older clients can't read sealed messages.
              </Text>
              {SEAL_OPTIONS.map((o) => (
                <Pressable
                  key={o.value}
                  onPress={() => saveSealedMode(o.value)}
                  style={({ pressed }) => [s.dialogBtn, pressed && s.btn2Pressed]}
                >
                  <Text style={s.dialogBtnText}>
                    {o.label === 'Off' ? 'Off — no sealing' : o.label === 'On' ? 'On — always seal' : 'Auto — seal + warn'}
                  </Text>
                </Pressable>
              ))}
              <Pressable onPress={() => saveSealedMode('off')} style={({ pressed }) => [s.dialogSkip, pressed && s.btn2Pressed]}>
                <Text style={s.dialogSkipText}>Not now</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Card({ title, hint, children }: { title?: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {hint ? <Text style={s.cardHint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

function PickArea({ img, onPick, onRemove }: { img: Img | null; onPick: () => void; onRemove: () => void }) {
  return (
    <Pressable onPress={onPick} style={[s.dropzone, img ? s.dropzoneFilled : null]}>
      {img ? (
        <>
          <Image source={{ uri: img.uri }} style={s.dropPreview} resizeMode="contain" />
          <Text style={s.dropName} numberOfLines={1}>
            {decodeURIComponent(img.uri.split('/').pop() ?? 'image')}
          </Text>
          <Pressable onPress={onRemove} style={s.removeBtn} hitSlop={10}>
            <Text style={s.removeText}>Remove</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={s.dropIcon}>▦</Text>
          <Text style={s.dropText}>Tap to choose an image</Text>
        </>
      )}
    </Pressable>
  );
}

function TruncatedInput({
  value,
  onChangeText,
  placeholder,
  placeholderTextColor,
  style,
  autoCorrect,
  autoCapitalize,
  spellCheck,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  placeholderTextColor: string;
  style: any;
  autoCorrect?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  spellCheck?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const shown = focused || value.length <= MAX_DISPLAY ? value : truncate(value);
  return (
    <View>
      <TextInput
        value={shown}
        onChangeText={onChangeText}
        multiline
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        style={style}
        autoCorrect={autoCorrect}
        autoCapitalize={autoCapitalize}
        spellCheck={spellCheck}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {!focused && value.length > MAX_DISPLAY && (
        <Text style={s.truncNote}>Showing first {MAX_DISPLAY} chars — tap to edit the full text.</Text>
      )}
    </View>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={s.field}>
      <View style={s.fieldLabelRow}>
        <Text style={s.fieldLabel}>{label}</Text>
        <View style={s.badge}>
          <Text style={s.badgeText}>{value}</Text>
        </View>
      </View>
      <Slider
        style={s.slider}
        minimumValue={min}
        maximumValue={max}
        step={step ?? 1}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={C.accent}
        maximumTrackTintColor={C.border}
        thumbTintColor="#ffffff"
      />
    </View>
  );
}

function Seg<TOption extends string>({
  value,
  onChange,
  options,
}: {
  value: TOption;
  onChange: (v: TOption) => void;
  options: readonly { value: TOption; label: string }[];
}) {
  return (
    <View style={s.seg}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          onPress={() => onChange(o.value)}
          style={({ pressed }) => [s.segBtn, value === o.value && s.segBtnActive, pressed && s.segBtnPressed]}
        >
          <Text style={[s.segText, value === o.value && s.segTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function PrimaryBtn({
  label,
  onPress,
  disabled,
  busy,
  style,
  textColor,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  style?: any;
  textColor?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const pulse = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.96, duration: 90, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  };
  const grad: readonly [string, string] = style?.backgroundColor === C.card2 ? [C.card2, C.card2] : [C.accent, C.accent2];
  return (
    <Pressable
      onPress={() => {
        if (disabled || busy) return;
        pulse();
        onPress();
      }}
      disabled={disabled || busy}
      style={style}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <LinearGradient
          colors={grad}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[s.btnGrad, (disabled || busy) && s.btnDisabled]}
        >
          {busy ? (
            <View style={s.btnBusy}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={s.btnText}>Working…</Text>
            </View>
          ) : (
            <Text style={[s.btnText, textColor && { color: textColor }]}>{label}</Text>
          )}
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
}

function SecondaryBtn({ label, onPress }: { label: string; onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const pulse = () => {
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.96, duration: 90, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  };
  return (
    <Pressable
      onPress={() => {
        pulse();
        onPress();
      }}
      style={({ pressed }) => [s.btn2, pressed && s.btn2Pressed]}
    >
      <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
        <Text style={s.btn2Text}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

function SkeletonLines() {
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 500, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  const widths = ['100%', '94%', '88%', '97%', '90%', '100%', '95%', '100%'];
  return (
    <Animated.View style={[s.skeleton, { opacity }]}>
      {widths.map((w, i) => (
        <View key={i} style={[s.skeletonLine, { width: w as any }]} />
      ))}
    </Animated.View>
  );
}

function LoadingBar() {
  const x = useRef(new Animated.Value(-120)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(x, { toValue: 320, duration: 900, useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  return (
    <View style={s.loadTrack}>
      <Animated.View style={[s.loadFill, { transform: [{ translateX: x }] }]} />
    </View>
  );
}

function buildStyles(): any {
  return {
    safe: { flex: 1, backgroundColor: C.bg1 },
    bg: { flex: 1 },
    header: { paddingTop: 16, paddingBottom: 12, alignItems: 'center' },
    logoRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    logoMark: {
      width: 34,
      height: 34,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    logoMarkText: { color: '#fff', fontWeight: '800', fontSize: 16 },
    logoTitle: { color: C.text, fontSize: 20, fontWeight: '700', letterSpacing: 0.3 },
    sealBadge: {
      backgroundColor: '#f0a835',
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    sealBadgeText: { color: '#241a03', fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5 },
    warnText: {
      color: '#d99a1e',
      fontSize: 12.5,
      backgroundColor: 'rgba(217,154,30,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(240,168,53,0.45)',
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginBottom: 14,
      lineHeight: 18,
    },
    bubble: {
      color: '#d99a1e',
      fontSize: 12.5,
      backgroundColor: 'rgba(217,154,30,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(240,168,53,0.45)',
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginTop: 10,
    },
    dialogOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    dialogCard: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: C.cardBg,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 18,
      padding: 20,
    },
    dialogTitle: { color: C.text, fontSize: 17, fontWeight: '700', marginBottom: 8 },
    dialogText: { color: C.muted, fontSize: 13.5, lineHeight: 20, marginBottom: 16 },
    dialogBtn: {
      backgroundColor: C.card2,
      borderWidth: 1,
      borderColor: C.border2,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: 'center',
      marginBottom: 10,
    },
    dialogBtnText: { color: C.text, fontWeight: '600', fontSize: 14 },
    dialogSkip: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
    dialogSkipText: { color: C.muted, fontSize: 13.5 },
    headerSub: { color: C.muted, fontSize: 12.5, marginTop: 4 },
    themeBtn: {
      position: 'absolute',
      right: 18,
      top: 16,
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.card2,
      borderWidth: 1,
      borderColor: C.border2,
    },
    themeBtnIcon: { fontSize: 18, color: C.text },
    body: { flex: 1 },

    tabs: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginHorizontal: 16,
      backgroundColor: C.tabsBg,
      borderWidth: 1,
      borderColor: C.border,
      padding: 6,
      borderRadius: 14,
      gap: 6,
    },
    tabBtn: {
      width: '31.3%',
      paddingVertical: 10,
      borderRadius: 10,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.tabBtn,
    },
    tabBtnActive: { backgroundColor: C.accent, borderColor: C.accent },
    tabBtnNoRight: { marginRight: 0 },
    tabBtnPressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
    tabText: { color: C.muted, fontSize: 11.5, fontWeight: '600' },
    tabTextActive: { color: '#fff' },

    scroll: { flex: 1, marginTop: 14 },
    scrollContent: { paddingHorizontal: 16, paddingBottom: 60 },

    card: {
      backgroundColor: C.cardBg,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 16,
      padding: 16,
      marginBottom: 14,
    },
    cardTitle: { color: C.text, fontSize: 15, fontWeight: '600', marginBottom: 2 },
    cardHint: { color: C.muted, fontSize: 12.5, marginBottom: 12 },

    field: { marginBottom: 14 },
    fieldLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
    fieldLabel: { color: C.muted, fontSize: 12.5 },
    badge: { backgroundColor: C.card2, borderWidth: 1, borderColor: C.border, paddingHorizontal: 9, paddingVertical: 2, borderRadius: 999 },
    badgeText: { color: C.accent, fontSize: 12, fontVariant: ['tabular-nums'] },
    slider: { width: '100%', height: 34 },

    seg: { flexDirection: 'row', gap: 6, backgroundColor: C.segBg, borderWidth: 1, borderColor: C.border, padding: 4, borderRadius: 12 },
    segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
    segBtnActive: { backgroundColor: C.card2, borderWidth: 1, borderColor: C.border2 },
    segBtnPressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
    segText: { color: C.muted, fontWeight: '600', fontSize: 13 },
    segTextActive: { color: C.text },

    dropzone: {
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: C.border2,
      borderRadius: 16,
      padding: 22,
      alignItems: 'center',
    },
    dropzoneFilled: { borderStyle: 'solid', borderColor: C.ok },
    dropIcon: { color: C.muted, fontSize: 30, marginBottom: 6 },
    dropText: { color: C.muted, fontSize: 13 },
    dropPreview: { width: '100%', height: 170, borderRadius: 10, backgroundColor: C.input },
    dropName: { color: C.text, fontSize: 12.5, marginTop: 8, maxWidth: '90%' },
    removeBtn: { marginTop: 10, backgroundColor: C.dangerBg, borderWidth: 1, borderColor: C.dangerBorder, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 5 },
    removeText: { color: C.danger, fontSize: 12.5 },

    monoIn: {
      width: '100%',
      minHeight: 140,
      backgroundColor: C.input,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 12,
      padding: 12,
      color: C.text,
      fontFamily: mono,
      fontSize: 11,
      lineHeight: 15,
      textAlignVertical: 'top',
      marginBottom: 14,
    },
    monoOut: {
      width: '100%',
      minHeight: 140,
      backgroundColor: C.input,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 12,
      padding: 12,
      color: C.text,
      fontFamily: mono,
      fontSize: 10,
      lineHeight: 13,
      textAlignVertical: 'top',
      marginTop: 12,
    },

    resultImg: {
      width: '100%',
      height: 300,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.input,
      marginTop: 12,
    },

    btnGrad: { paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
    btnDisabled: { opacity: 0.45 },
    btnBusy: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    btnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
    btn2: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 10,
      alignItems: 'center',
      backgroundColor: C.card2,
      borderWidth: 1,
      borderColor: C.border2,
    },
    btn2Pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
    btn2Text: { color: C.text, fontSize: 13, fontWeight: '600' },
    btnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },

    skeleton: { marginTop: 12, gap: 8 },
    skeletonLine: { height: 12, borderRadius: 4, backgroundColor: C.skel, opacity: 0.9 },
    loadTrack: { marginTop: 12, height: 6, borderRadius: 3, backgroundColor: C.skel, overflow: 'hidden' },
    loadFill: { height: 6, width: 90, borderRadius: 3, backgroundColor: C.accent },

    meta: { color: C.muted, fontSize: 12, marginTop: 10 },
    truncNote: { color: C.muted, fontSize: 11.5, marginTop: 6 },

    toast: {
      position: 'absolute',
      bottom: 28,
      alignSelf: 'center',
      backgroundColor: C.toastBg,
      borderWidth: 1,
      borderColor: C.border2,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 12,
    },
    toastText: { color: C.text, fontSize: 13 },

    b64InputRow: { marginTop: 12 },
    recText: { color: C.text, fontSize: 13, marginBottom: 6, lineHeight: 18 },
    recQuestion: { color: C.text, fontSize: 14, fontWeight: '700', marginBottom: 12 },
    detectedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 },
  };
}