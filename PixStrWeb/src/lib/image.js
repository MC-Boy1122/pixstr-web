// Image processing: ASCII conversion, JPEG encoding, downscaling, canvas tools.

export const RAMP = "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ";

export function loadImageFile(file, maxDim, cb, onError) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const scale = maxDim ? Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * scale));
    cv.height = Math.max(1, Math.round(img.naturalHeight * scale));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    cb(cv);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (onError) onError();
  };
  img.src = url;
}

export function drawImageToCanvas(img) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.getContext('2d').drawImage(img, 0, 0);
  return cv;
}

export function b64ToCanvas(b64) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(drawImageToCanvas(img));
    img.onerror = () => rej(new Error('bad image'));
    img.src = 'data:image/png;base64,' + b64;
  });
}

export function showCanvas(cv, el) {
  el.hidden = false;
  el.width = cv.width;
  el.height = cv.height;
  el.getContext('2d').drawImage(cv, 0, 0);
}

// Monospace cells are ~2x taller than wide; divide by 1.7 (not 2) so the
// rendered art looks a bit taller / less squashed.
export function asciiFromCanvas(cv, cols) {
  const rows = Math.max(1, Math.round((cols * cv.height) / cv.width / 1.7));
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let s = '';
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * cv.height) / rows);
    const y1 = Math.floor(((r + 1) * cv.height) / rows);
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * cv.width) / cols);
      const x1 = Math.floor(((c + 1) * cv.width) / cols);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * cv.width + x) * 4;
          sum += (d[o] * 299 + d[o + 1] * 587 + d[o + 2] * 114) / 1000;
          n++;
        }
      }
      const l = n ? Math.round(sum / n) : 0;
      s += RAMP[Math.round((l * (RAMP.length - 1)) / 255)];
    }
    s += '\n';
  }
  return s;
}

export function asciiToCanvas(text, scale) {
  let lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  if (!lines.length) lines = [' '];
  const cols = Math.max(...lines.map((l) => l.length));
  const rows = lines.length;
  const cellH = Math.max(1, Math.round(scale * 2));
  const cv = document.createElement('canvas');
  cv.width = cols * scale;
  cv.height = rows * cellH;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cv.width, cv.height);
  for (let r = 0; r < rows; r++) {
    const line = lines[r];
    for (let c = 0; c < cols; c++) {
      const ch = c < line.length ? line[c] : ' ';
      let idx = RAMP.indexOf(ch);
      if (idx < 0) idx = ch.codePointAt(0) % RAMP.length;
      const g = Math.round((idx * 255) / (RAMP.length - 1));
      for (let dy = 0; dy < cellH; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((r * cellH + dy) * cv.width + c * scale + dx) * 4;
          img.data[o] = g;
          img.data[o + 1] = g;
          img.data[o + 2] = g;
          img.data[o + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export function encodeJpegCanvas(cv, quality) {
  const j = document.createElement('canvas');
  j.width = cv.width;
  j.height = cv.height;
  const ctx = j.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, j.width, j.height);
  ctx.drawImage(cv, 0, 0);
  return j.toDataURL('image/jpeg', quality).split(',')[1];
}

export function encodeJpegB64(cv, quality) {
  return encodeJpegCanvas(cv, quality / 100);
}

// Aggressive downscale: divides each side by 1.5 above 700px, by 2.5 above
// 1500px, so big images get much smaller before encoding.
export function aggressiveDownscale(cv) {
  const m = Math.max(cv.width, cv.height);
  let div = 1;
  if (m > 1500) div = 2.5;
  else if (m > 700) div = 1.5;
  if (div === 1) return cv;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cv.width / div));
  out.height = Math.max(1, Math.round(cv.height / div));
  out.getContext('2d').drawImage(cv, 0, 0, out.width, out.height);
  return out;
}

// Sweet-spot quality: the step right before the biggest size jump on the
// quality-vs-size curve.
export function autoJpegQuality(cv) {
  const ladder = [45, 60, 72, 82, 90];
  const sizes = ladder.map((q) => encodeJpegCanvas(cv, q / 100).length);
  let maxRatio = 1;
  let knee = ladder.length - 1;
  for (let i = 1; i < sizes.length; i++) {
    const ratio = sizes[i] / sizes[i - 1];
    if (ratio > maxRatio) {
      maxRatio = ratio;
      knee = i;
    }
  }
  if (maxRatio < 1.15) return 90;
  return ladder[Math.max(0, knee - 1)];
}

// Downsample to 256px so counting unique colors is fast, then treat
// high-color-ratio images (photos, gradients) as image, flat ones as ASCII.
export function recommendMode(cv) {
  const scale = Math.min(1, 256 / Math.max(cv.width, cv.height));
  const w = Math.max(1, Math.round(cv.width * scale));
  const h = Math.max(1, Math.round(cv.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(cv, 0, 0, w, h);
  const d = tctx.getImageData(0, 0, w, h).data;
  const seen = new Set();
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    seen.add((d[o] << 16) | (d[o + 1] << 8) | d[o + 2]);
    if (seen.size > 65536) break;
  }
  const ratio = seen.size / n;
  return ratio > 0.04 ? 'image' : 'ascii';
}