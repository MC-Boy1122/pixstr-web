import './style.css';
import { TT_TYPES, encodeText, decodeText, tagFor, typeFromTag, detectType, seal, unseal } from './lib/textcodec.js';
import {
  RAMP,
  loadImageFile,
  b64ToCanvas,
  showCanvas,
  asciiFromCanvas,
  asciiToCanvas,
  encodeJpegB64,
  aggressiveDownscale,
  autoJpegQuality,
  recommendMode,
} from './lib/image.js';
import {
  MAX_DISPLAY,
  truncate,
  truncateWrapped,
  truncationNote,
  charsPerLine,
  fmtBytes,
  escapeHtml,
  parseB64,
  base64ToBytes,
  stripTag,
  copy,
  download,
} from './lib/utils.js';

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

// ---------- Sealed mode (persistent 3-way toggle) ----------
const SEALED_KEY = 'pixstr.sealedMode';
let sealedMode = localStorage.getItem(SEALED_KEY);
if (sealedMode !== 'off' && sealedMode !== 'on' && sealedMode !== 'auto') {
  sealedMode = 'off';
  if (localStorage.getItem(SEALED_KEY) === null) $('sealDialog').style.display = '';
}

function applySealedUI() {
  $('ttSealed').value = sealedMode;
  $('imgSealed').value = sealedMode;
  $('ttSealedWarn').style.display = sealedMode === 'auto' ? '' : 'none';
  $('imgSealedWarn').style.display = sealedMode === 'auto' ? '' : 'none';
}

function saveSealedMode(mode) {
  sealedMode = mode;
  localStorage.setItem(SEALED_KEY, mode);
  $('sealDialog').style.display = 'none';
  applySealedUI();
}

applySealedUI();
$('ttSealed').addEventListener('change', (e) => saveSealedMode(e.target.value));
$('imgSealed').addEventListener('change', (e) => saveSealedMode(e.target.value));
document.querySelectorAll('#sealDialog [data-seal]').forEach((btn) => {
  btn.addEventListener('click', () => saveSealedMode(btn.dataset.seal));
});

function showSealBubble(shown, id) {
  $(id).style.display = shown ? '' : 'none';
}

// ---------- theme ----------
const root = document.documentElement;
const storedTheme = localStorage.getItem('pixstr-theme');
let manualTheme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : null;

function currentIsDark() {
  return (manualTheme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
}

function themeIcon() {
  $('themeBtn').textContent = currentIsDark() ? '☀' : '☾';
}
function setRootTheme() {
  if (manualTheme) root.setAttribute('data-theme', manualTheme);
  else root.removeAttribute('data-theme');
}
setRootTheme();
themeIcon();

$('themeBtn').addEventListener('click', () => {
  const fade = $('fade');
  fade.style.opacity = '1';
  setTimeout(() => {
    manualTheme = currentIsDark() ? 'light' : 'dark';
    localStorage.setItem('pixstr-theme', manualTheme);
    setRootTheme();
    themeIcon();
    fade.style.opacity = '0';
  }, 300);
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (!manualTheme) themeIcon();
});

// ---------- truncated inputs ----------
function bindTruncatedInput(taId) {
  const ta = $(taId);
  ta._full = ta.value;
  ta.addEventListener('focus', () => {
    ta.value = ta._full;
  });
  ta.addEventListener('blur', () => {
    ta.value = truncate(ta.value);
  });
  ta.addEventListener('input', () => {
    ta._full = ta.value;
  });
}

function readFullInput(ta) {
  return ta._full !== undefined ? ta._full : ta.value;
}

function showTruncated(full, ta, noteId) {
  fullAscii = full;
  const cpl = charsPerLine(ta);
  ta.value = truncateWrapped(full, cpl);
  const note = $(noteId);
  note.textContent = truncationNote(full, cpl);
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    $(btn.dataset.panel).classList.add('active');
  });
});

// ---------- sliders (fill track + value badge) ----------
function bindSlider(id, valId, fmt) {
  const s = $(id);
  const out = $(valId);
  const paint = () => {
    const pct = ((s.value - s.min) / (s.max - s.min)) * 100;
    s.style.setProperty('--fill', pct + '%');
    out.textContent = fmt ? fmt(s.value) : s.value;
  };
  s.addEventListener('input', paint);
  paint();
}
bindSlider('width', 'widthVal');
bindSlider('scale', 'scaleVal');
bindSlider('quality', 'qualityVal');
bindSlider('maxDim', 'maxDimVal');
bindTruncatedInput('b64In');
bindTruncatedInput('inC');

// ---------- quality segmented control ----------
let qualityMode = 'auto';
document.querySelectorAll('#qualityModeSeg button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#qualityModeSeg button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    qualityMode = btn.dataset.mode;
    $('qualityField').style.display = qualityMode === 'auto' ? 'none' : '';
  });
});

// ---------- image state ----------
let srcCv = null; // loaded source canvas (not yet downscaled)
let srcSize = 0; // original byte size for stats
let imgMode = null; // 'ascii' | 'image'
let fullAscii = '';
let fullCode = '';
let encodeCount = 0;
let srcToken = 0;
let lastEncodeKey = null;

function srcInfo() {
  $('imgInfo').textContent = srcCv.width + ' × ' + srcCv.height + ' px · ' + fmtBytes(srcSize);
  $('imgInfo').hidden = false;
}

function setImageMode(mode) {
  imgMode = mode;
  $('modeCard').style.display = 'none';
  $('asciiSettings').style.display = mode === 'ascii' ? '' : 'none';
  $('encodeSettings').style.display = mode === 'image' ? '' : 'none';
  $('asciiOut').classList.remove('show');
  $('codeOut').classList.remove('show');
  if (mode === 'ascii') $('statusA').textContent = 'Ready — adjust width and hit Convert.';
  else $('statusE').textContent = 'Ready — adjust settings and hit Encode.';
}

function presentChoice(cv, sizeBytes) {
  const rec = recommendMode(cv);
  $('recText').textContent =
    'This image looks like ' +
    (rec === 'ascii' ? 'ASCII art' : 'a photo') +
    ' — it will work better as ' +
    (rec === 'ascii' ? 'ASCII' : 'an image (JPG)') +
    '.';
  const asciiBtn = $('asciiModeBtn');
  const imgBtn = $('imgModeBtn');
  asciiBtn.textContent = rec === 'ascii' ? 'ASCII (Recommended)' : 'ASCII';
  asciiBtn.classList.toggle('secondary', rec !== 'ascii');
  imgBtn.textContent = rec === 'image' ? 'JPG (Recommended)' : 'JPG';
  imgBtn.classList.toggle('secondary', rec !== 'image');
  $('modeCard').style.display = '';
  $('asciiSettings').style.display = 'none';
  $('encodeSettings').style.display = 'none';
  $('asciiOut').classList.remove('show');
  $('codeOut').classList.remove('show');
  imgMode = null;
  srcSize = sizeBytes ?? cv.width * cv.height * 4;
}

function clearImage() {
  srcCv = null;
  imgMode = null;
  $('imgInfo').hidden = true;
  $('modeCard').style.display = 'none';
  $('asciiSettings').style.display = 'none';
  $('encodeSettings').style.display = 'none';
  $('asciiOut').classList.remove('show');
  $('codeOut').classList.remove('show');
  $('fileA').value = '';
  renderEmpty($('dzA'));
  $('statusA').textContent = '';
  $('statusE').textContent = '';
}

// ---------- dropzone ----------
function bindDropzone(zoneId, inputId, onFile) {
  const zone = $(zoneId);
  const input = $(inputId);
  zone.addEventListener('click', (e) => {
    if (!e.target.closest('.remove')) input.click();
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  });
  input.addEventListener('change', () => {
    const f = input.files[0];
    if (f) onFile(f);
  });
}

function renderEmpty(zone) {
  zone.classList.remove('has-img');
  zone.innerHTML =
    '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.35-4.35a1 1 0 0 0-1.4 0L9 17"/></svg>' +
    '<p>Click to choose an image, or drop one here</p>';
}

function renderFilled(zone, imgSrc, name) {
  zone.classList.add('has-img');
  zone.innerHTML =
    '<img src="' +
    imgSrc +
    '" alt="preview"><p>' +
    escapeHtml(name) +
    '</p><button class="remove" type="button">Remove</button>';
  zone.querySelector('.remove').addEventListener('click', (e) => {
    e.stopPropagation();
    clearImage();
  });
}

// ============ IMAGE INPUT ============
bindDropzone('dzA', 'fileA', (file) => {
  loadImageFile(
    file,
    null,
    (cv) => {
      srcCv = cv;
      srcSize = file.size;
      srcToken++;
      srcInfo();
      const url = URL.createObjectURL(file);
      renderFilled($('dzA'), url, file.name);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      presentChoice(cv, file.size);
    },
    () => toast('Could not load that file.')
  );
});

$('loadB64Btn').addEventListener('click', async () => {
  const raw = readFullInput($('b64In'));
  if (!raw.trim()) {
    toast('Paste a base64 string first');
    return;
  }
  const unsealed = unseal(raw) ?? raw;
  const b64 = parseB64(unsealed);
  if (!b64 || !b64.length) {
    toast('Not a valid base64 string');
    return;
  }
  try {
    const bytes = base64ToBytes(b64);
    const cv = await b64ToCanvas(b64);
    srcCv = cv;
    srcSize = bytes.length;
    srcToken++;
    srcInfo();
    renderFilled($('dzA'), cv.toDataURL('image/png'), 'pasted.png');
    presentChoice(cv, bytes.length);
    $('b64In')._full = '';
    $('b64In').value = '';
  } catch {
    toast('Not a recognized image format');
  }
});

$('asciiModeBtn').addEventListener('click', () => setImageMode('ascii'));
$('imgModeBtn').addEventListener('click', () => setImageMode('image'));

function backToChoice() {
  imgMode = null;
  $('modeCard').style.display = '';
  $('asciiSettings').style.display = 'none';
  $('encodeSettings').style.display = 'none';
  $('asciiOut').classList.remove('show');
  $('codeOut').classList.remove('show');
}
$('backA').addEventListener('click', backToChoice);
$('backE').addEventListener('click', backToChoice);

$('convertBtn').addEventListener('click', async () => {
  if (!srcCv) {
    toast('Pick an image first');
    return;
  }
  const cols = parseInt($('width').value, 10);
  const btn = $('convertBtn');
  btn.classList.add('busy');
  btn.textContent = 'Working…';
  $('skelA').hidden = false;
  const t0 = Date.now();
  try {
    const raw = asciiFromCanvas(srcCv, cols);
    const text = '[ASCII]\n' + raw;
    const preview = asciiToCanvas(raw, 3);
    showCanvas(preview, $('renderA'));
    showTruncated(text, $('outA'), 'truncNoteA');
    $('asciiOut').classList.add('show');
    $('statusA').textContent = 'Done — ' + cols + ' wide, ' + raw.length + ' characters.';
  } finally {
    const el = Date.now() - t0;
    if (el < 650) await new Promise((r) => setTimeout(r, 650 - el));
    $('skelA').hidden = true;
    btn.classList.remove('busy');
    btn.textContent = 'Convert to ASCII';
  }
});

$('copyA').addEventListener('click', async () => {
  if (!fullAscii) return;
  await copy(fullAscii);
  toast('Copied to clipboard');
});
$('saveA').addEventListener('click', () => {
  const cv = $('renderA');
  if (cv.hidden) return;
  download(cv, 'ascii.png');
});
$('shareA').addEventListener('click', async () => {
  if (!fullAscii) return;
  if (navigator.share) {
    try {
      await navigator.share({ text: fullAscii });
      return;
    } catch {}
  }
  await copy(fullAscii);
  toast('Copied to clipboard');
});

$('encodeBtn').addEventListener('click', async () => {
  if (!srcCv) {
    toast('Pick an image first');
    return;
  }
  const key = srcToken + '|' + qualityMode + '|' + $('quality').value + '|' + $('maxDim').value;
  if (lastEncodeKey === key) {
    toast('Settings unchanged — nothing to re-encode');
    return;
  }
  const btn = $('encodeBtn');
  btn.classList.add('busy');
  btn.textContent = 'Working…';
  const t0 = Date.now();
  try {
    const maxDim = parseInt($('maxDim').value, 10);
    const scale = Math.min(1, maxDim / Math.max(srcCv.width, srcCv.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(srcCv.width * scale));
    cv.height = Math.max(1, Math.round(srcCv.height * scale));
    cv.getContext('2d').drawImage(srcCv, 0, 0, cv.width, cv.height);

    let small = aggressiveDownscale(cv);
    let b64;
    let usedQ;
    if (qualityMode === 'auto') {
      const q = autoJpegQuality(small);
      b64 = encodeJpegB64(small, q);
      usedQ = 'auto q' + q;
    } else {
      const quality = parseInt($('quality').value, 10);
      b64 = encodeJpegB64(small, quality);
      usedQ = 'q' + quality;
    }
    b64 = '[JPG] ' + b64;
    if (sealedMode !== 'off') {
      b64 = seal(b64);
    }
    encodeCount++;
    lastEncodeKey = key;
    const outE = $('outE');
    outE.value = truncateWrapped(b64, charsPerLine(outE));
    fullCode = b64;
    $('truncNoteE').textContent = truncationNote(b64, charsPerLine(outE));
    const strSize = b64.length;
    const saved = Math.max(0, Math.round((1 - strSize / srcSize) * 100));
    $('statsE').innerHTML =
      '<span class="ok">' +
      small.width +
      '×' +
      small.height +
      ' px</span> · ' +
      usedQ +
      ' · input ' +
      fmtBytes(srcSize) +
      ' → string ' +
      fmtBytes(strSize) +
      ' (binary ≈ ' +
      fmtBytes(Math.round(strSize * 0.75)) +
      ') · ' +
      saved +
      '% smaller · re-encode #' +
      encodeCount;
    $('codeOut').classList.add('show');
    showSealBubble(b64.startsWith('[Sealed] '), 'codeSealBubble');
    toast('Encoded');
  } finally {
    const el = Date.now() - t0;
    if (el < 650) await new Promise((r) => setTimeout(r, 650 - el));
    btn.classList.remove('busy');
    btn.textContent = 'Encode';
  }
});

$('copyE').addEventListener('click', async () => {
  if (!fullCode) return;
  await copy(fullCode);
  toast('Copied to clipboard');
});
$('viewE').addEventListener('click', () => {
  $('inC')._full = fullCode;
  $('inC').value = truncate(fullCode);
  detectText(fullCode);
  document.querySelector('[data-panel="textInput"]').click();
  $('goBtn').click();
});

// ============ TEXT INPUT ============
function looksLikeBase64(s) {
  const { rest } = stripTag(s);
  const trimmed = rest.trim();
  if (!trimmed || trimmed.length < 20) return false;
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length > 3) return false;
  const re = /^[A-Za-z0-9+/=]+$/;
  return lines.every((l) => re.test(l.replace(/\s/g, '')));
}

function looksLikeAscii(s) {
  const { rest } = stripTag(s);
  const trimmed = rest.trim();
  if (!trimmed) return false;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return false;
  const ramp = new Set(RAMP.split(''));
  let rampChars = 0;
  let total = 0;
  for (const line of lines.slice(0, 10)) {
    for (const ch of line) {
      total++;
      if (ramp.has(ch)) rampChars++;
    }
  }
  return total > 0 && rampChars / total > 0.3;
}

let textMode = null;
function detectText(text) {
  const badge = $('detectedBadge');
  const { tag } = stripTag(text);
  if (tag === 'Sealed' || tag === 'JPG' || looksLikeBase64(text)) {
    textMode = 'base64';
    badge.style.display = '';
    badge.textContent = tag === 'Sealed' ? 'Detected: Sealed Base64 Image' : 'Detected: Base64 Image';
    $('scaleField').style.display = 'none';
    $('goBtn').textContent = 'Show Image';
    $('statusC').textContent = 'Detected: ' + (tag === 'Sealed' ? 'Sealed base64' : 'Base64') + ' image — tap Show Image.';
  } else if (looksLikeAscii(text)) {
    textMode = 'ascii';
    badge.style.display = '';
    badge.textContent = 'Detected: ASCII Art';
    $('scaleField').style.display = '';
    $('goBtn').textContent = 'Render to Image';
    $('statusC').textContent = 'Detected: ASCII art — adjust scale and hit Render.';
  } else {
    textMode = 'ascii';
    badge.style.display = 'none';
    $('scaleField').style.display = 'none';
    $('goBtn').textContent = 'Render to Image';
    $('statusC').textContent = 'Paste ASCII art or a base64 string.';
  }
  $('textImgOut').classList.remove('show');
}

$('inC').addEventListener('input', () => {
  detectText(readFullInput($('inC')));
});

$('goBtn').addEventListener('click', async () => {
  const text = readFullInput($('inC'));
  if (!text.trim()) {
    toast('Paste some text first');
    return;
  }
  detectText(text);
  const btn = $('goBtn');
  btn.classList.add('busy');
  btn.textContent = 'Working…';
  $('loadBarC').hidden = false;
  const t0 = Date.now();
  try {
    if (textMode === 'base64') {
      const clean = unseal(text) ?? text;
      base64ToBytes(parseB64(clean));
      const cv = await b64ToCanvas(parseB64(clean));
      showCanvas(cv, $('outC'));
      $('statusC').textContent = 'Loaded — ' + cv.width + ' × ' + cv.height + ' px base64 image.';
    } else {
      const { rest } = stripTag(text);
      const scale = parseInt($('scale').value, 10);
      const cv = asciiToCanvas(rest, scale);
      showCanvas(cv, $('outC'));
      $('statusC').textContent = 'Rendered — ' + cv.width + ' × ' + cv.height + ' px.';
    }
    $('textImgOut').classList.add('show');
  } catch {
    $('textImgOut').classList.remove('show');
    $('statusC').textContent = "That string isn't a valid image.";
    toast('Not a valid base64 image');
  } finally {
    const el = Date.now() - t0;
    if (el < 650) await new Promise((r) => setTimeout(r, 650 - el));
    $('loadBarC').hidden = true;
    btn.classList.remove('busy');
    btn.textContent = textMode === 'base64' ? 'Show Image' : 'Render to Image';
  }
});
$('saveC').addEventListener('click', () => download($('outC'), 'result.png'));

// ============ TEXT → TEXT ============
const ttEncodeType = $('ttEncodeType');
const ttDecodeType = $('ttDecodeType');

function fillSelect(select, types) {
  select.innerHTML = '';
  for (const t of types) {
    const opt = document.createElement('option');
    opt.value = t.value;
    opt.textContent = t.label;
    select.appendChild(opt);
  }
}
fillSelect(ttEncodeType, TT_TYPES);
fillSelect(ttDecodeType, [{ value: 'auto', label: 'Auto' }, { value: 'sealed', label: 'Sealed' }, ...TT_TYPES]);

// Auto = trust the tag when present, otherwise guess from the content.
function resolveDecodeType(input) {
  const { tag, rest } = stripTag(input);
  if (ttDecodeType.value !== 'auto') return { type: ttDecodeType.value, tag, rest };
  if (tag) {
    const t = typeFromTag(tag);
    if (t) return { type: t, tag, rest };
  }
  return { type: detectType(rest) ?? 'base64', tag, rest };
}

$('ttEncodeBtn').addEventListener('click', () => {
  const input = $('ttIn').value;
  if (!input.trim()) {
    toast('Enter text to encode');
    return;
  }
  const label = tagFor(ttEncodeType.value);
  let result = '[' + label + '] ' + encodeText(input, ttEncodeType.value);
  if (sealedMode !== 'off') {
    result = seal(result);
  }
  $('ttResult').value = result;
  $('ttOut').classList.add('show');
  showSealBubble(result.startsWith('[Sealed] '), 'ttSealBubble');
  $('ttSealNote').style.display = 'none';
  toast('Encoded with ' + label);
});

$('ttDecodeBtn').addEventListener('click', () => {
  const input = $('ttDecodeIn').value;
  if (!input.trim()) {
    toast('Enter text to decode');
    return;
  }
  const autoMode = ttDecodeType.value === 'auto';
  const { type, tag } = resolveDecodeType(input);
  if (autoMode) ttDecodeType.value = type;
  const result = decodeText(input, type);
  $('ttResult').value = result;
  $('ttOut').classList.add('show');
  showSealBubble(tag === 'Sealed', 'ttSealBubble');
  $('ttSealNote').style.display = type === 'sealed' && !tag ? '' : 'none';
  if (autoMode) toast((tag ? 'Tag detected: ' + tag + ' — ' : 'Auto detected: ') + type);
  else toast('Decoded with ' + tagFor(type));
});

$('ttCopy').addEventListener('click', async () => {
  const text = $('ttResult').value;
  if (!text) return;
  await copy(text);
  toast('Copied to clipboard');
});

$('ttShare').addEventListener('click', async () => {
  const text = $('ttResult').value;
  if (!text) return;
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch {}
  }
  await copy(text);
  toast('Copied to clipboard');
});