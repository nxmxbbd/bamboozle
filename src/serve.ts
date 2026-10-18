import type { Config } from './config.ts';
import { startBridge } from './homekit/bridge.ts';
import { toDisplay } from './homekit/display.ts';
import { PrinterAccessories } from './homekit/printer-accessory.ts';
import { PrinterClient } from './printer/client.ts';
import { filePinStore } from './printer/pinned-tls.ts';
import { SimulatedPrinter, type StatusSource } from './sim.ts';

export interface ServeOptions {
  /** Replace every printer with a simulated print cycle (for trying displays). */
  simulate: boolean;
  log?: Pick<Console, 'log' | 'warn'>;
}

export async function serve(config: Config, options: ServeOptions): Promise<() => Promise<void>> {
  const log = options.log ?? console;
  // Pairing keys and pins are written below storage/: keep them private.
  process.umask(0o077);

  const printers = config.printers.map((printer) => {
    const accessories = new PrinterAccessories({
      name: printer.name,
      serial: printer.serial,
      ...(printer.model ? { model: printer.model } : {}),
      progress: config.display.progress,
      temperatures: config.display.temperatures,
      layout: config.display.layout,
    });
    const source: StatusSource = options.simulate
      ? new SimulatedPrinter()
      : new PrinterClient(printer, filePinStore(config.storagePath, printer.serial));
    return { printer, accessories, source };
  });

  const bridge = await startBridge(
    { name: config.bridge.name, port: config.bridge.port, storagePath: config.storagePath, ...(config.bridge.bind ? { bind: config.bridge.bind } : {}) },
    printers.flatMap(({ accessories }) => accessories.accessories),
  );

  for (const { printer, accessories, source } of printers) {
    const refresh = () => accessories.update(toDisplay(source.status, source.online && source.hasFullStatus));
    source.on('status', refresh);
    source.on('online', (online) => {
      log.log(`[${printer.name}] ${online ? 'connected' : 'disconnected'}`);
      refresh();
    });
    source.on('error', (error) => log.warn(`[${printer.name}] ${error.message}`));
    if (source instanceof PrinterClient) {
      source.on('pinned', (fingerprint) => log.log(`[${printer.name}] pinned certificate ${fingerprint}`));
    }
    source.start();
  }

  const where = config.bridge.bind ? config.bridge.bind.join(', ') : 'all interfaces';
  log.log(`bridge "${config.bridge.name}" on port ${config.bridge.port} (${where})${options.simulate ? ', SIMULATED printers' : ''}`);
  const announce = (paired: boolean) => {
    if (paired) log.log('paired with a Home app');
    else {
      log.log(`not paired: in the Home app choose Add Accessory, then More options, then "${config.bridge.name}", and enter ${bridge.identity.pincode}`);
      log.log(`setup URI (encode as a QR code to scan instead): ${bridge.setupURI}`);
    }
  };
  announce(bridge.isPaired());
  bridge.onPairingChange(announce);

  return async () => {
    await Promise.all(printers.map(({ source }) => source.stop()));
    await bridge.stop();
  };
}
