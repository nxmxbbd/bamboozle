// Preload (node --import): every write below $BAMBOOZLE_FULL_DISK fails the way
// it does on a full disk: the file is emptied, then the write fails with ENOSPC.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const root = process.env['BAMBOOZLE_FULL_DISK'];
if (!root) throw new Error('BAMBOOZLE_FULL_DISK is not set');
const write = fs.writeFileSync;
fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
  if (typeof file === 'string' && file.startsWith(root)) {
    write(file, '');
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  }
  return write(file, data, options);
}) as typeof fs.writeFileSync;
syncBuiltinESMExports();
