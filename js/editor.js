// Full-screen crop editor, modelled on cropping in the iPhone Photos app.
//
// Label shape (default): a frame shaped like the label stays put and you move and zoom the page
// underneath it — what's inside the frame is exactly what prints.
// Freeform: drag the frame's corners or edges to crop any shape; on release the frame glides
// back to the centre and the page zooms with it. The crop is then fitted onto the label.
//
// State: C = crop rect in rotated page units, F = frame rect in stage pixels. The page is drawn
// so that C lands exactly on F.

import { Animator } from './spring.js';
import {
  rotatedSize, toRotated, turnRect, fitAspect, coverAspect, labelCropAround, intersect,
  axisRange, clamp, clampCrop, soften, project,
} from './cropmath.js';

const MOVE = { damping: 1, response: 0.4 };
const TURN = { damping: 0.8, response: 0.4 };
const OPEN = { damping: 1, response: 0.35 };
const ZOOM_RANGE = 8; // how far you can zoom in from "whole page"
const MIN_FRAME = 56; // px, smallest freeform frame
const HIT_CORNER = 30;
const HIT_EDGE = 22;
const C_KEYS = ['cx', 'cy', 'cw', 'ch'];
const F_KEYS = ['fx', 'fy', 'fw', 'fh'];
const W_KEYS = ['wx', 'wy', 'wa', 'ws'];

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = matchMedia('(pointer: coarse)');

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;

export class CropEditor {
  constructor(root) {
    this.root = root;
    this.stage = root.querySelector('.ed-stage');
    this.world = root.querySelector('.ed-world');
    this.paper = root.querySelector('.ed-paper');
    this.frame = root.querySelector('.ed-frame');
    this.hint = root.querySelector('.ed-hint');
    this.note = root.querySelector('.ed-note');
    this.pageEl = null;
    this.pointers = new Map();
    this.gesture = null;
    this.anim = new Animator(() => this.draw());
    this.anim.set('ws', 1);

    this.stage.addEventListener('pointerdown', (e) => this.onDown(e));
    this.stage.addEventListener('pointermove', (e) => this.onMove(e));
    this.stage.addEventListener('pointerup', (e) => this.onUp(e));
    this.stage.addEventListener('pointercancel', (e) => this.onUp(e));
    this.stage.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener('keydown', (e) => this.onStageKey(e));
    root.addEventListener('keydown', (e) => this.onKey(e));
    root.addEventListener('gesturestart', (e) => e.preventDefault()); // no Safari page zoom
    root.querySelector('.ed-cancel').addEventListener('click', () => this.close(null));
    root.querySelector('.ed-done').addEventListener('click', () => this.done());
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.action(b.dataset.act)));
    root.querySelector('.ed-shape').addEventListener('click', (e) => {
      const b = e.target.closest('[data-value]');
      if (b) this.setShape(b.dataset.value === 'free');
    });
    addEventListener('resize', () => this.isOpen && this.relayout());
  }

  // ------------------------------------------------------------------------------ state access

  get C() {
    const a = this.anim;
    return { x: a.value('cx'), y: a.value('cy'), w: a.value('cw'), h: a.value('ch') };
  }

  get F() {
    const a = this.anim;
    return { x: a.value('fx'), y: a.value('fy'), w: a.value('fw'), h: a.value('fh') };
  }

  setRect(keys, r) {
    [r.x, r.y, r.w, r.h].forEach((v, i) => this.anim.set(keys[i], v));
  }

  animRect(keys, r, opts, velocity = {}) {
    const eps = keys === F_KEYS ? 0.05 : 0.01;
    this.anim.to(keys[0], r.x, { ...opts, eps, velocity: velocity.x });
    this.anim.to(keys[1], r.y, { ...opts, eps, velocity: velocity.y });
    this.anim.to(keys[2], r.w, { ...opts, eps });
    this.anim.to(keys[3], r.h, { ...opts, eps });
  }

  targetRect(keys) {
    const a = this.anim;
    return { x: a.target(keys[0]), y: a.target(keys[1]), w: a.target(keys[2]), h: a.target(keys[3]) };
  }

  get pr() {
    return rotatedSize(this.pw, this.ph, this.r);
  }

  get pageRect() {
    return { x: 0, y: 0, ...this.pr };
  }

  // How big the crop may get (zoomed out) and how small (zoomed in), for a crop of this shape.
  sizeLimits(aspect) {
    const { w: pwr, h: phr } = this.pr;
    const maxW = this.free ? Math.min(pwr, phr * aspect) : coverAspect(this.pageRect, aspect).w * 1.1;
    return { minW: maxW / ZOOM_RANGE, maxW };
  }

  withinLimits(c) {
    const aspect = c.w / c.h;
    const { minW, maxW } = this.sizeLimits(aspect);
    const w = clamp(c.w, minW, maxW);
    const h = w / aspect;
    const sized = { x: c.x + (c.w - w) / 2, y: c.y + (c.h - h) / 2, w, h };
    return clampCrop(sized, this.pr.w, this.pr.h);
  }

  // ------------------------------------------------------------------------------ open / close

  open(opts) {
    Object.assign(this, {
      pw: opts.page.width,
      ph: opts.page.height,
      r: opts.view.rotation,
      free: !!opts.view.freeform,
      source: opts.source,
      autoBox: opts.autoBox,
      autoRotation: opts.autoRotation,
      labelW: opts.labelW,
      labelH: opts.labelH,
      margin: opts.margin,
      fromRect: opts.from,
      isOpen: true,
      touched: false,
    });
    this.labelAspect = this.labelW / this.labelH;
    this.anim.instant = reducedMotion.matches;
    this.setPageCanvas(opts.canvas);
    opts.hiRes?.then((canvas) => this.isOpen && this.setPageCanvas(canvas)).catch(() => {});

    this.root.querySelector('.ed-shape [data-value="label"]').textContent = opts.labelName || 'Label shape';
    this.note.hidden = !(opts.pageCount > 1);
    this.note.textContent = `Applies to all ${opts.pageCount} pages`;
    this.syncControls();
    this.hint.classList.remove('gone');

    this.lastFocus = document.activeElement;
    this.root.hidden = false;
    document.documentElement.classList.add('editor-open');
    this.measure();
    const C = opts.view.crop;
    this.setRect(C_KEYS, C);
    this.setRect(F_KEYS, fitAspect(C.w / C.h, this.inner));

    // Grow out of the label preview on the main screen.
    this.setWorld(this.worldFromRect(this.fromRect));
    requestAnimationFrame(() => this.root.classList.add('is-open'));
    this.animWorld({ wx: 0, wy: 0, wa: 0, ws: 1 }, OPEN);
    this.root.querySelector('.ed-done').focus({ preventScroll: true });
    return new Promise((resolve) => (this.resolve = resolve));
  }

  async close(result) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.pointers.clear();
    this.gesture = null;
    this.anim.stop([...C_KEYS, ...F_KEYS]);
    this.root.classList.remove('is-open');
    // Shrink back into the preview, along the same path it came out.
    this.animWorld(this.worldFromRect(this.fromRect), OPEN);
    await Promise.race([this.anim.idle(), new Promise((r) => setTimeout(r, 450))]);
    this.root.hidden = true;
    document.documentElement.classList.remove('editor-open');
    this.lastFocus?.focus?.({ preventScroll: true });
    this.resolve?.(result);
  }

  done() {
    const C = this.targetRect(C_KEYS);
    const { w: pwr, h: phr } = this.pr;
    this.close({
      rotation: this.r,
      crop: { x: C.x / pwr, y: C.y / phr, w: C.w / pwr, h: C.h / phr },
      freeform: this.free,
      source: this.source,
    });
  }

  setPageCanvas(canvas) {
    canvas.classList.add('ed-page');
    if (this.pageEl && this.pageEl !== canvas) this.pageEl.remove();
    this.pageEl = canvas;
    this.world.insertBefore(canvas, this.frame);
    this.draw();
  }

  measure() {
    const r = this.stage.getBoundingClientRect();
    this.stageRect = r;
    const padX = 20;
    const padTop = this.note.hidden ? 20 : 36;
    const padBottom = 52; // room for the hint
    this.inner = { x: padX, y: padTop, w: r.width - 2 * padX, h: r.height - padTop - padBottom };
    this.world.style.transformOrigin = `${this.inner.x + this.inner.w / 2}px ${this.inner.y + this.inner.h / 2}px`;
  }

  relayout() {
    this.anim.finish();
    this.measure();
    const C = this.C;
    this.setRect(F_KEYS, fitAspect(C.w / C.h, this.inner));
    this.draw();
  }

  // World transform that makes the frame sit over a screen rect (the main-screen preview).
  worldFromRect(rect) {
    if (!rect || !rect.width) return { wx: 0, wy: 0, wa: 0, ws: 1 };
    const F = this.F;
    const s = this.stageRect;
    const ox = this.inner.x + this.inner.w / 2;
    const oy = this.inner.y + this.inner.h / 2;
    const ws = Math.min(rect.width / F.w, rect.height / F.h);
    const tx = rect.left - s.left + rect.width / 2;
    const ty = rect.top - s.top + rect.height / 2;
    return { wx: tx - ox - ws * (F.x + F.w / 2 - ox), wy: ty - oy - ws * (F.y + F.h / 2 - oy), wa: 0, ws };
  }

  setWorld(w) {
    W_KEYS.forEach((k) => this.anim.set(k, w[k]));
  }

  animWorld(w, opts) {
    this.anim.to('wx', w.wx, { ...opts, eps: 0.1 });
    this.anim.to('wy', w.wy, { ...opts, eps: 0.1 });
    this.anim.to('wa', w.wa, { ...opts, eps: 0.02 });
    this.anim.to('ws', w.ws, { ...opts, eps: 0.0005 });
  }

  // ------------------------------------------------------------------------------ drawing

  draw() {
    if (!this.isOpen && this.root.hidden) return;
    const C = this.C;
    const F = this.F;
    if (!(C.w > 0 && F.w > 0)) return;
    const d = F.w / C.w; // stage px per page unit
    const p0x = F.x - d * C.x;
    const p0y = F.y - d * C.y;

    if (this.pageEl) {
      const k = this.pw / this.pageEl.width; // page units per canvas px
      const th = (this.r * Math.PI) / 180;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const { w: pwr, h: phr } = this.pr;
      const cux = this.pw / 2;
      const cuy = this.ph / 2;
      const e = p0x + d * (pwr / 2 - (cos * cux - sin * cuy));
      const f = p0y + d * (phr / 2 - (sin * cux + cos * cuy));
      const s = d * k;
      this.pageEl.style.transform = `matrix(${s * cos},${s * sin},${-s * sin},${s * cos},${e},${f})`;
    }
    for (const el of [this.frame, this.paper]) {
      el.style.transform = `translate(${F.x}px,${F.y}px)`;
      el.style.width = `${F.w}px`;
      el.style.height = `${F.h}px`;
    }
    const a = this.anim;
    this.world.style.transform = `translate(${a.value('wx')}px,${a.value('wy')}px) rotate(${a.value('wa')}deg) scale(${a.value('ws')})`;
  }

  syncControls() {
    this.root.classList.toggle('is-free', this.free);
    this.root.querySelectorAll('.ed-shape [data-value]').forEach((b) => {
      const on = (b.dataset.value === 'free') === this.free;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    this.root.querySelector('[data-act="auto"]').setAttribute('aria-pressed', String(this.source === 'auto'));
    this.root.querySelector('[data-act="page"]').setAttribute('aria-pressed', String(this.source === 'page'));
    const zoom = coarsePointer.matches ? 'pinch to zoom' : 'scroll to zoom';
    this.hint.textContent = this.free ? `Drag the corners to crop · ${zoom}` : `Drag to move · ${zoom}`;
  }

  markCustom() {
    this.touched = true;
    if (this.source !== 'custom') {
      this.source = 'custom';
      this.syncControls();
    }
  }

  // ------------------------------------------------------------------------------ gestures

  local(e) {
    return { x: e.clientX - this.stageRect.left, y: e.clientY - this.stageRect.top };
  }

  onDown(e) {
    if (!this.isOpen || e.button > 0) return;
    e.preventDefault();
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers can't be captured */
    }
    // Never make the user wait: finish any turn/open animation, freeze the crop where it is.
    this.anim.finish(W_KEYS);
    this.anim.stop([...C_KEYS, ...F_KEYS]);
    this.pointers.set(e.pointerId, this.local(e));
    this.hint.classList.add('gone');
    this.frame.classList.add('active');
    this.beginGesture();
  }

  beginGesture() {
    const pts = [...this.pointers.values()];
    const C = this.C;
    const F = this.F;
    if (pts.length >= 2) {
      const m = mid(pts[0], pts[1]);
      this.gesture = {
        type: 'pinch',
        C0: C,
        d0: dist(pts[0], pts[1]),
        anchor: { x: C.x + ((m.x - F.x) * C.w) / F.w, y: C.y + ((m.y - F.y) * C.h) / F.h },
        last: m,
      };
      return;
    }
    const p = pts[0];
    const handle = this.free ? this.hitHandle(p, F) : null;
    const d = F.w / C.w;
    if (handle) {
      this.gesture = { type: 'resize', handle, p0: p, F0: F, d, P0: { x: F.x - d * C.x, y: F.y - d * C.y } };
    } else {
      this.gesture = { type: 'pan', p0: p, C0: C, d, samples: [{ t: performance.now(), x: C.x, y: C.y }] };
    }
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, this.local(e));
    const g = this.gesture;
    if (!g) return;
    const pts = [...this.pointers.values()];
    const { w: pwr, h: phr } = this.pr;

    if (g.type === 'pan') {
      const p = pts[0];
      const rawX = g.C0.x - (p.x - g.p0.x) / g.d;
      const rawY = g.C0.y - (p.y - g.p0.y) / g.d;
      const rx = axisRange(g.C0.w, pwr);
      const ry = axisRange(g.C0.h, phr);
      this.setRect(C_KEYS, { ...g.C0, x: soften(rawX, rx.lo, rx.hi, g.C0.w), y: soften(rawY, ry.lo, ry.hi, g.C0.h) });
      const now = performance.now();
      g.samples.push({ t: now, x: rawX, y: rawY });
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
    } else if (g.type === 'pinch' && pts.length >= 2) {
      const F = this.F;
      const m = mid(pts[0], pts[1]);
      const aspect = g.C0.w / g.C0.h;
      const { minW, maxW } = this.sizeLimits(aspect);
      const w = Math.exp(soften(Math.log((g.C0.w * g.d0) / dist(pts[0], pts[1])), Math.log(minW), Math.log(maxW), 1));
      const h = w / aspect;
      const x = g.anchor.x - ((m.x - F.x) * w) / F.w;
      const y = g.anchor.y - ((m.y - F.y) * h) / F.h;
      const rx = axisRange(w, pwr);
      const ry = axisRange(h, phr);
      this.setRect(C_KEYS, { x: soften(x, rx.lo, rx.hi, w), y: soften(y, ry.lo, ry.hi, h), w, h });
      g.last = m;
    } else if (g.type === 'resize') {
      const p = pts[0];
      const { F0, P0, d, handle } = g;
      const sw = this.stageRect.width;
      const sh = this.stageRect.height;
      const bound = {
        l: Math.max(P0.x, 0),
        t: Math.max(P0.y, 0),
        r: Math.min(P0.x + d * pwr, sw),
        b: Math.min(P0.y + d * phr, sh),
      };
      let l = F0.x, t = F0.y, r = F0.x + F0.w, b = F0.y + F0.h;
      const dx = p.x - g.p0.x;
      const dy = p.y - g.p0.y;
      if (handle.includes('w')) l = clamp(F0.x + dx, bound.l, r - MIN_FRAME);
      if (handle.includes('e')) r = clamp(r + dx, l + MIN_FRAME, bound.r);
      if (handle.includes('n')) t = clamp(F0.y + dy, bound.t, b - MIN_FRAME);
      if (handle.includes('s')) b = clamp(b + dy, t + MIN_FRAME, bound.b);
      this.setRect(F_KEYS, { x: l, y: t, w: r - l, h: b - t });
      this.setRect(C_KEYS, { x: (l - P0.x) / d, y: (t - P0.y) / d, w: (r - l) / d, h: (b - t) / d });
    }
    // A tap with a tiny wobble shouldn't count as adjusting the crop.
    if (g.type === 'pinch' || Math.hypot(pts[0].x - g.p0.x, pts[0].y - g.p0.y) > 4) this.markCustom();
    this.draw();
  }

  onUp(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size > 0) {
      this.beginGesture(); // pinch → pan with the remaining finger
      return;
    }
    const g = this.gesture;
    this.gesture = null;
    this.frame.classList.remove('active');
    if (!g || !this.touched) return;
    const { w: pwr, h: phr } = this.pr;

    if (g.type === 'pan') {
      const a = g.samples[0];
      const b = g.samples[g.samples.length - 1];
      const dt = Math.max(0.016, (b.t - a.t) / 1000);
      const v = performance.now() - b.t > 80 ? { x: 0, y: 0 } : { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
      const C = this.C;
      const target = clampCrop({ ...C, x: C.x + project(v.x), y: C.y + project(v.y) }, pwr, phr);
      this.animRect(C_KEYS, target, MOVE, v);
    } else if (g.type === 'pinch') {
      const C = this.C;
      const F = this.F;
      const m = g.last;
      const aspect = C.w / C.h;
      const { minW, maxW } = this.sizeLimits(aspect);
      const w = clamp(C.w, minW, maxW);
      const h = w / aspect;
      const ax = C.x + ((m.x - F.x) * C.w) / F.w;
      const ay = C.y + ((m.y - F.y) * C.h) / F.h;
      const target = { x: ax - ((m.x - F.x) * w) / F.w, y: ay - ((m.y - F.y) * h) / F.h, w, h };
      this.animRect(C_KEYS, clampCrop(target, pwr, phr), MOVE);
    } else if (g.type === 'resize') {
      // Photos-style: the frame glides back to the centre and the page zooms with it.
      const F = this.F;
      this.animRect(F_KEYS, fitAspect(F.w / F.h, this.inner), MOVE);
    }
  }

  hitHandle(p, F) {
    const corners = { nw: [F.x, F.y], ne: [F.x + F.w, F.y], sw: [F.x, F.y + F.h], se: [F.x + F.w, F.y + F.h] };
    for (const [name, [x, y]] of Object.entries(corners)) {
      if (Math.abs(p.x - x) < HIT_CORNER && Math.abs(p.y - y) < HIT_CORNER) return name;
    }
    const inX = p.x > F.x && p.x < F.x + F.w;
    const inY = p.y > F.y && p.y < F.y + F.h;
    if (inX && Math.abs(p.y - F.y) < HIT_EDGE) return 'n';
    if (inX && Math.abs(p.y - (F.y + F.h)) < HIT_EDGE) return 's';
    if (inY && Math.abs(p.x - F.x) < HIT_EDGE) return 'w';
    if (inY && Math.abs(p.x - (F.x + F.w)) < HIT_EDGE) return 'e';
    return null;
  }

  // Zoom around a stage point by `factor` (>1 zooms in).
  zoomAt(p, factor) {
    this.anim.finish(W_KEYS);
    this.anim.stop([...C_KEYS, ...F_KEYS]);
    const C = this.C;
    const F = this.F;
    const aspect = C.w / C.h;
    const { minW, maxW } = this.sizeLimits(aspect);
    const w = clamp(C.w / factor, minW, maxW);
    const h = w / aspect;
    const ax = C.x + ((p.x - F.x) * C.w) / F.w;
    const ay = C.y + ((p.y - F.y) * C.h) / F.h;
    this.setRect(C_KEYS, clampCrop({ x: ax - ((p.x - F.x) * w) / F.w, y: ay - ((p.y - F.y) * h) / F.h, w, h }, this.pr.w, this.pr.h));
    this.markCustom();
    this.draw();
  }

  onWheel(e) {
    e.preventDefault();
    this.hint.classList.add('gone');
    this.zoomAt(this.local(e), Math.exp(-e.deltaY * 0.0015));
  }

  onStageKey(e) {
    const F = this.F;
    const centre = { x: F.x + F.w / 2, y: F.y + F.h / 2 };
    const step = (e.shiftKey ? 60 : 16) / (F.w / this.C.w);
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      this.anim.stop([...C_KEYS, ...F_KEYS]);
      const C = this.C;
      this.setRect(C_KEYS, clampCrop({ ...C, x: C.x + moves[e.key][0], y: C.y + moves[e.key][1] }, this.pr.w, this.pr.h));
      this.markCustom();
      this.draw();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.zoomAt(centre, 1.2);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      this.zoomAt(centre, 1 / 1.2);
    }
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close(null);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      this.done();
    } else if (e.key === 'Tab') {
      // Keep focus inside the editor.
      const items = [...this.root.querySelectorAll('button, [tabindex="0"]')].filter((el) => !el.hidden);
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
      e.preventDefault();
      items[next].focus();
    }
  }

  // ------------------------------------------------------------------------------ toolbar

  action(act) {
    if (act === 'rotate') return this.rotate();
    const { w: pwr, h: phr } = this.pr;
    let next;
    if (act === 'auto') {
      const box = toRotated(this.autoBox, this.pw, this.ph, this.r);
      next = this.free ? box : labelCropAround(box, this.labelW, this.labelH, this.margin);
      this.source = this.r === this.autoRotation ? 'auto' : 'custom';
    } else {
      next = this.free ? { x: 0, y: 0, w: pwr, h: phr } : labelCropAround(this.pageRect, this.labelW, this.labelH, 0);
      this.source = 'page';
    }
    this.touched = true;
    this.syncControls();
    this.glideTo(next);
  }

  // Animate crop and frame together to a new crop.
  glideTo(next) {
    this.anim.finish(W_KEYS);
    this.animRect(C_KEYS, next, MOVE);
    this.animRect(F_KEYS, fitAspect(next.w / next.h, this.inner), MOVE);
  }

  rotate() {
    this.anim.finish();
    const oldF = this.F;
    const { w: pwr, h: phr } = this.pr;
    let next = turnRect(this.C, pwr, phr);
    this.r = (this.r + 90) % 360;
    next = this.free ? intersect(next, this.pageRect) || this.pageRect : this.withinLimits(coverAspect(next, this.labelAspect));
    const nextF = fitAspect(next.w / next.h, this.inner);
    this.setRect(C_KEYS, next);
    this.setRect(F_KEYS, nextF);
    // Start from the old orientation and size, then turn clockwise into place.
    this.anim.set('wa', -90);
    this.anim.set('ws', Math.min(oldF.w / nextF.h, oldF.h / nextF.w));
    this.anim.to('wa', 0, { ...TURN, eps: 0.02 });
    this.anim.to('ws', 1, { ...MOVE, eps: 0.0005 });
    this.markCustom();
    this.draw();
  }

  setShape(free) {
    if (free === this.free) return;
    this.free = free;
    const C = this.anim.running ? this.targetRect(C_KEYS) : this.C;
    const next = free ? intersect(C, this.pageRect) || this.pageRect : this.withinLimits(coverAspect(C, this.labelAspect));
    this.markCustom();
    this.syncControls();
    this.glideTo(next);
  }
}
