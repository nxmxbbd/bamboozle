import { join } from 'node:path';
import type { Config } from './config.ts';
import { PrinterCamera } from './camera/camera.ts';
import { resolveFonts } from './camera/fonts.ts';
import type { OverlayFonts } from './camera/overlay.ts';
import { startBridge } from './homekit/bridge.ts';
import { toDisplay } from './homekit/display.ts';
import { pairingLines } from './homekit/pairing.ts';
import { PrinterAccessories } from './homekit/printer-accessory.ts';
import { PrinterClient } from './printer/client.ts';
import { filePinStore } from './printer/pinned-tls.ts';
import { SimulatedPrinter, type StatusSource } from './sim.ts';

export interface ServeOptions {
  /** Replace every printer with a simulated print cycle (for trying displays). */
  simulate: boolean;
  log?: Pick<Console, 'log' | 'warn'>;
  /** The log goes to a terminal: draw the pairing QR code with ANSI colours. */
  tty?: boolean;
}

// Clock-dependent overlay text (ETA weekday, finish time) is refreshed this
// often even when the printer reports nothing new.
const OVERLAY_TICK_MS = 30_000;

export async function serve(config: Config, options: ServeOptions): Promise<() => Promise<void>> {
  const log = options.log ?? console;
  // Pairing keys, pins and overlay files are written below storage/: keep them private.
  process.umask(0o077);

  let fonts: OverlayFonts | null = null;
  const cameraFonts = () => (fonts ??= resolveFonts(config.camera.fonts, (message) => log.warn(message)));

  const printers = config.printers.map((printer) => {
    const accessories = new PrinterAccessories({
      name: printer.name,
      serial: printer.serial,
      ...(printer.model ? { model: printer.model } : {}),
      progress: config.display.progress,
      countdown: config.display.countdown,
      temperatures: config.display.temperatures,
      layout: config.display.layout,
    });
    const camera = printer.cameraSource
      ? new PrinterCamera({
          name: printer.name,
          serial: printer.serial,
          ...(printer.model ? { model: printer.model } : {}),
          source: printer.cameraSource,
          overlayDir: join(config.storagePath, 'overlay', printer.serial),
          fonts: cameraFonts(),
          ffmpeg: { path: config.camera.ffmpeg, encoder: config.camera.encoder, vaapiDevice: config.camera.vaapiDevice },
          log,
        })
      : null;
    const source: StatusSource = options.simulate
      ? new SimulatedPrinter()
      : new PrinterClient(printer, filePinStore(config.storagePath, printer.serial));
    return { printer, accessories, camera, source };
  });

  const bridge = await startBridge(
    { name: config.bridge.name, port: config.bridge.port, storagePath: config.storagePath, log, ...(config.bridge.bind ? { bind: config.bridge.bind } : {}) },
    printers.flatMap(({ accessories, camera }) => [...accessories.accessories, ...(camera ? [camera.accessory] : [])]),
  );

  const timers: NodeJS.Timeout[] = [];
  for (const { printer, accessories, camera, source } of printers) {
    let finishedAt: Date | null = null;
    let lastState: string | null = null;
    const refresh = () => {
      const available = source.online && source.hasFullStatus;
      accessories.update(toDisplay(source.status, available));
      if (!camera) return;
      const state = source.status?.state ?? null;
      // Only a finish bamboozle watched happen has a known time.
      if (state === 'finished' && lastState !== null && lastState !== 'finished') finishedAt = new Date();
      if (state !== 'finished') finishedAt = null;
      if (state !== null) lastState = state;
      camera.update({
        status: source.status,
        available,
        name: printer.name,
        now: new Date(),
        finishedAt,
        ...(config.camera.timeZone ? { timeZone: config.camera.timeZone } : {}),
      });
    };
    source.on('status', refresh);
    source.on('online', (online) => {
      log.log(`[${printer.name}] ${online ? 'connected' : 'disconnected'}`);
      refresh();
    });
    source.on('error', (error) => log.warn(`[${printer.name}] ${error.message}`));
    if (source instanceof PrinterClient) {
      source.on('pinned', (fingerprint) => log.log(`[${printer.name}] pinned certificate ${fingerprint}`));
    }
    if (camera) timers.push(setInterval(refresh, OVERLAY_TICK_MS));
    refresh();
    source.start();
  }

  const where = config.bridge.bind ? config.bridge.bind.join(', ') : 'all interfaces';
  const cameras = printers.filter(({ camera }) => camera).length;
  log.log(
    `bridge "${config.bridge.name}" on port ${config.bridge.port} (${where}), ${cameras} camera(s)${options.simulate ? ', SIMULATED printers' : ''}`,
  );
  const announce = (paired: boolean) => {
    if (paired) log.log('paired with a Home app');
    else for (const line of pairingLines(config.bridge.name, bridge.identity.pincode, bridge.setupURI, options.tty ?? false)) log.log(line);
  };
  announce(bridge.isPaired());
  bridge.onPairingChange(announce);

  return async () => {
    for (const timer of timers) clearInterval(timer);
    // Stop taking HomeKit requests first, then drain cameras and printers.
    await bridge.stop();
    await Promise.all(printers.map(({ camera }) => camera?.stop()));
    await Promise.all(printers.map(({ source }) => source.stop()));
  };
}
