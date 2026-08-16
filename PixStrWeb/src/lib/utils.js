// Shared utilities: truncation, base64, formatting, clipboard, download.

export const MAX_DISPLAY = 4000;
export const MAX_OUTPUT_LINES = 20;

export function truncate(s, n = MAX_DISPLAY) {
  if (s.length <= n) return s;
  return s.slice(0, n) + '\n…[+' + (s.length - n) + ' chars hidden]';
}

// Show only the first MAX_OUTPUT_LINES *wrapped* lines for display (a line that
// wraps in the box counts as multiple wrapped lines); copy/share always use the
// full untruncated text. cpl = chars that fit per wrapped line.
export function wrappedLineCount(s, cpl) {
  if (cpl < 1) cpl = 1;
  let n = 0;
  for (const line of s.split('\n')) n += Math.max(1, Math.ceil(line.length / cpl));
  return n;
}

export function truncateWrapped(s, cpl) {
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

export function truncationNote(s, cpl) {
  return wrappedLineCount(s, cpl) > MAX_OUTPUT_LINES
    ? `Showing first ${MAX_OUTPUT_LINES} wrapped lines — Copy for the full text.`
    : '';
}

// Monospace glyph advance is ~0.6× font size. Measure the box's client width.
export function charsPerLine(ta) {
  const cs = getComputedStyle(ta);
  const fontSize = parseFloat(cs.fontSize) || 12;
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const usable = Math.max(60, (ta.clientWidth || 320) - pad);
  return Math.max(1, Math.floor(usable / (fontSize * 0.6)));
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Recognized encoding tags, e.g. '[JPG] ', '[ASCII]\n' or '[Base64] '.
const TAG_RE = /^\[(Base64|Base32|Hex|Z85|JPG|PNG|ASCII|Sealed)\]\s*/i;
export const TAGS = {
  base64: 'Base64',
  base32: 'Base32',
  hex: 'Hex',
  z85: 'Z85',
  jpg: 'JPG',
  png: 'PNG',
  ascii: 'ASCII',
  sealed: 'Sealed',
};

// Strip a leading tag; returns { tag, rest } (tag is null when absent).
export function stripTag(s) {
  const text = String(s);
  const trimmed = text.trim();
  const m = trimmed.match(TAG_RE);
  if (!m) return { tag: null, rest: text };
  return { tag: TAGS[m[1]] ?? m[1], rest: trimmed.slice(m[0].length) };
}

export function parseB64(raw) {
  const { rest } = stripTag(raw);
  let s = rest.trim();
  const m = s.match(/^data:image\/[a-z0-9+.-]+;base64,([\s\S]*)$/i);
  if (m) s = m[1];
  return s.replace(/\s/g, '');
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
  return btoa(bin);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function download(cv, name) {
  const a = document.createElement('a');
  a.href = cv.toDataURL('image/png');
  a.download = name;
  a.click();
}