import { renderANSI, renderUnicodeCompact } from 'uqr';

/**
 * The setup URI as a QR code for a terminal. On a terminal the code is drawn
 * with explicit black and white backgrounds, so it scans on light and dark
 * themes alike; into a log (journald, docker logs) it is written with plain
 * block characters instead, which read correctly on a dark background.
 */
export function pairingQr(setupURI: string, tty: boolean): string {
  return tty ? renderANSI(setupURI, { border: 2 }) : renderUnicodeCompact(setupURI, { border: 2 });
}

/** What serve prints while the bridge is not paired. */
export function pairingLines(bridgeName: string, pincode: string, setupURI: string, tty: boolean): string[] {
  return [
    `not paired: scan this code with the iPhone camera, or in the Home app choose Add Accessory, then More options, then "${bridgeName}", and enter ${pincode}`,
    pairingQr(setupURI, tty),
    `setup URI: ${setupURI}`,
  ];
}
