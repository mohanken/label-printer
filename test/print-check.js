// End-to-end print check, run in the browser against the mock printer:
//   1. open http://localhost:8425/?mock
//   2. in the console: (await import('/test/print-check.js')).run()
// Every print path is sent to the mock printer, the ZPL is decoded back into dots, and the
// result must match the on-screen preview exactly.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);

// Decode each ^GFA graphic in a ZPL job into { width, height, black }.
export function decodeZpl(text) {
  const out = [];
  for (const m of text.matchAll(/\^PW(\d+)[\s\S]*?\^GFA,(\d+),\d+,(\d+),([^^]*)\^FS/g)) {
    const [, pw, total, bprText, data] = m;
    const bpr = +bprText;
    const hexRow = bpr * 2;
    const lines = [];
    let row = '';
    let prev = '';
    let count = 0;
    const flush = () => {
      lines.push(row);
      prev = row;
      row = '';
    };
    for (const ch of data.replace(/\s/g, '')) {
      if (ch >= 'G' && ch <= 'Y') count += ch.charCodeAt(0) - 70;
      else if (ch >= 'g' && ch <= 'z') count += (ch.charCodeAt(0) - 102) * 20;
      else if (ch === ',') (row = row.padEnd(hexRow, '0')), flush();
      else if (ch === '!') (row = row.padEnd(hexRow, 'F')), flush();
      else if (ch === ':') (row = prev), flush();
      else {
        row += ch.repeat(count || 1);
        count = 0;
        if (row.length === hexRow) flush();
      }
    }
    const width = +pw;
    const height = +total / bpr;
    const black = new Uint8Array(width * height);
    lines.forEach((r, y) => {
      for (let x = 0; x < width; x++) {
        const v = parseInt(r.substr((x >> 3) * 2, 2), 16);
        if (v & (0x80 >> (x & 7))) black[y * width + x] = 1;
      }
    });
    out.push({ width, height, black });
  }
  return out;
}

function comparePreview(label, canvas) {
  if (!label) return 'no label decoded';
  if (canvas.width !== label.width || canvas.height !== label.height) return `size ${canvas.width}×${canvas.height} vs ${label.width}×${label.height}`;
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let diff = 0;
  for (let i = 0; i < label.black.length; i++) if ((data[i * 4] < 128 ? 1 : 0) !== label.black[i]) diff++;
  return diff === 0 ? 'ok' : `${diff} dots differ from the preview`;
}

async function press(button) {
  const { printer } = window.__app;
  const before = printer.sent.length;
  const logBefore = $('#log').textContent.length;
  button.click();
  for (let i = 0; i < 80 && printer.sent.length === before; i++) await wait(100);
  const errors = $('#log').textContent.slice(logBefore).split('\n').filter((l) => /Error/.test(l));
  if (printer.sent.length === before) return { error: errors[0] || $('#toast').textContent || 'nothing sent' };
  return { job: new TextDecoder().decode(printer.sent.at(-1)), errors };
}

async function load(name) {
  const blob = await fetch(`/test/fixtures/${name}`).then((r) => r.blob());
  await window.__app.loadFile(new File([blob], name, { type: 'application/pdf' }));
  await wait(300);
}

async function editor(steps) {
  const ed = window.__app.editor;
  $('#adjust-btn').click();
  for (let i = 0; i < 40 && !ed.isOpen; i++) await wait(100);
  ed.anim.finish();
  await steps(ed);
  ed.anim.finish();
  $('.ed-done').click();
  for (let i = 0; i < 40 && !$('#editor').hidden; i++) (ed.anim.finish(), await wait(100));
  await wait(500);
}

export async function run() {
  if (!window.__app?.printer?.sent) throw new Error('Open the app with ?mock first.');
  const { printer, showTab } = window.__app;
  if (!printer.connected) await printer.connect();
  const results = [];
  const check = async (name, preview, expectLabels = 1) => {
    const { job, error } = await press($('#print-btn'));
    if (error) return results.push({ name, result: `FAIL: ${error}` });
    const labels = decodeZpl(job);
    const match = comparePreview(labels[0], $(preview));
    const ok = match === 'ok' && labels.length === expectLabels;
    results.push({ name, result: ok ? 'ok' : `FAIL: ${match}, ${labels.length}/${expectLabels} labels` });
  };

  showTab('ship');
  await load('letter-with-label.pdf');
  await check('letter PDF, label found automatically', '#ship-preview');

  await load('4x6-two-pages.pdf');
  $('#all-pages').checked || $('#all-pages').click();
  await check('4×6 PDF, whole page, all pages', '#ship-preview', 2);

  await load('landscape-label.pdf');
  await editor(async (ed) => {
    $('[data-act="rotate"]').click();
    ed.anim.finish();
    ed.zoomAt({ x: ed.F.x + ed.F.w / 2, y: ed.F.y + ed.F.h / 2 }, 1.5);
  });
  await check('sideways PDF, rotated and zoomed in the editor', '#ship-preview');

  await editor(async (ed) => {
    $('.ed-shape [data-value="free"]').click();
    ed.anim.finish();
    const F = ed.F;
    ed.setRect(['fx', 'fy', 'fw', 'fh'], { x: F.x, y: F.y, w: F.w * 0.7, h: F.h * 0.8 });
    const C = ed.C;
    ed.setRect(['cx', 'cy', 'cw', 'ch'], { x: C.x, y: C.y, w: C.w * 0.7, h: C.h * 0.8 });
  });
  await check('freeform crop', '#ship-preview');

  showTab('quick');
  const text = $('#q-text');
  text.value = 'Print check\nQuick label';
  text.dispatchEvent(new Event('input'));
  await check('quick label', '#quick-preview');

  showTab('printer');
  const test = await press($('[data-tool="test"]'));
  results.push({ name: 'test print', result: test.job?.includes('^FDConnection OK^FS') ? 'ok' : `FAIL: ${test.error || 'unexpected job'}` });

  console.table(results);
  return results;
}
