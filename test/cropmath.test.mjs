import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rotatedSize, toRotated, fromRotated, turnRect, fitAspect, coverAspect, labelCropAround,
  intersect, clampCrop, soften, project,
} from '../js/cropmath.js';

const near = (a, b, msg) => {
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${msg}: ${k} ${a[k]} vs ${b[k]}`);
};

const PW = 612, PH = 792; // US Letter in points
const R = { x: 50, y: 80, w: 200, h: 300 };

test('fromRotated undoes toRotated for every rotation', () => {
  for (const r of [0, 90, 180, 270]) near(fromRotated(toRotated(R, PW, PH, r), PW, PH, r), R, `r=${r}`);
});

test('turning 90° clockwise moves the top-left corner to the top-right', () => {
  const corner = { x: 0, y: 0, w: 10, h: 10 };
  near(toRotated(corner, PW, PH, 90), { x: PH - 10, y: 0, w: 10, h: 10 }, 'corner');
  assert.deepEqual(rotatedSize(PW, PH, 90), { w: PH, h: PW });
});

test('turnRect matches rotating the page a further 90°', () => {
  for (const r of [0, 90, 180, 270]) {
    const pr = rotatedSize(PW, PH, r);
    near(turnRect(toRotated(R, PW, PH, r), pr.w, pr.h), toRotated(R, PW, PH, r + 90), `r=${r}`);
  }
});

test('fitAspect and coverAspect keep the aspect ratio and the centre', () => {
  const box = { x: 10, y: 20, w: 300, h: 300 };
  const fit = fitAspect(2 / 3, box);
  near(fit, { x: 60, y: 20, w: 200, h: 300 }, 'fit');
  const cover = coverAspect({ x: 0, y: 0, w: 100, h: 100 }, 2 / 3);
  near(cover, { x: 0, y: -25, w: 100, h: 150 }, 'cover');
});

test('labelCropAround is label-shaped, contains the box, and leaves the margin', () => {
  const W = 812, H = 1218, m = 16;
  const box = { x: 100, y: 100, w: 300, h: 400 };
  const c = labelCropAround(box, W, H, m);
  assert.ok(Math.abs(c.w / c.h - W / H) < 1e-9);
  const s = W / c.w; // dots per page unit
  assert.ok((box.x - c.x) * s >= m - 1e-9 && (c.x + c.w - box.x - box.w) * s >= m - 1e-9);
  assert.ok((box.y - c.y) * s >= m - 1e-9 && (c.y + c.h - box.y - box.h) * s >= m - 1e-9);
});

test('clampCrop keeps small crops on the page and the page inside large crops', () => {
  near(clampCrop({ x: -50, y: 700, w: 100, h: 200 }, PW, PH), { x: 0, y: 592, w: 100, h: 200 }, 'small');
  near(clampCrop({ x: 10, y: -500, w: 800, h: 1000 }, PW, PH), { x: 0, y: -208, w: 800, h: 1000 }, 'large');
  assert.equal(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 }), null);
});

test('soften leaves values inside the range alone and resists past it', () => {
  assert.equal(soften(5, 0, 10, 100), 5);
  const past = soften(60, 0, 10, 100);
  assert.ok(past > 10 && past < 60);
  assert.ok(soften(-1000, 0, 10, 100) > -100, 'resistance grows the further you pull');
  assert.ok(Math.abs(project(1000) - 499) < 1);
});
