import type { PrinterCamera } from '../../src/camera/camera.ts';

/** A snapshot asked of the camera the way the Home app asks; the size is passed on unchecked. */
export function snapshot(cam: PrinterCamera, width: unknown, height: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    cam.handleSnapshotRequest({ width, height } as never, (error, buffer) => (error || !buffer ? reject(error ?? new Error('no image')) : resolve(buffer))),
  );
}
