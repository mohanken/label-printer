import { mmToDots, toMono, packRows, drawMono } from './raster.js';
import { buildJob, COMMANDS, zplTestLabel } from './encoders.js';
import { BlePrinter, MockPrinter, bluetoothAvailable } from './printer.js';
import { openFile, previewPage, autoCrop, pageMatchesLabel, autoRotation, renderToLabel, CropEditor } from './importer.js';
import { DEFAULT_DESIGN, renderDesign, testDesign } from './designer.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

const LABEL_SIZES = [
  { id: '4x6', name: '4 × 6 in (shipping)', short: '4 × 6 in', w: 101.6, h: 152.4 },
  { id: '100x150', name: '100 × 150 mm', short: '100 × 150 mm', w: 100, h: 150 },
  { id: '4x4', name: '4 × 4 in', short: '4 × 4 in', w: 101.6, h: 101.6 },
  { id: '4x3', name: '4 × 3 in', short: '4 × 3 in', w: 101.6, h: 76.2 },
  { id: '4x2', name: '4 × 2 in', short: '4 × 2 in', w: 101.6, h: 50.8 },
  { id: '3x2', name: '3 × 2 in', short: '3 × 2 in', w: 76.2, h: 50.8 },
  { id: '2.25x1.25', name: '2¼ × 1¼ in', short: '2¼ × 1¼ in', w: 57.15, h: 31.75 },
  { id: '2x1', name: '2 × 1 in', short: '2 × 1 in', w: 50.8, h: 25.4 },
  { id: 'custom', name: 'Custom size…' },
];

const DEFAULTS = {
  labelSize: '4x6',
  customW: 4,
  customH: 6,
  density: 8,
  speed: 4,
  flip: false,
  language: 'zpl', // the RP425 speaks ZPL (per its manual)
  gapMm: 3,
  chunkSize: 180,
  reliable: false,
  invert: true,
  compress: true,
  shipStyle: 'sharp',
  threshold: 150,
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode) — settings just won't be remembered */
    }
  },
};

const SETTINGS_VERSION = 2;
const storedSettings = store.get('lp.settings', {});
// Version 1 defaulted to TSPL, which the RP425 ignores. Move saved settings over to ZPL.
if ((storedSettings.v || 1) < 2) delete storedSettings.language;
const settings = { ...DEFAULTS, ...storedSettings, v: SETTINGS_VERSION };
const saveSettings = () => store.set('lp.settings', settings);

function labelMm() {
  if (settings.labelSize === 'custom') return { w: settings.customW * 25.4, h: settings.customH * 25.4 };
  const s = LABEL_SIZES.find((x) => x.id === settings.labelSize) || LABEL_SIZES[0];
  return { w: s.w, h: s.h };
}

function labelDots() {
  const { w, h } = labelMm();
  return { w: mmToDots(w), h: mmToDots(h) };
}

function labelSizeText() {
  if (settings.labelSize === 'custom') return `${+settings.customW} × ${+settings.customH} in labels`;
  return `${(LABEL_SIZES.find((x) => x.id === settings.labelSize) || LABEL_SIZES[0]).short} labels`;
}

function jobSettings() {
  const { w, h } = labelMm();
  return { widthMm: w, heightMm: h, gapMm: settings.gapMm, density: settings.density, speed: settings.speed, flip: settings.flip, invert: settings.invert, compress: settings.compress };
}

// ---------------------------------------------------------------------------------------------
// Log, toast, errors
// ---------------------------------------------------------------------------------------------

const logLines = [];
function log(msg) {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logLines.push(`${t}  ${msg}`);
  if (logLines.length > 500) logLines.shift();
  const el = $('#log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
  console.log('[label-printer]', msg);
}

let toastTimer;
function toast(msg, kind = 'info', ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

class UserError extends Error {}

function reportError(e) {
  if (e?.name === 'NotFoundError' && /cancel/i.test(e.message)) return; // closed the device chooser
  log(`Error: ${e?.name || 'Error'}: ${e?.message || e}`);
  let msg = e?.message || String(e);
  if (e?.name === 'NetworkError' || /disconnected|GATT/i.test(msg)) {
    msg = "Lost the connection to the printer. Make sure it's on and nearby, close RLabel, then try again.";
  } else if (e?.name === 'SecurityError' || e?.name === 'NotAllowedError') {
    msg = 'Bluetooth access was blocked. Allow Bluetooth for this browser in your phone settings.';
  } else if (e?.name === 'NotFoundError') {
    msg = 'No printer was found. Is it switched on? Try “Show all Bluetooth devices” on the Printer tab.';
  }
  toast(msg, 'error', 7000);
}

// ---------------------------------------------------------------------------------------------
// Printer connection
// ---------------------------------------------------------------------------------------------

const mock = new URLSearchParams(location.search).has('mock');
const printer = mock ? new MockPrinter(log) : new BlePrinter(log);

function applyPrinterOptions() {
  printer.options = { ...printer.options, chunkSize: settings.chunkSize, reliable: settings.reliable };
}
applyPrinterOptions();

function updateConnUI() {
  const on = printer.connected;
  const known = !!printer.device;
  $('#conn-pill').classList.toggle('on', on);
  $('#conn-label').textContent = on ? printer.name : known ? 'Reconnect' : 'Connect printer';
  $('#conn-detail').textContent = on
    ? `Connected to ${printer.name}.`
    : known
      ? `${printer.name} is disconnected. It will reconnect when you print.`
      : 'Not connected.';
  $('#connect-btn').hidden = on;
  $('#connect-btn').textContent = known ? 'Reconnect' : 'Connect printer';
  $('#disconnect-btn').hidden = !on;
}
printer.addEventListener('change', updateConnUI);

async function connect(showAll = false) {
  try {
    if (printer.device && !printer.connected && !showAll) await printer.ensureConnected();
    else await printer.connect({ showAll });
    toast(`Connected to ${printer.name}`, 'ok');
  } catch (e) {
    reportError(e);
  }
  updateConnUI();
}

async function ensurePrinter() {
  if (!printer.connected && !printer.device) await printer.connect();
}

async function sendToPrinter(bytes) {
  const bar = $('.progress');
  const fill = $('#progress-fill');
  fill.style.width = '0%';
  bar.hidden = false;
  try {
    await printer.send(bytes, (done, total) => (fill.style.width = `${(done / total) * 100}%`));
  } finally {
    setTimeout(() => (bar.hidden = true), 700);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------------------------

function segmented(el, value, onPick) {
  const set = (v) =>
    $$('button[data-value]', el).forEach((b) => {
      const on = b.dataset.value === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  set(value);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    set(b.dataset.value);
    onPick(b.dataset.value);
  });
  return set;
}

const state = { tab: 'ship', copies: 1, printing: false };

function showTab(name) {
  state.tab = name;
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('main > section').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  $('#printbar').hidden = name === 'printer';
  document.body.classList.toggle('has-printbar', name !== 'printer');
  store.set('lp.tab', name);
  if (name === 'quick') renderQuick();
  window.scrollTo({ top: 0 });
}

function refreshLabelSizeText() {
  $$('.label-size-text').forEach((el) => (el.textContent = `Printing on ${labelSizeText()}`));
}

// ---------------------------------------------------------------------------------------------
// Shipping label tab
// ---------------------------------------------------------------------------------------------

const ship = { file: null, pages: [], previews: [], index: 0, mode: 'auto', custom: null, rotation: null, lastRotation: 0, allPages: false, token: 0, shownPreview: null };

const cropEditor = new CropEditor($('#crop-editor'), (crop) => {
  ship.custom = crop;
  ship.mode = 'custom';
  setCropMode('custom');
  refreshShip();
});

const setCropMode = segmented($('#crop-mode'), ship.mode, (mode) => {
  ship.mode = mode;
  if (mode === 'custom') {
    toggleCropPanel(true);
    if (!ship.custom) ship.custom = { ...cropEditor.crop };
  }
  refreshShip();
});

function toggleCropPanel(open = $('#crop-panel').hidden) {
  $('#crop-panel').hidden = !open;
  $('#adjust-btn').setAttribute('aria-expanded', String(open));
  $('#adjust-btn').textContent = open ? 'Hide crop' : 'Adjust crop';
}

async function pagePreview(i) {
  if (!ship.previews[i]) ship.previews[i] = await previewPage(ship.pages[i]);
  return ship.previews[i];
}

async function cropFor(i) {
  if (ship.mode === 'page') return { x: 0, y: 0, w: 1, h: 1 };
  if (ship.mode === 'custom' && ship.custom) return ship.custom;
  const { w, h } = labelDots();
  return autoCrop(await pagePreview(i), w / h);
}

async function shipLabelCanvas(i) {
  const page = ship.pages[i];
  const crop = await cropFor(i);
  const { w, h } = labelDots();
  const rotation = ship.rotation ?? autoRotation(page, crop, w, h);
  const margin = ship.mode === 'auto' ? mmToDots(2) : 0;
  const canvas = await renderToLabel(page, { crop, rotation, labelW: w, labelH: h, margin });
  return { canvas, crop, rotation };
}

const shipMono = (canvas) => toMono(canvas, { mode: settings.shipStyle, threshold: settings.threshold });

async function refreshShip() {
  if (!ship.pages.length) return;
  const token = ++ship.token;
  const i = ship.index;
  try {
    const preview = await pagePreview(i);
    const { canvas, crop, rotation } = await shipLabelCanvas(i);
    if (token !== ship.token) return; // a newer refresh started
    ship.lastRotation = rotation;
    drawMono(shipMono(canvas), $('#ship-preview'));
    if (ship.shownPreview !== preview) {
      cropEditor.setPage(preview);
      ship.shownPreview = preview;
    }
    cropEditor.setCrop(crop);
  } catch (e) {
    reportError(e);
  }
}

function updatePager() {
  const n = ship.pages.length;
  $('#pager').hidden = n < 2;
  $('#page-label').textContent = `Page ${ship.index + 1} of ${n}`;
  $('#page-prev').disabled = ship.index === 0;
  $('#page-next').disabled = ship.index === n - 1;
  $('#all-pages-row').hidden = n < 2;
  $('#all-pages-label').textContent = `Print all ${n} pages (one label each)`;
}

async function loadFile(file) {
  if (!file) return;
  toast(`Opening ${file.name}…`, 'info', 10000);
  try {
    const pages = await openFile(file);
    Object.assign(ship, { file, pages, previews: new Array(pages.length), index: 0, rotation: null, custom: null, allPages: false, shownPreview: null });
    const { w, h } = labelMm();
    ship.mode = pageMatchesLabel(pages[0], w, h) ? 'page' : 'auto';
    setCropMode(ship.mode);
    $('#all-pages').checked = false;
    $('#file-name').textContent = file.name;
    $('#ship-empty').hidden = true;
    $('#paste-box').hidden = true;
    $('#ship-loaded').hidden = false;
    updatePager();
    await refreshShip();
    $('#toast').hidden = true;
    log(`Opened ${file.name} (${pages.length} page${pages.length > 1 ? 's' : ''}).`);
  } catch (e) {
    reportError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Pasting a copied label (image or PDF)
// ---------------------------------------------------------------------------------------------

const PASTE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp', 'image/gif', 'image/tiff', 'image/bmp'];
const listTypes = (types) => (types.length ? types.join(', ') : 'nothing');

function pastedFile(blob, type = blob.type) {
  const generic = !blob.name || /^image\.\w+$/i.test(blob.name);
  if (!generic) return blob;
  const ext = type === 'application/pdf' ? '.pdf' : type === 'image/jpeg' ? '.jpg' : type.startsWith('image/') ? `.${type.slice(6)}` : '';
  return new File([blob], `Pasted label${ext}`, { type });
}

function nothingToPaste(types) {
  toast(`No label picture or PDF found on the clipboard (it has: ${listTypes(types)}). Copy the label first.`, 'error', 7000);
}

// Fallback for browsers that won't hand over the clipboard to a button: a box the user presses
// and holds to get the system Paste menu. The keyboard stays hidden (inputmode="none").
function showPasteBox(message = 'Press and hold the box, then tap Paste.') {
  const box = $('#paste-box');
  box.hidden = false;
  box.focus();
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast(message, 'info', 8000);
}

// "Paste" button. On iPhone this shows a small "Paste" bubble that the user taps to allow it.
async function pasteFromClipboard() {
  if (!navigator.clipboard?.read) {
    log('This browser has no clipboard button access; showing the paste box.');
    return showPasteBox();
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    log(`Clipboard read failed: ${e.name}: ${e.message}`);
    return showPasteBox();
  }
  const types = items.flatMap((item) => [...item.types]);
  log(`Clipboard has: ${listTypes(types)}.`);
  for (const type of PASTE_TYPES) {
    const item = items.find((i) => i.types.includes(type));
    if (item) return loadFile(pastedFile(await item.getType(type), type));
  }
  // The system Paste menu can sometimes offer files that the button can't see.
  showPasteBox(`No label picture or PDF found (clipboard has: ${listTypes(types)}). If you copied one, press and hold the box and tap Paste.`);
}

// Paste events: the paste box on iPhone, or Ctrl/Cmd+V anywhere on the Shipping tab.
function onPaste(e) {
  if (state.tab !== 'ship' || !e.clipboardData) return;
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  e.preventDefault();
  const dt = e.clipboardData;
  const types = [...dt.types];
  log(`Pasted: ${listTypes(types)}.`);
  const files = [...dt.files];
  if (!files.length) for (const item of dt.items) if (item.kind === 'file' && item.getAsFile()) files.push(item.getAsFile());
  log(`Pasted files: ${files.map((f) => `${f.name || '(no name)'} ${f.type || '(no type)'} ${f.size} bytes`).join('; ') || 'none'}.`);
  const file = files.find((f) => PASTE_TYPES.includes(f.type) || /\.(pdf|png|jpe?g|heic|webp|gif|tiff?|bmp)$/i.test(f.name)) || files[0];
  if (!file) return nothingToPaste(types);
  loadFile(pastedFile(file, file.type));
}

function initShip() {
  $$('.paste-btn').forEach((b) => b.addEventListener('click', pasteFromClipboard));
  document.addEventListener('paste', onPaste);
  $('#paste-box').addEventListener('input', (e) => (e.target.textContent = '')); // never keep pasted text

  $$('.file-input').forEach((input) =>
    input.addEventListener('change', () => {
      loadFile(input.files[0]);
      input.value = '';
    }),
  );

  // Desktop drag-and-drop.
  const tab = $('#tab-ship');
  tab.addEventListener('dragover', (e) => {
    e.preventDefault();
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('dragging'));
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    tab.classList.remove('dragging');
    loadFile(e.dataTransfer.files[0]);
  });

  $('#page-prev').addEventListener('click', () => {
    ship.index = Math.max(0, ship.index - 1);
    updatePager();
    refreshShip();
  });
  $('#page-next').addEventListener('click', () => {
    ship.index = Math.min(ship.pages.length - 1, ship.index + 1);
    updatePager();
    refreshShip();
  });
  $('#rotate-btn').addEventListener('click', () => {
    ship.rotation = ((ship.rotation ?? ship.lastRotation) + 90) % 360;
    refreshShip();
  });
  $('#adjust-btn').addEventListener('click', () => toggleCropPanel());
  $('#all-pages').addEventListener('change', (e) => (ship.allPages = e.target.checked));

  segmented($('#ship-style'), settings.shipStyle, (v) => {
    settings.shipStyle = v;
    saveSettings();
    refreshShip();
  });
  const th = $('#threshold');
  th.value = settings.threshold;
  const thOut = () => ($('#threshold-out').textContent = th.value < 130 ? 'lighter' : th.value > 170 ? 'heavier' : 'normal');
  thOut();
  th.addEventListener('input', () => {
    settings.threshold = +th.value;
    thOut();
    saveSettings();
    refreshShip();
  });
}

// ---------------------------------------------------------------------------------------------
// Quick label tab
// ---------------------------------------------------------------------------------------------

const design = { ...DEFAULT_DESIGN, ...store.get('lp.design', {}) };
const hasDesignContent = () => design.text.trim() || (design.code !== 'none' && design.codeData.trim());

const CODE_PLACEHOLDER = { qr: 'Link or text for the QR code', barcode: 'Numbers or letters for the barcode' };

function renderQuick() {
  const { w, h } = labelDots();
  const wrap = $('#quick-preview').parentElement;
  try {
    drawMono(toMono(renderDesign(design, w, h)), $('#quick-preview'));
    $('#q-code-data').classList.remove('invalid');
  } catch (e) {
    $('#q-code-data').classList.add('invalid');
    toast(/valid input/i.test(e.message) ? "That barcode text has characters a barcode can't hold." : e.message, 'error');
  }
  wrap.classList.toggle('empty', !hasDesignContent());
  store.set('lp.design', design);
}

function initQuick() {
  const text = $('#q-text');
  text.value = design.text;
  text.addEventListener('input', () => {
    design.text = text.value;
    renderQuick();
  });

  segmented($('#q-align'), design.align, (v) => {
    design.align = v;
    renderQuick();
  });

  const bold = $('#q-bold');
  bold.setAttribute('aria-pressed', String(design.bold));
  bold.addEventListener('click', () => {
    design.bold = !design.bold;
    bold.setAttribute('aria-pressed', String(design.bold));
    renderQuick();
  });

  const font = $('#q-font');
  font.value = design.font;
  font.addEventListener('change', () => {
    design.font = font.value;
    renderQuick();
  });

  const size = $('#q-size');
  size.value = design.fontSize;
  const sizeOut = () => ($('#q-size-out').textContent = design.fontSize > 0 ? `${Math.round((design.fontSize / 203) * 72)} pt` : 'Auto (fills the label)');
  sizeOut();
  size.addEventListener('input', () => {
    design.fontSize = +size.value;
    sizeOut();
    renderQuick();
  });

  const codeData = $('#q-code-data');
  codeData.value = design.codeData;
  const showCodeField = () => {
    codeData.hidden = design.code === 'none';
    codeData.placeholder = CODE_PLACEHOLDER[design.code] || '';
  };
  showCodeField();
  segmented($('#q-code'), design.code, (v) => {
    design.code = v;
    showCodeField();
    if (v !== 'none') codeData.focus();
    renderQuick();
  });
  codeData.addEventListener('input', () => {
    design.codeData = codeData.value;
    renderQuick();
  });

  for (const [id, key] of [
    ['#q-landscape', 'landscape'],
    ['#q-border', 'border'],
  ]) {
    const el = $(id);
    el.checked = design[key];
    el.addEventListener('change', () => {
      design[key] = el.checked;
      renderQuick();
    });
  }

  $('#q-clear').addEventListener('click', () => {
    design.text = '';
    design.codeData = '';
    text.value = '';
    codeData.value = '';
    renderQuick();
    text.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

function checkReadyToPrint() {
  if (state.tab === 'quick' && !hasDesignContent()) throw new UserError('Type some text for your label first.');
  if (state.tab === 'ship' && !ship.pages.length) throw new UserError('Choose a shipping label first.');
}

async function collectBitmaps() {
  const { w, h } = labelDots();
  if (state.tab === 'quick') return [packRows(toMono(renderDesign(design, w, h)))];
  const indexes = ship.allPages ? ship.pages.map((_, i) => i) : [ship.index];
  const out = [];
  for (const i of indexes) out.push(packRows(shipMono((await shipLabelCanvas(i)).canvas)));
  return out;
}

function setPrinting(on) {
  state.printing = on;
  const btn = $('#print-btn');
  btn.disabled = on;
  btn.textContent = on ? 'Printing…' : 'Print';
}

async function print() {
  if (state.printing) return;
  try {
    checkReadyToPrint();
    await ensurePrinter(); // opens the Bluetooth chooser the first time
    setPrinting(true);
    const bitmaps = await collectBitmaps();
    const bytes = buildJob(settings.language, bitmaps, jobSettings(), state.copies);
    const count = bitmaps.length * state.copies;
    log(`Printing ${count} label${count > 1 ? 's' : ''} (${(bytes.length / 1024).toFixed(1)} KB, ${settings.language.toUpperCase()}).`);
    await sendToPrinter(bytes);
    toast(count > 1 ? `Sent ${count} labels to the printer` : 'Sent to the printer', 'ok');
  } catch (e) {
    if (e instanceof UserError) toast(e.message);
    else reportError(e);
  } finally {
    setPrinting(false);
  }
}

async function runTool(tool) {
  try {
    await ensurePrinter();
    const cmds = COMMANDS[settings.language];
    if (tool === 'test') {
      const { w, h } = labelDots();
      const size = labelSizeText().replace(' labels', '');
      if (settings.language === 'zpl') {
        const qrSize = Math.round(Math.min(w, h) * 0.35);
        const qr = packRows(toMono(renderDesign({ ...DEFAULT_DESIGN, code: 'qr', codeData: 'Hello from Label Printer' }, qrSize, qrSize)));
        const lines = ['Connection OK', `${size} - ZPL - darkness ${settings.density}`, 'A QR code below means images print too.'];
        await sendToPrinter(zplTestLabel({ width: w, height: h, lines, qr, ...jobSettings() }));
      } else {
        const note = `${size} · TSPL · darkness ${settings.density}`;
        const bitmap = packRows(toMono(renderDesign(testDesign(note), w, h)));
        await sendToPrinter(buildJob(settings.language, [bitmap], jobSettings(), 1));
      }
      toast('Test label sent', 'ok');
    } else if (tool === 'feed') {
      await printer.send(cmds.feed());
    } else if (tool === 'calibrate') {
      await printer.send(cmds.calibrate(jobSettings()));
      toast('The printer is measuring your labels. It will feed a few.', 'info', 5000);
    } else if (tool === 'identify') {
      toast('Asking the printer…', 'info', 3000);
      const reply = await printer.query(cmds.identify());
      toast(reply ? `Printer says: ${reply}` : "No reply from the printer. Some printers don't answer; printing can still work.", 'info', 7000);
    } else if (tool === 'selfTest') {
      await printer.send(cmds.selfTest());
      toast('Printing the self-test page', 'ok');
    }
  } catch (e) {
    reportError(e);
  }
}

function initPrintBar() {
  const out = $('#copies');
  const set = (n) => {
    state.copies = Math.min(99, Math.max(1, n));
    out.textContent = state.copies;
    $('#copies-minus').disabled = state.copies === 1;
  };
  set(1);
  $('#copies-minus').addEventListener('click', () => set(state.copies - 1));
  $('#copies-plus').addEventListener('click', () => set(state.copies + 1));
  $('#print-btn').addEventListener('click', print);
}

// ---------------------------------------------------------------------------------------------
// Printer tab
// ---------------------------------------------------------------------------------------------

function refreshAllPreviews() {
  refreshLabelSizeText();
  if (state.tab === 'quick') renderQuick();
  refreshShip();
}

function initPrinterTab() {
  $('#connect-btn').addEventListener('click', () => connect(false));
  $('#connect-all-btn').addEventListener('click', () => connect(true));
  $('#disconnect-btn').addEventListener('click', () => printer.disconnect());
  $('#conn-pill').addEventListener('click', () => (printer.connected ? showTab('printer') : connect(false)));

  const sizeSel = $('#label-size');
  sizeSel.replaceChildren(...LABEL_SIZES.map((s) => new Option(s.name, s.id)));
  const cw = $('#custom-w');
  const ch = $('#custom-h');
  const syncSize = () => {
    sizeSel.value = settings.labelSize;
    $('#custom-size').hidden = settings.labelSize !== 'custom';
    cw.value = settings.customW;
    ch.value = settings.customH;
  };
  syncSize();
  sizeSel.addEventListener('change', () => {
    settings.labelSize = sizeSel.value;
    saveSettings();
    syncSize();
    refreshAllPreviews();
  });
  const onCustom = () => {
    const w = parseFloat(cw.value);
    const h = parseFloat(ch.value);
    if (!(w >= 0.5 && w <= 4.3 && h >= 0.4 && h <= 20)) return;
    settings.customW = w;
    settings.customH = h;
    saveSettings();
    refreshAllPreviews();
  };
  cw.addEventListener('change', onCustom);
  ch.addEventListener('change', onCustom);

  const density = $('#density');
  density.value = settings.density;
  $('#density-out').textContent = settings.density;
  density.addEventListener('input', () => {
    settings.density = +density.value;
    $('#density-out').textContent = settings.density;
    saveSettings();
  });

  const bind = (id, key, { type = 'value', parse = (v) => v, after } = {}) => {
    const el = $(id);
    if (type === 'checked') el.checked = settings[key];
    else el.value = settings[key];
    el.addEventListener('change', () => {
      const v = type === 'checked' ? el.checked : parse(el.value);
      if (typeof v === 'number' && !Number.isFinite(v)) return;
      settings[key] = v;
      saveSettings();
      after?.();
    });
  };
  bind('#speed', 'speed', { parse: Number });
  bind('#flip', 'flip', { type: 'checked' });
  bind('#language', 'language');
  bind('#gap', 'gapMm', { parse: parseFloat });
  bind('#chunk', 'chunkSize', { parse: (v) => Math.max(20, Math.min(512, parseInt(v, 10))), after: applyPrinterOptions });
  bind('#reliable', 'reliable', { type: 'checked', after: applyPrinterOptions });
  bind('#invert', 'invert', { type: 'checked' });
  bind('#compress', 'compress', { type: 'checked' });

  $('#reset-settings').addEventListener('click', () => {
    if (!confirm('Reset all printer and label settings to their defaults?')) return;
    store.set('lp.settings', {});
    location.reload();
  });

  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => runTool(b.dataset.tool)));

  $('#copy-log').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logLines.join('\n'));
      toast('Log copied', 'ok');
    } catch {
      toast("Couldn't copy. Press and hold the log to select it instead.");
    }
  });
  $('#clear-log').addEventListener('click', () => {
    logLines.length = 0;
    $('#log').textContent = '';
  });
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

function init() {
  $$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('.goto-printer').forEach((b) =>
    b.addEventListener('click', () => {
      showTab('printer');
      $('#label-size').focus();
    }),
  );

  if (!bluetoothAvailable() && !mock) {
    $('#bt-banner').hidden = false;
    log('Web Bluetooth is not available in this browser.');
  }
  $('#copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href.split('?')[0]);
      toast('Link copied. Paste it into Bluefy.', 'ok');
    } catch {
      toast(location.href.split('?')[0], 'info', 10000);
    }
  });

  initShip();
  initQuick();
  initPrintBar();
  initPrinterTab();
  refreshLabelSizeText();
  updateConnUI();
  showTab(store.get('lp.tab', 'ship'));
  log(`Ready${mock ? ' (mock printer)' : ''}. ${labelSizeText()}, ${settings.language.toUpperCase()}.`);

  if (mock) window.__app = { printer, ship, design, settings, collectBitmaps, loadFile, showTab };
}

init();
