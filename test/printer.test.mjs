// Connection behaviour of BlePrinter against a pretend Web Bluetooth printer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals the printer module needs.
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
const bluetooth = { devices: [] };
Object.defineProperty(globalThis, 'navigator', { value: { bluetooth }, configurable: true });

const { BlePrinter } = await import('../js/printer.js');

const WRITE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';

// A fake printer. `failures` connection attempts fail before one succeeds.
function fakeDevice({ id = 'dev-1', name = 'RP425-BLE', failures = 0, never = false } = {}) {
  const device = new EventTarget();
  const written = [];
  const characteristic = {
    uuid: '00002af1-0000-1000-8000-00805f9b34fb',
    properties: { writeWithoutResponse: true, write: true },
    writeValueWithoutResponse: async (chunk) => {
      device.modes.add('unconfirmed');
      written.push(...chunk);
    },
    writeValueWithResponse: async (chunk) => {
      device.modes.add('confirmed');
      written.push(...chunk);
    },
  };
  const service = { uuid: WRITE_UUID, getCharacteristics: async () => [characteristic] };
  characteristic.service = service;
  let attempts = 0;
  device.id = id;
  device.name = name;
  device.written = written;
  device.modes = new Set();
  device.gatt = {
    connected: false,
    async connect() {
      attempts++;
      if (never || attempts <= failures) throw new Error('Connection attempt failed.');
      this.connected = true;
      return this;
    },
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    getPrimaryServices: async () => [service],
  };
  device.attempts = () => attempts;
  return device;
}

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function newPrinter() {
  const lines = [];
  const p = new BlePrinter((m) => lines.push(m));
  p.retryMs = 5;
  p.lines = lines;
  return p;
}

test('restore reconnects to the remembered printer without the device list', async () => {
  const device = fakeDevice();
  bluetooth.getDevices = async () => [fakeDevice({ id: 'other', name: 'Speaker' }), device];
  const p = newPrinter();
  assert.equal(await p.restore({ id: 'dev-1', name: 'RP425-BLE' }), true);
  await until(() => p.connected);
  assert.equal(p.state, 'connected');
  assert.equal(p.device, device);
});

test('restore finds the printer by name if its id changed', async () => {
  const device = fakeDevice({ id: 'new-id' });
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  assert.equal(await p.restore({ id: 'old-id', name: 'RP425-BLE' }), true);
  await until(() => p.connected);
});

test('restore gives up politely when the browser has no getDevices', async () => {
  delete bluetooth.getDevices;
  const p = newPrinter();
  assert.equal(await p.restore({ id: 'dev-1', name: 'RP425-BLE' }), false);
  assert.match(p.lines.join('\n'), /Tap Connect once/);
  assert.equal(p.state, 'idle');
});

test('a dropped connection is retried in the background until it works', async () => {
  const device = fakeDevice();
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  await p.restore({ id: 'dev-1' });
  await until(() => p.connected);
  // Printer goes out of range: the next two attempts fail, the third works.
  const before = device.attempts();
  device.gatt.connected = false;
  let failuresLeft = 2;
  const realConnect = device.gatt.connect;
  device.gatt.connect = async function () {
    if (failuresLeft-- > 0) throw new Error('Connection attempt failed.');
    return realConnect.call(this);
  };
  device.dispatchEvent(new Event('gattserverdisconnected'));
  assert.equal(p.state, 'connecting');
  await until(() => p.connected);
  assert.ok(device.attempts() > before);
  assert.equal(p.lines.filter((l) => l.startsWith('Not connected yet')).length, 1, 'repeated errors are logged once');
});

test('Stop looking / Disconnect ends retries and nothing reconnects by itself', async () => {
  const device = fakeDevice({ never: true });
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  await p.restore({ id: 'dev-1' });
  assert.equal(p.state, 'connecting');
  p.disconnect();
  assert.equal(p.state, 'idle', 'status changes immediately');
  await until(() => p.connecting === null);
  const attempts = device.attempts();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(device.attempts(), attempts, 'no more attempts after stopping');
});

test('printing waits for a reconnect, but gives a clear error if the printer never appears', async () => {
  const device = fakeDevice({ never: true });
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  await p.restore({ id: 'dev-1' });
  await assert.rejects(p.ensureConnected(60), /isn't responding/);
  p.disconnect();
});

test('sending after a reconnect writes the bytes to the printer', async () => {
  const device = fakeDevice({ failures: 1 });
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  await p.restore({ id: 'dev-1' });
  await p.send(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(device.written, [1, 2, 3, 4]);
});

test('big jobs are sent as confirmed packets, paced to the speed limit', async () => {
  const device = fakeDevice();
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  p.options = { ...p.options, maxKBps: 40 }; // 40 KB/s → 8 KB takes about 200 ms
  await p.restore({ id: 'dev-1' });
  const bytes = new Uint8Array(8 * 1024).map((_, i) => i & 255);
  const t0 = performance.now();
  await p.send(bytes);
  const ms = performance.now() - t0;
  assert.deepEqual([...device.modes], ['confirmed']);
  assert.equal(device.written.length, bytes.length);
  assert.deepEqual(device.written.slice(0, 5), [0, 1, 2, 3, 4], 'bytes arrive in order');
  assert.ok(ms >= 170, `took ${ms.toFixed(0)} ms, should be paced to ~200 ms`);
  assert.match(p.lines.at(-1), /confirmed packets of 180 bytes/);
});

test('with the limit off and confirmation unticked, data streams unconfirmed', async () => {
  const device = fakeDevice();
  bluetooth.getDevices = async () => [device];
  const p = newPrinter();
  p.options = { ...p.options, reliable: false, maxKBps: 0 };
  await p.restore({ id: 'dev-1' });
  const t0 = performance.now();
  await p.send(new Uint8Array(8 * 1024));
  assert.deepEqual([...device.modes], ['unconfirmed']);
  assert.ok(performance.now() - t0 < 150, 'no pacing when the limit is 0');
});
