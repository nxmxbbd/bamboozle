// A storage folder left by bamboozle 0.1.0 (HAP-NodeJS 0.14.3), paired and
// with the camera turned off, must come up under this version as the same
// bridge: the controller's long-term keys still log in, every accessory,
// service and characteristic keeps its id (the Home app hangs rooms and
// automations on them), and the camera is still off.
// test/fixtures/storage-0.1.0 was written by 0.1.0, with test keys; its
// pairing/ is the storage folder (named so because storage/ is ignored, to
// keep real pairing keys out of the repository).
// Own file: HAP-NodeJS keeps one storage location per process.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpClient } from 'hap-controller';
import type { PairingData } from 'hap-controller';
import { startBridge, type RunningBridge } from '../src/homekit/bridge.ts';
import { PrinterCamera } from '../src/camera/camera.ts';
import { toDisplay } from '../src/homekit/display.ts';
import { PrinterAccessories } from '../src/homekit/printer-accessory.ts';
import { parseStatus } from '../src/printer/status.ts';
import type { JsonObject } from '../src/printer/merge.ts';

const fixture = fileURLToPath(new URL('./fixtures/storage-0.1.0/', import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bamboozle-upgrade-')));
let bridge: RunningBridge | undefined;
let camera: PrinterCamera | undefined;
let client: HttpClient | undefined;
after(async () => {
  await client?.close();
  await camera?.stop();
  await bridge?.stop();
  rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const HAP_BASE = '-0000-1000-8000-0026BB765291';
const fullType = (type: string) => (/^[0-9A-F]{1,8}$/i.test(type) ? `${type.toUpperCase().padStart(8, '0')}${HAP_BASE}` : type.toUpperCase());

interface Ids {
  aid: number;
  services: Array<{ iid: number; type: string; characteristics: Array<{ iid: number; type: string }> }>;
}

test('a paired 0.1.0 storage folder comes up as the same bridge, with its ids and camera setting', async () => {
  const storage = join(dir, 'storage');
  cpSync(join(fixture, 'pairing'), storage, { recursive: true });
  const keys = JSON.parse(readFileSync(join(fixture, 'controller.json'), 'utf8')) as PairingData;
  const expected = JSON.parse(readFileSync(join(fixture, 'accessories.json'), 'utf8')) as { camera: { aid: number; active: number }; accessories: Ids[] };

  // The accessories 0.1.0 had: the same options as when the folder was written.
  const status = parseStatus(JSON.parse(readFileSync(new URL('./fixtures/h2c-printing.json', import.meta.url), 'utf8')) as JsonObject);
  const printer = new PrinterAccessories({
    name: 'H2C',
    serial: 'SERIAL1',
    model: 'H2C',
    progress: ['humidity', 'window', 'fan', 'lightbulb'],
    countdown: ['lux'],
    temperatures: ['chamber', 'nozzle', 'bed'],
    layout: 'grouped',
  });
  printer.update(toDisplay(status, true));
  camera = new PrinterCamera({
    name: 'H2C',
    serial: 'SERIAL1',
    source: 'lavfi:testsrc2=size=1680x1080:rate=15',
    overlayDir: join(dir, 'overlay'),
    fonts: { bold: '/fonts/b.otf', medium: '/fonts/m.otf' },
    ffmpeg: { path: 'ffmpeg', encoder: 'libx264', vaapiDevice: '/dev/dri/renderD128' },
  });
  const port = await freePort();
  bridge = await startBridge({ name: 'bamboozle test', port, bind: ['127.0.0.1'], storagePath: storage }, [...printer.accessories, camera.accessory]);
  assert.equal(bridge.isPaired(), true);

  client = new HttpClient(bridge.identity.username, '127.0.0.1', port, keys);
  const db = ((await client.getAccessories()) as unknown as { accessories: Ids[] }).accessories;
  const ids = db.map((a) => ({
    aid: a.aid,
    services: a.services.map((s) => ({ iid: s.iid, type: fullType(s.type), characteristics: s.characteristics.map((c) => ({ iid: c.iid, type: fullType(c.type) })) })),
  }));
  assert.deepEqual(ids, expected.accessories);

  const read = (await client.getCharacteristics([`${expected.camera.aid}.${expected.camera.active}`])) as { characteristics: Array<{ value: unknown }> };
  assert.equal(read.characteristics[0]?.value, 0, 'the camera turned off in 0.1.0 is still off');
});
