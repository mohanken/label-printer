// Quick label designer: text with an optional QR code or barcode, auto-fitted to the label.

import { whiteCanvas, rotateCanvas } from './raster.js?v=20260919140616';

const FONTS = {
  sans: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'Menlo, Consolas, "Courier New", monospace',
};

export const DEFAULT_DESIGN = {
  text: '',
  fontSize: 0, // 0 = auto-fit
  bold: true,
  align: 'center',
  font: 'sans',
  landscape: false,
  border: false,
  code: 'none', // none | qr | barcode
  codeData: '',
  showCodeText: true,
};

const fontSpec = (d, px) => `${d.bold ? '700' : '400'} ${px}px ${FONTS[d.font] || FONTS.sans}`;

function measureLines(ctx, lines) {
  return Math.max(1, ...lines.map((l) => ctx.measureText(l || ' ').width));
}

// Largest font size (px) at which `lines` fit inside w×h.
function fitFontSize(ctx, d, lines, w, h) {
  let lo = 6, hi = Math.max(8, Math.floor(h / (lines.length * 1.15)));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    ctx.font = fontSpec(d, mid);
    const fits = measureLines(ctx, lines) <= w && mid * 1.15 * lines.length <= h;
    if (fits) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function drawText(ctx, d, box) {
  const lines = d.text.replace(/\s+$/, '').split('\n');
  if (!lines.join('').trim()) return;
  const size = d.fontSize > 0 ? d.fontSize : fitFontSize(ctx, d, lines, box.w, box.h);
  ctx.font = fontSpec(d, size);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  ctx.textAlign = d.align;
  const lineH = size * 1.15;
  const total = lineH * lines.length;
  const x = d.align === 'left' ? box.x : d.align === 'right' ? box.x + box.w : box.x + box.w / 2;
  let y = box.y + (box.h - total) / 2 + lineH / 2;
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineH;
  }
}

function drawQr(ctx, data, box) {
  if (!window.qrcode) throw new Error('QR code library failed to load.');
  const qr = window.qrcode(0, 'M');
  qr.addData(data);
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.max(1, Math.floor(Math.min(box.w, box.h) / n)); // whole dots per module = crisp
  const size = cell * n;
  const ox = Math.round(box.x + (box.w - size) / 2);
  const oy = Math.round(box.y + (box.h - size) / 2);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
}

function drawBarcode(ctx, d, box) {
  if (!window.JsBarcode) throw new Error('Barcode library failed to load.');
  const tmp = document.createElement('canvas');
  const fontSize = Math.max(18, Math.round(box.h * 0.2));
  // Try the widest bars that fit; module widths are whole dots so bars stay crisp.
  for (let width = 6; width >= 1; width--) {
    window.JsBarcode(tmp, d.codeData, {
      format: 'CODE128',
      width,
      height: Math.max(20, box.h - (d.showCodeText ? fontSize * 1.4 : 0)),
      displayValue: d.showCodeText,
      fontSize,
      font: 'monospace',
      margin: 0,
      background: '#ffffff',
      lineColor: '#000000',
    });
    if (tmp.width <= box.w || width === 1) break;
  }
  const scale = Math.min(1, box.w / tmp.width);
  const w = Math.round(tmp.width * scale);
  const h = Math.round(tmp.height * scale);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, Math.round(box.x + (box.w - w) / 2), Math.round(box.y + (box.h - h) / 2), w, h);
}

// Render a design onto a labelW×labelH canvas (dots).
export function renderDesign(d, labelW, labelH) {
  // Landscape designs are laid out on a rotated canvas and turned to fit the label.
  const W = d.landscape ? labelH : labelW;
  const H = d.landscape ? labelW : labelH;
  const canvas = whiteCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const pad = Math.round(Math.min(W, H) * 0.06);
  const inner = { x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad };

  if (d.border) {
    const t = Math.max(3, Math.round(Math.min(W, H) * 0.012));
    ctx.fillStyle = '#000';
    const o = Math.round(pad / 3);
    ctx.fillRect(o, o, W - 2 * o, t);
    ctx.fillRect(o, H - o - t, W - 2 * o, t);
    ctx.fillRect(o, o, t, H - 2 * o);
    ctx.fillRect(W - o - t, o, t, H - 2 * o);
  }

  const hasText = d.text.trim().length > 0;
  const hasCode = d.code !== 'none' && d.codeData.trim().length > 0;
  const gap = Math.round(pad * 0.8);
  let textBox = inner;

  if (hasCode) {
    let codeBox;
    if (d.code === 'qr') {
      const wide = inner.w > inner.h * 1.3;
      if (!hasText) codeBox = inner;
      else if (wide) {
        const s = Math.min(inner.h, inner.w * 0.45);
        codeBox = { x: inner.x, y: inner.y, w: s, h: inner.h };
        textBox = { x: inner.x + s + gap, y: inner.y, w: inner.w - s - gap, h: inner.h };
      } else {
        const s = Math.min(inner.w, inner.h * 0.55);
        codeBox = { x: inner.x, y: inner.y + inner.h - s, w: inner.w, h: s };
        textBox = { x: inner.x, y: inner.y, w: inner.w, h: inner.h - s - gap };
      }
      drawQr(ctx, d.codeData, codeBox);
    } else {
      const bh = hasText ? Math.round(inner.h * 0.45) : inner.h;
      codeBox = { x: inner.x, y: inner.y + inner.h - bh, w: inner.w, h: bh };
      textBox = { x: inner.x, y: inner.y, w: inner.w, h: inner.h - bh - gap };
      drawBarcode(ctx, d, codeBox);
    }
  }

  if (hasText) drawText(ctx, d, textBox);
  return d.landscape ? rotateCanvas(canvas, 90) : canvas;
}

// Built-in test label. The border shows whether the print lines up with the label edges.
export function testDesign(note = '') {
  return {
    ...DEFAULT_DESIGN,
    text: `Test print ✓\n${note}`.trim(),
    border: true,
    code: 'qr',
    codeData: 'Hello from Label Printer',
    landscape: false,
  };
}
