// Turns a canvas into the 1-bit image a thermal printer can print.

export const DPI = 203;

export const mmToDots = (mm) => Math.round((mm / 25.4) * DPI);

// Create a white canvas of the given size.
export function whiteCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

// Convert a canvas to a mono image. mode 'sharp' uses a hard threshold (best for text and
// barcodes); 'photo' uses Floyd–Steinberg dithering (best for pictures).
// Returns { width, height, black } where black[i] === 1 means a printed dot.
export function toMono(canvas, { mode = 'sharp', threshold = 150 } = {}) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const alpha = data[p + 3] / 255;
    const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    gray[i] = 255 - alpha * (255 - lum); // composite over white paper
  }

  const black = new Uint8Array(width * height);
  if (mode === 'photo') {
    const bias = 128 - threshold; // slider still works as lighter/darker
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const old = gray[i] + bias;
        const isBlack = old < 128;
        black[i] = isBlack ? 1 : 0;
        const err = old - (isBlack ? 0 : 255);
        if (x + 1 < width) gray[i + 1] += (err * 7) / 16;
        if (y + 1 < height) {
          if (x > 0) gray[i + width - 1] += (err * 3) / 16;
          gray[i + width] += (err * 5) / 16;
          if (x + 1 < width) gray[i + width + 1] += err / 16;
        }
      }
    }
  } else {
    for (let i = 0; i < gray.length; i++) black[i] = gray[i] < threshold ? 1 : 0;
  }
  return { width, height, black };
}

// Pack a mono image into rows of bytes, most significant bit first, 1 = black.
export function packRows(mono) {
  const { width, height, black } = mono;
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const rowIn = y * width;
    const rowOut = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      if (black[rowIn + x]) data[rowOut + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, bytesPerRow, data };
}

// Draw a mono image onto a canvas so the preview shows exactly what will print.
export function drawMono(mono, canvas) {
  canvas.width = mono.width;
  canvas.height = mono.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(mono.width, mono.height);
  const px = new Uint32Array(img.data.buffer);
  const INK = 0xff1a1a1a; // ABGR: near-black
  const PAPER = 0xffffffff;
  for (let i = 0; i < mono.black.length; i++) px[i] = mono.black[i] ? INK : PAPER;
  ctx.putImageData(img, 0, 0);
}

// Summed-area table of "ink" pixels, so the ink inside any rectangle can be counted instantly.
function inkTable(canvas, level) {
  const { width: W, height: H } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  const S = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      if (data[p + 3] >= 64 && lum < level) row++;
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  // count of ink in the inclusive rectangle x0..x1, y0..y1
  const count = (x0, y0, x1, y1) => S[(y1 + 1) * (W + 1) + x1 + 1] - S[y0 * (W + 1) + x1 + 1] - S[(y1 + 1) * (W + 1) + x0] + S[y0 * (W + 1) + x0];
  return { W, H, count };
}

// Runs of indices lo..hi where has(i) is true, joining runs separated by fewer than `gap` blanks.
function inkRuns(lo, hi, has, gap) {
  const runs = [];
  for (let i = lo; i <= hi; i++) {
    if (!has(i)) continue;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= gap) last[1] = i;
    else runs.push([i, i]);
  }
  // Keep the search small: merge across the narrowest gaps until there are at most 10 runs.
  while (runs.length > 10) {
    let best = 1;
    for (let k = 2; k < runs.length; k++) if (runs[k][0] - runs[k - 1][1] < runs[best][0] - runs[best - 1][1]) best = k;
    runs[best - 1][1] = runs[best][1];
    runs.splice(best, 1);
  }
  return runs;
}

// Find the label on a page: the largest block of ink (bounded by blank space) whose shape matches
// the label's aspect ratio in either orientation. Falls back to all ink. Fractions of the canvas;
// null if the page is blank.
export function findLabel(canvas, labelAspect, { level = 200, tolerance = 0.15 } = {}) {
  const { W, H, count } = inkTable(canvas, level);
  const gap = Math.max(4, Math.round(Math.max(W, H) * 0.012));
  const rows = inkRuns(0, H - 1, (y) => count(0, y, W - 1, y) > 0, gap);
  if (!rows.length) return null;

  const deviation = (w, h) => {
    const r = w / h;
    return Math.min(Math.abs(r - labelAspect) / labelAspect, Math.abs(r - 1 / labelAspect) * labelAspect);
  };

  let all = null;
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i; j < rows.length; j++) {
      const y0 = rows[i][0], y1 = rows[j][1];
      const cols = inkRuns(0, W - 1, (x) => count(x, y0, x, y1) > 0, gap);
      for (let a = 0; a < cols.length; a++) {
        for (let b = a; b < cols.length; b++) {
          const x0 = cols[a][0], x1 = cols[b][1];
          // Tighten top and bottom to the ink inside this column range.
          let top = y0, bottom = y1;
          while (top < bottom && count(x0, top, x1, top) === 0) top++;
          while (bottom > top && count(x0, bottom, x1, bottom) === 0) bottom--;
          const box = { x0, y0: top, x1, y1: bottom, area: (x1 - x0 + 1) * (bottom - top + 1) };
          if (i === 0 && j === rows.length - 1 && a === 0 && b === cols.length - 1) all = box;
          if (deviation(x1 - x0 + 1, bottom - top + 1) <= tolerance && (!best || box.area > best.area)) best = box;
        }
      }
    }
  }
  const pick = best || all;
  return { x: pick.x0 / W, y: pick.y0 / H, w: (pick.x1 - pick.x0 + 1) / W, h: (pick.y1 - pick.y0 + 1) / H };
}

// Rotate a canvas by 0/90/180/270 degrees clockwise. Pixel-exact (no resampling).
export function rotateCanvas(src, degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return src;
  const swap = d === 90 || d === 270;
  const out = document.createElement('canvas');
  out.width = swap ? src.height : src.width;
  out.height = swap ? src.width : src.height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}
