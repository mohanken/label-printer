// Loads shipping labels (PDF or image), finds the label on the page, and renders it to fit
// the physical label at printer resolution.

import { whiteCanvas, findLabel, rotateCanvas } from './raster.js';

// pdf.js is large, so it is only loaded the first time a PDF is opened.
let pdfjsReady = null;
function loadPdfJs() {
  pdfjsReady ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/pdf.min.js';
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    script.onerror = () => {
      pdfjsReady = null;
      reject(new Error('The PDF reader failed to load. Check your internet connection and try again.'));
    };
    document.head.append(script);
  });
  return pdfjsReady;
}

const PREVIEW_LONG_SIDE = 900; // px used for label detection and the editor's first frame
const DETAIL_LONG_SIDE = 2400; // px for zooming in the crop editor

// A source is one page of a PDF or a single image, with a common interface:
//   width/height  — natural size in "units" (PDF points or image pixels)
//   render(scale, region) → canvas of region (fractions) at `scale` canvas px per unit
class PdfPage {
  constructor(page) {
    this.page = page;
    const vp = page.getViewport({ scale: 1 });
    this.width = vp.width;
    this.height = vp.height;
  }
  async render(scale, region = { x: 0, y: 0, w: 1, h: 1 }) {
    const vp = this.page.getViewport({ scale });
    const w = Math.max(1, Math.round(region.w * vp.width));
    const h = Math.max(1, Math.round(region.h * vp.height));
    const canvas = whiteCanvas(w, h);
    const ctx = canvas.getContext('2d');
    await this.page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: [1, 0, 0, 1, -region.x * vp.width, -region.y * vp.height],
      background: 'rgba(255,255,255,1)',
      intent: 'print', // renders what a printer would; also doesn't stall when the tab is hidden
    }).promise;
    return canvas;
  }

  // Whole page, sharp enough to zoom into in the crop editor.
  detailCanvas() {
    return this.render(DETAIL_LONG_SIDE / Math.max(this.width, this.height));
  }
}

class ImagePage {
  constructor(img) {
    this.img = img;
    this.width = img.naturalWidth || img.width;
    this.height = img.naturalHeight || img.height;
  }
  async render(scale, region = { x: 0, y: 0, w: 1, h: 1 }) {
    const w = Math.max(1, Math.round(region.w * this.width * scale));
    const h = Math.max(1, Math.round(region.h * this.height * scale));
    const canvas = whiteCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, -region.x * this.width * scale, -region.y * this.height * scale, this.width * scale, this.height * scale);
    return canvas;
  }

  // Whole page, sharp enough to zoom into in the crop editor.
  detailCanvas() {
    return this.render(Math.min(1, DETAIL_LONG_SIDE / Math.max(this.width, this.height)));
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image couldn't be opened."));
    };
    img.src = url;
  });
}

// Open a file and return its pages.
export async function openFile(file) {
  // Pasted files can arrive without a useful name or type, so also check the first bytes.
  const head = String.fromCharCode(...new Uint8Array(await file.slice(0, 5).arrayBuffer()));
  const isPdf = head === '%PDF-' || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(new PdfPage(await doc.getPage(i)));
    return pages;
  }
  try {
    return [new ImagePage(await loadImage(file))];
  } catch {
    throw new Error('Please choose a PDF or an image (PNG, JPG, screenshot).');
  }
}

// Render a small version of the page for the crop editor and for finding the label.
export async function previewPage(page) {
  const scale = PREVIEW_LONG_SIDE / Math.max(page.width, page.height);
  return page.render(scale);
}

// Find the label on a preview canvas, with a little breathing room.
export function autoCrop(previewCanvas, labelAspect) {
  const b = findLabel(previewCanvas, labelAspect);
  if (!b) return { x: 0, y: 0, w: 1, h: 1 };
  const pad = 0.006;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  return { x, y, w: Math.min(1 - x, b.w + 2 * pad), h: Math.min(1 - y, b.h + 2 * pad) };
}

// True when the page itself is already label-shaped (e.g. a 4×6 PDF), in either orientation.
export function pageMatchesLabel(page, labelW, labelH) {
  const pr = page.width / page.height;
  const lr = labelW / labelH;
  return Math.abs(pr - lr) / lr < 0.04 || Math.abs(pr - 1 / lr) / (1 / lr) < 0.04;
}

// Pick the rotation that makes the cropped area best fit the label.
export function autoRotation(page, crop, labelW, labelH) {
  const cw = crop.w * page.width;
  const ch = crop.h * page.height;
  const landscapeCrop = cw > ch * 1.02;
  const landscapeLabel = labelW > labelH * 1.02;
  if (landscapeCrop !== landscapeLabel && Math.abs(cw - ch) / Math.max(cw, ch) > 0.05) return 90;
  return 0;
}

// Render `crop` of a page, rotated, scaled to fit a labelW×labelH dot canvas with `margin` dots.
export async function renderToLabel(page, { crop, rotation = 0, labelW, labelH, margin = 0 }) {
  const swap = rotation === 90 || rotation === 270;
  const cw = crop.w * page.width;
  const ch = crop.h * page.height;
  const availW = labelW - 2 * margin;
  const availH = labelH - 2 * margin;
  const scale = Math.min(availW / (swap ? ch : cw), availH / (swap ? cw : ch));
  const region = await page.render(scale, crop);
  const rotated = rotateCanvas(region, rotation);
  const out = whiteCanvas(labelW, labelH);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(rotated, Math.round((labelW - rotated.width) / 2), Math.round((labelH - rotated.height) / 2));
  return out;
}
