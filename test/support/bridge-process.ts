// Runs one bridge until SIGTERM, for tests that need a restart:
//   node test/support/bridge-process.ts <storagePath> <port>
// Prints one JSON line once published: { username, pincode, paired }.
import { startBridge } from '../../src/homekit/bridge.ts';

const [storagePath, port] = process.argv.slice(2);
const bridge = await startBridge({ name: 'bamboozle test', port: Number(port), bind: ['127.0.0.1'], storagePath: storagePath as string }, []);
process.stdout.write(`${JSON.stringify({ username: bridge.identity.username, pincode: bridge.identity.pincode, paired: bridge.isPaired() })}\n`);
process.once('SIGTERM', () => {
  void bridge.stop().then(() => process.exit(0));
});
