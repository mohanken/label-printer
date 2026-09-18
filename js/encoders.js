// Printer command encoders. Each takes packed bitmaps ({ width, height, bytesPerRow, data },
// 1 = black) and returns the bytes to send to the printer.

const ascii = (s) => new TextEncoder().encode(s);

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const num = (v) => String(Math.round(v * 10) / 10);

// ---------------------------------------------------------------------------------------------
// TSPL (Rongta / TSC style label language)
// ---------------------------------------------------------------------------------------------

// Split a bitmap into horizontal bands that contain ink, trimmed left and right, so blank areas
// of the label are never sent over Bluetooth. Bands closer than `mergeGap` rows are merged.
export function inkBands(bitmap, mergeGap = 24) {
  const { height, bytesPerRow, data } = bitmap;
  const rowSpan = (y) => {
    let first = -1, last = -1;
    const base = y * bytesPerRow;
    for (let b = 0; b < bytesPerRow; b++) {
      if (data[base + b]) {
        if (first < 0) first = b;
        last = b;
      }
    }
    return first < 0 ? null : [first, last];
  };

  const bands = [];
  let cur = null;
  for (let y = 0; y < height; y++) {
    const span = rowSpan(y);
    if (!span) continue;
    if (cur && y - cur.y1 <= mergeGap) {
      cur.y1 = y;
      cur.b0 = Math.min(cur.b0, span[0]);
      cur.b1 = Math.max(cur.b1, span[1]);
    } else {
      if (cur) bands.push(cur);
      cur = { y0: y, y1: y, b0: span[0], b1: span[1] };
    }
  }
  if (cur) bands.push(cur);
  return bands.map(({ y0, y1, b0, b1 }) => ({ y: y0, rows: y1 - y0 + 1, byteX: b0, bytes: b1 - b0 + 1 }));
}

export function tsplSetup({ widthMm, heightMm, gapMm = 3, density = 8, speed = 4, flip = false }) {
  return ascii(
    [
      `SIZE ${num(widthMm)} mm,${num(heightMm)} mm`,
      `GAP ${num(gapMm)} mm,0 mm`,
      `DIRECTION ${flip ? 0 : 1},0`,
      'REFERENCE 0,0',
      `DENSITY ${Math.round(density)}`,
      `SPEED ${Math.round(speed)}`,
      '',
    ].join('\r\n'),
  );
}

// One label image → CLS, BITMAP (one per ink band), PRINT.
// TSPL bitmaps use 0 for a printed dot, so bits are inverted unless `invert` is false.
export function tsplLabel(bitmap, { copies = 1, invert = true } = {}) {
  const parts = [ascii('CLS\r\n')];
  for (const band of inkBands(bitmap)) {
    const chunk = new Uint8Array(band.bytes * band.rows);
    for (let r = 0; r < band.rows; r++) {
      const src = (band.y + r) * bitmap.bytesPerRow + band.byteX;
      for (let b = 0; b < band.bytes; b++) {
        const v = bitmap.data[src + b];
        chunk[r * band.bytes + b] = invert ? ~v & 0xff : v;
      }
    }
    parts.push(ascii(`BITMAP ${band.byteX * 8},${band.y},${band.bytes},${band.rows},0,`), chunk, ascii('\r\n'));
  }
  parts.push(ascii(`PRINT 1,${Math.max(1, Math.round(copies))}\r\n`));
  return concatBytes(parts);
}

export function tsplJob(bitmaps, settings, copies = 1) {
  return concatBytes([tsplSetup(settings), ...bitmaps.map((b) => tsplLabel(b, { copies, invert: settings.invert !== false }))]);
}

// ---------------------------------------------------------------------------------------------
// ZPL (Zebra-compatible), using Zebra's ASCII compression for ^GFA graphics
// ---------------------------------------------------------------------------------------------

const HEX = '0123456789ABCDEF';

function repeatCode(count) {
  // G..Y = 1..19, g..z = 20..400 (steps of 20). Counts above 419 are split by the caller.
  let s = '';
  if (count >= 20) {
    s += String.fromCharCode('f'.charCodeAt(0) + Math.floor(count / 20));
    count %= 20;
  }
  if (count > 0) s += String.fromCharCode('F'.charCodeAt(0) + count);
  return s;
}

function compressHexRun(ch, count) {
  let out = '';
  while (count > 0) {
    const n = Math.min(count, 419);
    out += n === 1 ? ch : repeatCode(n) + ch;
    count -= n;
  }
  return out;
}

export function zplCompress(bitmap) {
  const { height, bytesPerRow, data } = bitmap;
  let out = '';
  let prev = null;
  for (let y = 0; y < height; y++) {
    let hex = '';
    for (let b = 0; b < bytesPerRow; b++) {
      const v = data[y * bytesPerRow + b];
      hex += HEX[v >> 4] + HEX[v & 15];
    }
    if (hex === prev) {
      out += ':';
      continue;
    }
    prev = hex;
    let body = hex;
    let tail = '';
    const zeros = body.match(/0+$/);
    if (zeros) {
      body = body.slice(0, -zeros[0].length);
      tail = ',';
    } else {
      const ones = body.match(/F+$/);
      if (ones && ones[0].length > 1) {
        body = body.slice(0, -ones[0].length);
        tail = '!';
      }
    }
    for (let i = 0; i < body.length; ) {
      let j = i;
      while (j < body.length && body[j] === body[i]) j++;
      out += compressHexRun(body[i], j - i);
      i = j;
    }
    out += tail;
  }
  return out;
}

function zplHex(bitmap) {
  let out = '';
  for (const v of bitmap.data) out += HEX[v >> 4] + HEX[v & 15];
  return out;
}

// ^GFA graphic field placed at x,y. `compress` uses Zebra's ASCII compression (much smaller);
// without it the data is plain hex, which every ZPL printer understands.
export function zplGraphic(bitmap, x = 0, y = 0, compress = true) {
  const total = bitmap.bytesPerRow * bitmap.height;
  const data = compress ? zplCompress(bitmap) : zplHex(bitmap);
  return `^FO${x},${y}^GFA,${total},${total},${bitmap.bytesPerRow},${data}^FS`;
}

function zplFormat(width, height, fields, { density = 8, speed = 4, flip = false, copies = 1 } = {}) {
  return ascii(
    [
      '^XA',
      `^PW${width}`,
      `^LL${height}`,
      '^LH0,0',
      `~SD${String(Math.min(30, Math.round(density * 2))).padStart(2, '0')}`,
      `^PR${Math.round(speed)}`,
      `^PO${flip ? 'I' : 'N'}`,
      ...fields,
      `^PQ${Math.max(1, Math.round(copies))}`,
      '^XZ',
      '',
    ].join('\r\n'),
  );
}

export function zplLabel(bitmap, settings = {}) {
  return zplFormat(bitmap.width, bitmap.height, [zplGraphic(bitmap, 0, 0, settings.compress !== false)], settings);
}

export function zplJob(bitmaps, settings, copies = 1) {
  return concatBytes(bitmaps.map((b) => zplLabel(b, { ...settings, copies })));
}

// Diagnostic label: a border and text drawn with the printer's own font (proves the printer
// understands us), plus a small image (proves pictures print). `qr` is a packed bitmap.
export function zplTestLabel({ width, height, lines, qr, ...settings }) {
  const m = Math.round(Math.min(width, height) * 0.04);
  const big = Math.max(22, Math.min(56, Math.round(Math.min(width, height) * 0.08)));
  const small = Math.max(18, Math.round(big * 0.55));
  // The printer's built-in font is plain ASCII; ^ and ~ would be read as commands.
  const safe = (s) => s.replace(/×/g, 'x').replace(/[\^~]/g, ' ').replace(/[^\x20-\x7e]/g, '');
  const fields = [`^FO${m},${m}^GB${width - 2 * m},${height - 2 * m},4^FS`];
  let y = m * 2 + 4;
  fields.push(`^FO${m * 2},${y}^A0N,${big},${big}^FD${safe(lines[0])}^FS`);
  y += Math.round(big * 1.3);
  for (const line of lines.slice(1)) {
    fields.push(`^FO${m * 2},${y}^A0N,${small},${small}^FD${safe(line)}^FS`);
    y += Math.round(small * 1.4);
  }
  if (qr && y + qr.height < height - m * 2) {
    fields.push(zplGraphic(qr, Math.round((width - qr.width) / 2 / 8) * 8, y + m, settings.compress !== false));
  }
  return zplFormat(width, height, fields, settings);
}

// ---------------------------------------------------------------------------------------------
// Utility commands per language
// ---------------------------------------------------------------------------------------------

export const COMMANDS = {
  tspl: {
    feed: () => ascii('FORMFEED\r\n'),
    calibrate: (s) => concatBytes([tsplSetup(s), ascii('AUTODETECT\r\n')]),
    selfTest: () => ascii('SELFTEST\r\n'),
    identify: () => ascii('~!T\r\n'),
    status: () => new Uint8Array([0x1b, 0x21, 0x3f]), // <ESC>!?
  },
  zpl: {
    feed: () => ascii('~PH\r\n'),
    calibrate: () => ascii('~JC\r\n'),
    selfTest: () => ascii('~WC\r\n'),
    identify: () => ascii('~HI\r\n'),
    status: () => ascii('~HS\r\n'),
  },
};

export function buildJob(language, bitmaps, settings, copies) {
  return language === 'zpl' ? zplJob(bitmaps, settings, copies) : tsplJob(bitmaps, settings, copies);
}
