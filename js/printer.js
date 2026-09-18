// Bluetooth LE connection to the label printer, via Web Bluetooth.

const u16 = (hex) => `0000${hex}-0000-1000-8000-00805f9b34fb`;

// GATT services that Chinese thermal/label printer modules commonly expose for raw data.
// Web Bluetooth only lets us see services listed here, so the list is deliberately broad.
export const PRINTER_SERVICES = [
  u16('18f0'),
  u16('ff00'),
  u16('fff0'),
  u16('ffe0'),
  u16('ffe5'),
  u16('ffd0'),
  u16('ffc0'),
  u16('ffb0'),
  u16('ffa0'),
  u16('ff80'),
  u16('fee7'),
  u16('fee0'),
  u16('ae30'),
  u16('ae3a'),
  u16('af30'),
  u16('abf0'),
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
];

// Write characteristics known to accept raw printer data, in order of preference.
const PREFERRED_WRITE = [
  u16('2af1'),
  'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  '49535343-8841-43f4-a8d4-ecbe34729bb3',
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  u16('ff02'),
  u16('fff2'),
  u16('ffe1'),
  u16('ae01'),
];

const NAME_PREFIXES = ['RP', 'RT', 'Rongta', 'RONGTA', 'rongta', 'Printer', 'Label'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (uuid) => (/^0000(....)-0000-1000-8000-00805f9b34fb$/i.test(uuid) ? uuid.slice(4, 8) : uuid);

export const bluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export class BlePrinter extends EventTarget {
  constructor(log) {
    super();
    this.log = log;
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.queue = Promise.resolve();
    this.options = { chunkSize: 180, pauseEvery: 16, pauseMs: 20, reliable: false };
    this.rxText = '';
  }

  get connected() {
    return !!(this.device && this.device.gatt.connected && this.writeChar);
  }

  get name() {
    return this.device?.name || 'Printer';
  }

  async connect({ showAll = false } = {}) {
    if (!bluetoothAvailable()) throw new Error('This browser does not support Bluetooth. On iPhone, open this page in the Bluefy app.');
    const request = showAll
      ? { acceptAllDevices: true, optionalServices: PRINTER_SERVICES }
      : {
          filters: [...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })), ...PRINTER_SERVICES.map((s) => ({ services: [s] }))],
          optionalServices: PRINTER_SERVICES,
        };
    this.log(`Looking for printers${showAll ? ' (showing all devices)' : ''}…`);
    const device = await navigator.bluetooth.requestDevice(request);
    if (this.device && this.device !== device) this.disconnect();
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      if (this.device !== device) return; // an older connection we already replaced
      this.writeChar = null;
      this.notifyChar = null;
      this.log('Printer disconnected.');
      this.dispatchEvent(new Event('change'));
    });
    await this.open();
  }

  async open() {
    const device = this.device;
    this.log(`Connecting to "${device.name || device.id}"…`);
    const server = await device.gatt.connect();
    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      this.log(`Could not list services (${e.message}).`);
    }
    this.log(`Found ${services.length} service(s).`);

    const writable = [];
    const notifiable = [];
    for (const service of services) {
      let chars = [];
      try {
        chars = await service.getCharacteristics();
      } catch (e) {
        this.log(`  service ${short(service.uuid)}: can't read characteristics (${e.message})`);
        continue;
      }
      for (const c of chars) {
        const p = c.properties;
        const flags = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]);
        this.log(`  ${short(service.uuid)} / ${short(c.uuid)}: ${flags.join(', ') || 'no flags'}`);
        if (p.write || p.writeWithoutResponse) writable.push(c);
        if (p.notify || p.indicate) notifiable.push(c);
      }
    }
    if (!writable.length) {
      server.disconnect();
      throw new Error('Connected, but found no way to send data to this device. Is it the printer? (See the log in Printer → Diagnostics.)');
    }

    const rank = (c) => {
      const i = PREFERRED_WRITE.indexOf(c.uuid.toLowerCase());
      return (i < 0 ? 100 : i) - (c.properties.writeWithoutResponse ? 0.5 : 0);
    };
    writable.sort((a, b) => rank(a) - rank(b));
    this.writeChar = writable[0];
    this.log(`Sending data via ${short(this.writeChar.service.uuid)} / ${short(this.writeChar.uuid)}.`);

    // Prefer a notify characteristic in the same service as the write characteristic.
    this.notifyChar = notifiable.find((c) => c.service.uuid === this.writeChar.service.uuid) || notifiable[0] || null;
    if (this.notifyChar) {
      try {
        await this.notifyChar.startNotifications();
        this.notifyChar.addEventListener('characteristicvaluechanged', (e) => this.onData(e.target.value));
        this.log(`Listening for replies on ${short(this.notifyChar.uuid)}.`);
      } catch (e) {
        this.log(`Could not listen for replies (${e.message}).`);
        this.notifyChar = null;
      }
    }
    this.dispatchEvent(new Event('change'));
  }

  async ensureConnected() {
    if (this.connected) return;
    if (!this.device) throw new Error('Not connected to a printer.');
    await this.open(); // reconnect to the same printer without asking again
  }

  disconnect() {
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.writeChar = null;
    this.notifyChar = null;
    this.dispatchEvent(new Event('change'));
  }

  onData(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const text = Array.from(bytes, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 || b === 13 ? '\n' : '')).join('');
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
    this.rxText += text;
    this.log(`← ${text.trim() ? JSON.stringify(text.trim()) + '  ' : ''}[${hex}]`);
    this.dispatchEvent(new CustomEvent('data', { detail: bytes }));
  }

  // Send bytes to the printer in Bluetooth-sized chunks. Jobs are queued, never interleaved.
  send(bytes, onProgress) {
    const job = this.queue.then(() => this.sendNow(bytes, onProgress));
    this.queue = job.catch(() => {});
    return job;
  }

  async sendNow(bytes, onProgress) {
    await this.ensureConnected();
    const { chunkSize, pauseEvery, pauseMs, reliable } = this.options;
    const c = this.writeChar;
    const noResponse = !reliable && c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === 'function';
    const size = Math.max(20, Math.min(512, chunkSize | 0));
    const started = performance.now();
    let n = 0;
    for (let off = 0; off < bytes.length; off += size) {
      const chunk = bytes.slice(off, off + size);
      if (noResponse) await c.writeValueWithoutResponse(chunk);
      else if (typeof c.writeValueWithResponse === 'function' && c.properties.write) await c.writeValueWithResponse(chunk);
      else await c.writeValue(chunk);
      n++;
      if (pauseEvery > 0 && n % pauseEvery === 0 && pauseMs > 0) await sleep(pauseMs);
      onProgress?.(Math.min(bytes.length, off + size), bytes.length);
    }
    const secs = (performance.now() - started) / 1000;
    this.log(`Sent ${(bytes.length / 1024).toFixed(1)} KB in ${secs.toFixed(1)} s${noResponse ? '' : ' (reliable mode)'}.`);
  }

  // Send a query and collect whatever text comes back within `waitMs`.
  async query(bytes, waitMs = 1500) {
    this.rxText = '';
    await this.send(bytes);
    await sleep(waitMs);
    return this.rxText.trim();
  }
}

// Stand-in printer for testing without hardware (open the app with ?mock in the URL).
export class MockPrinter extends EventTarget {
  constructor(log) {
    super();
    this.log = log;
    this.options = {};
    this.isConnected = false;
    this.sent = [];
  }
  get connected() {
    return this.isConnected;
  }
  get name() {
    return 'Mock printer';
  }
  async connect() {
    this.isConnected = true;
    this.log('Connected to mock printer.');
    this.dispatchEvent(new Event('change'));
  }
  disconnect() {
    this.isConnected = false;
    this.dispatchEvent(new Event('change'));
  }
  async send(bytes, onProgress) {
    if (!this.isConnected) throw new Error('Not connected to a printer.');
    for (let off = 0; off < bytes.length; off += 4096) {
      onProgress?.(Math.min(bytes.length, off + 4096), bytes.length);
      await sleep(5);
    }
    this.sent.push(bytes);
    this.log(`Mock printer received ${(bytes.length / 1024).toFixed(1)} KB.`);
  }
  async query() {
    return 'MOCK';
  }
}
