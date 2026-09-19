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
    this.listening = new WeakSet();
    this.discovered = null; // the device whose services we've already listed in the log
    this.connecting = null; // in-flight (re)connection, shared by everyone who needs it
    this.userDisconnected = false;
    this.queue = Promise.resolve();
    this.options = { chunkSize: 180, reliable: true, maxKBps: 8 };
    this.rxText = '';
    this.retryMs = 1000; // first retry delay; doubles up to 15 s
    // Coming back to the page: pick the connection back up.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.autoConnect();
    });
  }

  get connected() {
    return !!(this.device && this.device.gatt.connected && this.writeChar);
  }

  // 'connected' | 'connecting' | 'idle'
  get state() {
    if (this.connected) return 'connected';
    return this.connecting && !this.userDisconnected ? 'connecting' : 'idle';
  }

  get name() {
    return this.device?.name || 'Printer';
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }

  // Ask the user to pick a printer (must run from a tap).
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
    this.adopt(device);
    this.userDisconnected = false;
    await this.open();
  }

  adopt(device) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      if (this.device !== device) return; // an older connection we already replaced
      this.writeChar = null;
      this.notifyChar = null;
      this.log(this.userDisconnected ? 'Printer disconnected.' : 'Lost the printer. Reconnecting when it is back in range…');
      this.changed();
      this.autoConnect();
    });
  }

  // After a page reload: reconnect to a printer the user picked before, without asking again.
  // Needs getDevices(), which not every browser has.
  async restore(saved) {
    if (!saved || this.device || !bluetoothAvailable()) return false;
    if (typeof navigator.bluetooth.getDevices !== 'function') {
      this.log('This browser cannot reconnect to a remembered printer by itself. Tap Connect once.');
      return false;
    }
    let devices = [];
    try {
      devices = await navigator.bluetooth.getDevices();
    } catch (e) {
      this.log(`Could not look up remembered printers (${e.message}).`);
      return false;
    }
    const device = devices.find((d) => d.id === saved.id) || devices.find((d) => saved.name && d.name === saved.name);
    if (!device) {
      this.log(`${saved.name || 'The printer'} is not remembered by this browser any more. Tap Connect once.`);
      return false;
    }
    this.log(`Remembered ${device.name || 'printer'}. Connecting when it is on and nearby…`);
    this.adopt(device);
    this.autoConnect();
    return true;
  }

  // Keep trying to connect to the known printer in the background until it works, the page is
  // hidden, or the user disconnects. Safe to call any time; concurrent calls share one attempt.
  autoConnect() {
    if (!this.device || this.connected || this.userDisconnected) return this.connecting || Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let delay = this.retryMs;
      let lastError = '';
      while (this.device && !this.connected && !this.userDisconnected && !document.hidden) {
        try {
          await this.waitUntilNearby();
          if (this.userDisconnected) break;
          await this.open();
          if (this.userDisconnected) this.device.gatt.disconnect(); // stopped while connecting
        } catch (e) {
          if (e.message !== lastError) this.log(`Not connected yet: ${e.message}`);
          lastError = e.message;
          await sleep(delay);
          delay = Math.min(delay * 2, this.retryMs * 15);
        }
      }
    })().finally(() => {
      this.connecting = null;
      this.changed();
    });
    this.changed();
    return this.connecting;
  }

  // Where supported, wait for the printer to advertise before connecting, instead of repeatedly
  // attempting connections that fail while it's off or out of range.
  async waitUntilNearby(maxWait = 30000) {
    const device = this.device;
    if (typeof device.watchAdvertisements !== 'function') return;
    const stop = new AbortController();
    try {
      await device.watchAdvertisements({ signal: stop.signal });
    } catch {
      return; // not allowed here; just try connecting
    }
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        device.removeEventListener('advertisementreceived', done);
        resolve();
      };
      const timer = setTimeout(done, maxWait);
      device.addEventListener('advertisementreceived', done);
    });
    stop.abort();
  }

  async open() {
    const device = this.device;
    const verbose = this.discovered !== device; // list services only the first time
    if (verbose) this.log(`Connecting to "${device.name || device.id}"…`);
    const server = await device.gatt.connect();
    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      this.log(`Could not list services (${e.message}).`);
    }
    if (verbose) this.log(`Found ${services.length} service(s).`);

    const writable = [];
    const notifiable = [];
    for (const service of services) {
      let chars = [];
      try {
        chars = await service.getCharacteristics();
      } catch (e) {
        if (verbose) this.log(`  service ${short(service.uuid)}: can't read characteristics (${e.message})`);
        continue;
      }
      for (const c of chars) {
        const p = c.properties;
        const flags = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]);
        if (verbose) this.log(`  ${short(service.uuid)} / ${short(c.uuid)}: ${flags.join(', ') || 'no flags'}`);
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
    if (verbose) this.log(`Sending data via ${short(this.writeChar.service.uuid)} / ${short(this.writeChar.uuid)}.`);

    // Prefer a notify characteristic in the same service as the write characteristic.
    this.notifyChar = notifiable.find((c) => c.service.uuid === this.writeChar.service.uuid) || notifiable[0] || null;
    if (this.notifyChar) {
      try {
        await this.notifyChar.startNotifications();
        if (!this.listening.has(this.notifyChar)) {
          this.notifyChar.addEventListener('characteristicvaluechanged', (e) => this.onData(e.target.value));
          this.listening.add(this.notifyChar);
        }
        if (verbose) this.log(`Listening for replies on ${short(this.notifyChar.uuid)}.`);
      } catch (e) {
        if (verbose) this.log(`Could not listen for replies (${e.message}).`);
        this.notifyChar = null;
      }
    }
    this.discovered = device;
    this.log(`Connected to ${device.name || 'printer'}.`);
    this.changed();
  }

  // Make sure we're connected before sending; waits for a background reconnect, but not forever.
  async ensureConnected(timeoutMs = 12000) {
    if (this.connected) return;
    if (!this.device) throw new Error('Not connected to a printer.');
    this.userDisconnected = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The printer isn't responding. Make sure it's switched on and nearby, and that RLabel is closed.")), timeoutMs);
    });
    try {
      await Promise.race([this.autoConnect(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.connected) throw new Error("Couldn't connect to the printer.");
  }

  disconnect() {
    this.userDisconnected = true;
    this.device?.gatt.disconnect(); // also cancels a connection attempt still in progress
    this.writeChar = null;
    this.notifyChar = null;
    this.changed();
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
    const { chunkSize, reliable, maxKBps } = this.options;
    const c = this.writeChar;
    const canConfirm = c.properties.write;
    const canStream = c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === 'function';
    // Confirmed writes wait for the printer's Bluetooth chip to acknowledge each packet.
    const confirmed = canConfirm && (reliable || !canStream);
    const size = Math.max(20, Math.min(512, chunkSize | 0));
    // The chip passes data on to the printer at serial-port speed and silently drops whatever
    // overflows its small buffer, so big labels are paced. Small jobs fit in the buffer anyway.
    const bytesPerMs = maxKBps > 0 ? (maxKBps * 1024) / 1000 : Infinity;
    const started = performance.now();
    for (let off = 0; off < bytes.length; off += size) {
      const chunk = bytes.slice(off, off + size);
      if (!confirmed) await c.writeValueWithoutResponse(chunk);
      else if (typeof c.writeValueWithResponse === 'function') await c.writeValueWithResponse(chunk);
      else await c.writeValue(chunk);
      const ahead = (off + chunk.length) / bytesPerMs - (performance.now() - started);
      if (ahead > 4) await sleep(ahead);
      onProgress?.(Math.min(bytes.length, off + size), bytes.length);
    }
    const secs = Math.max(0.001, (performance.now() - started) / 1000);
    const kb = bytes.length / 1024;
    this.log(`Sent ${kb.toFixed(1)} KB in ${secs.toFixed(1)} s (${(kb / secs).toFixed(1)} KB/s, ${confirmed ? 'confirmed' : 'unconfirmed'} packets of ${size} bytes).`);
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
  get state() {
    return this.isConnected ? 'connected' : 'idle';
  }
  get name() {
    return 'Mock printer';
  }
  get device() {
    return null;
  }
  async restore() {
    return false;
  }
  autoConnect() {
    return Promise.resolve();
  }
  async ensureConnected() {
    if (!this.isConnected) throw new Error('Not connected to a printer.');
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
