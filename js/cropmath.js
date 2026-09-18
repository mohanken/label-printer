// Geometry for the label cropper. Rects are { x, y, w, h }.
//
// "Rotated space" is the page after turning it clockwise by `rotation` degrees (0/90/180/270),
// measured in page units (PDF points or image pixels) from its top-left corner. A crop is a rect
// in rotated space; it may extend past the page, where the label simply stays white.

const norm = (r) => (((r % 360) + 360) % 360);

export const rotatedSize = (pw, ph, r) => (norm(r) % 180 === 0 ? { w: pw, h: ph } : { w: ph, h: pw });

// Map a rect from the unrotated page into rotated space.
export function toRotated(q, pw, ph, r) {
  switch (norm(r)) {
    case 90:
      return { x: ph - q.y - q.h, y: q.x, w: q.h, h: q.w };
    case 180:
      return { x: pw - q.x - q.w, y: ph - q.y - q.h, w: q.w, h: q.h };
    case 270:
      return { x: q.y, y: pw - q.x - q.w, w: q.h, h: q.w };
    default:
      return { ...q };
  }
}

// Map a rect from rotated space back onto the unrotated page.
export function fromRotated(u, pw, ph, r) {
  switch (norm(r)) {
    case 90:
      return { x: u.y, y: ph - u.x - u.w, w: u.h, h: u.w };
    case 180:
      return { x: pw - u.x - u.w, y: ph - u.y - u.h, w: u.w, h: u.h };
    case 270:
      return { x: pw - u.y - u.h, y: u.x, w: u.h, h: u.w };
    default:
      return { ...u };
  }
}

// Turn a rect a further 90° clockwise, along with the page (pwr × phr in its current rotation).
export const turnRect = (c, pwr, phr) => ({ x: phr - c.y - c.h, y: c.x, w: c.h, h: c.w });

// Largest rect with aspect ratio `aspect` (w / h) centred inside `box`.
export function fitAspect(aspect, box) {
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

// Smallest rect with aspect ratio `aspect` that contains `c`, sharing its centre.
export function coverAspect(c, aspect) {
  let w = c.w;
  let h = w / aspect;
  if (h < c.h) {
    h = c.h;
    w = h * aspect;
  }
  return { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h };
}

// Label-shaped crop that shows `box` as large as possible on a labelW × labelH label with
// `margin` blank dots on every side.
export function labelCropAround(box, labelW, labelH, margin = 0) {
  const s = Math.min((labelW - 2 * margin) / box.w, (labelH - 2 * margin) / box.h);
  const w = labelW / s;
  const h = labelH / s;
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
}

export function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// Allowed positions along one axis: a crop smaller than the page stays on the page; a crop
// larger than the page keeps the whole page inside it.
export function axisRange(size, pageSize) {
  return { lo: Math.min(0, pageSize - size), hi: Math.max(0, pageSize - size) };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function clampCrop(c, pwr, phr) {
  const rx = axisRange(c.w, pwr);
  const ry = axisRange(c.h, phr);
  return { ...c, x: clamp(c.x, rx.lo, rx.hi), y: clamp(c.y, ry.lo, ry.hi) };
}

// Progressive resistance past a boundary (Apple's rubber-band curve).
export function rubberband(over, dim, c = 0.55) {
  return (over * dim * c) / (dim + c * Math.abs(over));
}

// Keep v within lo..hi softly: past a limit it follows the finger less and less.
export function soften(v, lo, hi, dim) {
  if (v < lo) return lo - rubberband(lo - v, dim);
  if (v > hi) return hi + rubberband(v - hi, dim);
  return v;
}

// Where a flick would come to rest, like scroll deceleration (Apple's projection).
export const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);
