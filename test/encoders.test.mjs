// Round-trip tests: encode a bitmap to printer commands, decode it back, compare.
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packRows } from '../js/raster.js';
import { tsplJob, zplJob, zplCompress, inkBands } from '../js/encoders.js';

// A label-like test image: blank margins, text-ish blocks, a barcode, full-black rows.
function sampleMono(width = 812, height = 1218) {
  const black = new Uint8Array(width * height);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      if (y > 40 && y < 200 && x > 30 && x < 600) on = rand() < 0.3 ? 1 : 0; // "text"
      if (y > 400 && y < 700 && x > 100 && x < 700) on = Math.floor(x / 3) % 3 === 0 ? 1 : 0; // barcode
      if (y >= 900 && y < 905) on = 1; // solid rule
      if (y > 1000 && y < 1100 && x > 790) on = 1; // right edge block
      black[y * width + x] = on;
    }
  }
  return { width, height, black };
}

function decodeTspl(bytes, width, height) {
  const text = (a, b) => new TextDecoder('latin1').decode(bytes.subarray(a, b));
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(bytesPerRow * height);
  const labels = [];
  const header = [];
  let pos = 0;
  while (pos < bytes.length) {
    const eol = bytes.indexOf(0x0a, pos);
    const line = text(pos, eol).replace(/\r$/, '');
    if (line.startsWith('BITMAP ')) {
      // BITMAP x,y,widthBytes,height,mode,<data>
      let commas = 0, p = pos;
      while (commas < 5) if (bytes[p++] === 0x2c) commas++;
      const [x, y, wb, h, mode] = text(pos + 7, p - 1).split(',').map(Number);
      assert.equal(mode, 0);
      assert.equal(x % 8, 0);
      for (let r = 0; r < h; r++) {
        for (let b = 0; b < wb; b++) out[(y + r) * bytesPerRow + x / 8 + b] = ~bytes[p + r * wb + b] & 0xff;
      }
      p += wb * h;
      assert.equal(text(p, p + 2), '\r\n', 'BITMAP data must be followed by CRLF');
      pos = p + 2;
      continue;
    }
    if (line === 'CLS') out.fill(0);
    else if (line.startsWith('PRINT')) labels.push({ data: out.slice(), print: line });
    else header.push(line);
    pos = eol + 1;
  }
  return { labels, header };
}

function decodeZplGraphic(s, bytesPerRow, rows) {
  const hexPerRow = bytesPerRow * 2;
  const out = [];
  let row = '';
  let prev = '';
  let count = 0;
  const flush = () => {
    out.push(row);
    prev = row;
    row = '';
  };
  for (const ch of s) {
    if (ch >= 'G' && ch <= 'Y') count += ch.charCodeAt(0) - 70;
    else if (ch >= 'g' && ch <= 'z') count += (ch.charCodeAt(0) - 102) * 20;
    else if (ch === ',') {
      row = row.padEnd(hexPerRow, '0');
      flush();
    } else if (ch === '!') {
      row = row.padEnd(hexPerRow, 'F');
      flush();
    } else if (ch === ':') {
      row = prev;
      flush();
    } else {
      row += ch.repeat(count || 1);
      count = 0;
      if (row.length === hexPerRow) flush();
    }
  }
  assert.equal(out.length, rows, 'row count');
  const bytes = new Uint8Array(bytesPerRow * rows);
  out.forEach((r, y) => {
    assert.equal(r.length, hexPerRow, `row ${y} length`);
    for (let b = 0; b < bytesPerRow; b++) bytes[y * bytesPerRow + b] = parseInt(r.slice(b * 2, b * 2 + 2), 16);
  });
  return bytes;
}

const settings = { widthMm: 101.6, heightMm: 152.4, gapMm: 3, density: 8, speed: 4, flip: false };

test('TSPL job round-trips the bitmap exactly', () => {
  const bmp = packRows(sampleMono());
  const bytes = tsplJob([bmp, bmp], settings, 2);
  const { labels, header } = decodeTspl(bytes, bmp.width, bmp.height);
  assert.deepEqual(header, ['SIZE 101.6 mm,152.4 mm', 'GAP 3 mm,0 mm', 'DIRECTION 1,0', 'REFERENCE 0,0', 'DENSITY 8', 'SPEED 4']);
  assert.equal(labels.length, 2);
  for (const l of labels) {
    assert.equal(l.print, 'PRINT 1,2');
    assert.deepEqual(l.data, bmp.data);
  }
});

test('TSPL skips blank areas', () => {
  const bmp = packRows(sampleMono());
  const bands = inkBands(bmp);
  const sent = bands.reduce((n, b) => n + b.bytes * b.rows, 0);
  assert.ok(sent < bmp.data.length * 0.6, `sent ${sent} of ${bmp.data.length} bytes`);
  assert.ok(bands.every((b) => b.byteX >= 0 && b.byteX + b.bytes <= bmp.bytesPerRow));
});

test('TSPL blank label has no BITMAP commands', () => {
  const bmp = packRows({ width: 812, height: 1218, black: new Uint8Array(812 * 1218) });
  const s = new TextDecoder().decode(tsplJob([bmp], settings, 1));
  assert.ok(!s.includes('BITMAP'));
  assert.ok(s.endsWith('CLS\r\nPRINT 1,1\r\n'));
});

test('ZPL compression round-trips the bitmap exactly', () => {
  const bmp = packRows(sampleMono());
  const compressed = zplCompress(bmp);
  assert.deepEqual(decodeZplGraphic(compressed, bmp.bytesPerRow, bmp.height), bmp.data);
  assert.ok(compressed.length < bmp.data.length, `compressed to ${compressed.length} chars`);
});

test('ZPL handles all-black rows and long runs', () => {
  const w = 3400; // wider than 419 hex chars per run
  const black = new Uint8Array(w * 4);
  black.fill(1, 0, w); // row 0 all black
  black.fill(1, w * 2, w * 2 + 3000); // row 2 long run then white
  const bmp = packRows({ width: w, height: 4, black });
  assert.deepEqual(decodeZplGraphic(zplCompress(bmp), bmp.bytesPerRow, 4), bmp.data);
});

test('ZPL job wraps the graphic in a label', () => {
  const bmp = packRows(sampleMono(16, 4));
  const s = new TextDecoder().decode(zplJob([bmp], settings, 3));
  assert.match(s, /^\^XA\r\n\^PW16\r\n\^LL4\r\n/);
  assert.match(s, /\^GFA,8,8,2,/);
  assert.match(s, /\^PQ3\r\n\^XZ/);
});
