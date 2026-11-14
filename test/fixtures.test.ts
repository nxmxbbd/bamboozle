import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLeaks, sanitize } from '../scripts/sanitize-report.ts';

const dir = new URL('./fixtures/', import.meta.url);
const script = fileURLToPath(new URL('../scripts/sanitize-report.ts', import.meta.url));

test('committed fixtures contain no serials or real addresses', () => {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const name of files) {
    assert.deepEqual(findLeaks(readFileSync(new URL(name, dir), 'utf8')), [], name);
  }
});

test('sanitize removes identifiers and keeps value types', () => {
  const cleaned = sanitize({
    print: {
      subtask_name: 'my_secret_part',
      task_id: '3570',
      ipcam: { rtsp_url: 'rtsps://10.1.2.3:322/streaming/live/1' },
      net: { info: [{ ip: 1001523722, mask: 16777215 }] },
      upgrade_state: { sn: '01P00A000000000', lower_limit: '01.02.00.00', idx2: 123456789 },
      nozzle: { info: [{ id: 0, sn: '20D00A000000000' }] },
      tray: { tag_uid: '1234567890ABCDEF', tray_uuid: 'ABCDEF' },
      mc_percent: 47,
    },
  });
  const text = JSON.stringify(cleaned);
  assert.deepEqual(findLeaks(text), []);
  assert.ok(!text.includes('my_secret_part'));
  assert.ok(!text.includes('3570'));
  assert.ok(text.includes('"idx2":0'), 'idx2 is zeroed and stays a number');
  assert.ok(text.includes('"lower_limit":"01.02.00.00"'), 'firmware versions are not addresses');
  assert.ok(text.includes('rtsps://192.0.2.10:322/streaming/live/1'));
  assert.ok(text.includes('"ip":0'));
  assert.ok(text.includes('"mc_percent":47'));
});

test('findLeaks flags what sanitize must remove', () => {
  assert.deepEqual(findLeaks('{"sn":"01P00A000000000"}'), ['serial-like 01P00A000000000']);
  assert.deepEqual(findLeaks('rtsps://10.1.2.3:322'), ['ipv4 10.1.2.3']);
  assert.deepEqual(findLeaks('{"fun":"14027FF18FFF9CB7","v":"01.02.00.00"}'), []);
});

test('sanitize removes file names, storage paths and links', () => {
  const cleaned = sanitize({
    print: {
      gcode_file: '/data/Metadata/plate_3.gcode', // the plate inside every project file names nothing
      file: 'my_secret_part.gcode.3mf', // some printers report the job's file name here
      device: { cam: { timelapse_path: '/media/usb0/timelapse/video_2001-02-03_04-05-06.mp4' } },
      err2: { img_id: 'my_secret_picture' },
      upload: { oss_url: 'https://storage.example.com/my_secret_upload?token=abc' },
    },
  });
  assert.deepEqual(cleaned, {
    print: {
      gcode_file: '/data/Metadata/plate_3.gcode',
      file: '',
      device: { cam: { timelapse_path: '' } },
      err2: { img_id: '' },
      upload: { oss_url: '' },
    },
  });

  // The printer's reply to a print command shares the report topic.
  const reply = sanitize({
    print: {
      command: 'project_file',
      param: 'Metadata/plate_2.gcode',
      url: 'file:///media/usb0/cache/my_secret_part.gcode.3mf',
    },
  });
  assert.deepEqual(reply, { print: { command: 'project_file', param: 'Metadata/plate_2.gcode', url: '' } });
  assert.deepEqual(sanitize({ print: { command: 'gcode_file', param: '/sdcard/my_secret_part.gcode' } }), {
    print: { command: 'gcode_file', param: '' },
  });
  assert.deepEqual(sanitize({ print: { gcode_file: '/media/usb0/my_secret_part/Metadata/plate_1.gcode', param: 3 } }), {
    print: { gcode_file: '', param: 3 },
  });
  // also inside a list or an object under such a key
  assert.deepEqual(sanitize({ print: { param: ['my_secret_part', 2, 'Metadata/plate_1.gcode'], file: { name: 'my_secret_part' } } }), {
    print: { param: ['', 2, 'Metadata/plate_1.gcode'], file: { name: '' } },
  });
  // a signed command on the report topic names its certificate
  assert.deepEqual(
    sanitize({ header: { cert_id: '0123abcdCN=my_secret_cert.example', sign_alg: 'RSA_SHA256', sign_string: '/9j/4AAQSkZJRg==' } }),
    { header: { cert_id: 'REDACTED', sign_alg: 'RSA_SHA256', sign_string: '' } },
  );
});

test('findLeaks flags file names, storage paths and links under any key', () => {
  assert.deepEqual(findLeaks('{"new_field":"/media/usb0/cache/part.3mf"}'), ['path /media/usb0/cache/part.3mf']);
  assert.deepEqual(findLeaks('{"new_field":"my part.gcode.3mf"}'), ['file name my part.gcode.3mf']);
  assert.deepEqual(findLeaks('{"new_field":"snapshot.JPG"}'), ['file name snapshot.JPG']);
  assert.deepEqual(findLeaks('{"new_field":"https://storage.example.com/a?b=c"}'), ['link https://storage.example.com/a?b=c']);
  assert.deepEqual(findLeaks('{"new_field":"ftp:///cache/part.3mf"}'), ['link ftp:///cache/part.3mf']);
  assert.deepEqual(findLeaks('{"rtsp_url":"rtsps://user:secret@192.0.2.10:322/streaming/live/1"}'), [
    'link rtsps://user:secret@192.0.2.10:322/streaming/live/1',
  ]);
  // sanitize points every address at the documentation one, so that alone grants nothing
  for (const link of [
    'ftp://192.0.2.10/media/usb0/cache/secret',
    'rtsps://192.0.2.10:322/x.mp4',
    'rtsps://192.0.2.10:322/streaming/live/1?token=abc',
    'rtsps://0.0.0.0:322/streaming/live/1',
    'https://cloud.example/next?rtsps://192.0.2.10:322/streaming/live/1',
  ]) {
    assert.deepEqual(findLeaks(JSON.stringify({ new_field: link })), [`link ${link}`]);
  }
  const fromPrinterAddress = JSON.stringify(sanitize({ new_field: 'ftp://10.1.2.3/media/usb0/cache/secret' }));
  assert.deepEqual(findLeaks(fromPrinterAddress), ['link ftp://192.0.2.10/media/usb0/cache/secret']);
  const withToken = JSON.stringify(sanitize({ download_url: 'https://10.1.2.3/customer/acme?token=secret' }));
  assert.deepEqual(findLeaks(withToken), ['link https://192.0.2.10/customer/acme?token=secret']);
  const hiddenHost = 'https://192.0.2.10\t@cloud.example/customer';
  assert.deepEqual(findLeaks(JSON.stringify({ new_field: hiddenHost })), [`link ${hiddenHost}`]);
  // URL parsers drop tabs and line breaks and take a single slash or a backslash
  for (const link of [
    'https:\t//cloud.example/customer?token=secret',
    'https:/cloud.example/x',
    'https:\\\\cloud.example/x',
    'https:cloud.example/x?token=secret',
    'C:\\Users\\my_secret_folder',
    'Upload failed\nhttps:cloud.example/x?token=secret',
  ]) {
    assert.deepEqual(findLeaks(JSON.stringify({ new_field: link })), [`link ${link}`]);
  }
  for (const message of [
    'Failed to open /media/usb0/my_secret_folder',
    'Failed to open `/media/usb0/my_secret_folder`',
    'open failed </media/usb0/my_secret_folder>',
    '//media/usb0/my_secret_folder',
    'see //nas/share/my_secret_folder',
    'Failed\t/media/usb0/my_secret_folder',
    '\\\\nas\\share\\my_secret_folder',
    'see \\\\nas\\share\\my_secret_folder',
    '/ my_secret_folder',
    'see //my_secret_host',
    'see \\\\my_secret_host',
  ]) {
    assert.deepEqual(findLeaks(JSON.stringify({ message })), [`path ${message}`]);
  }
  assert.deepEqual(findLeaks('{"new_field":"usb0/part/Metadata/plate_1.gcode"}'), ['file name usb0/part/Metadata/plate_1.gcode']);
  assert.deepEqual(
    findLeaks(
      JSON.stringify({
        gcode_file: '/data/Metadata/plate_12.gcode',
        param: 'Metadata/plate_1.gcode',
        rtsp_url: 'rtsps://192.0.2.10:322/streaming/live/1',
        rate: '0KB/s',
        hw_ver: 'N/A',
        module: 'ams/0',
        message: 'RK1126 start write flash success, layer 3 / 10, and/or 50/100, 0B/s, +/-5, at 12:30, x//y',
        text: 'été/hiver, e\u0301te\u0301/hiver, file: not found, a_/b a-/b v1./c a\\/b, on 14/11/2026',
        lower_limit: '01.02.00.00',
      }),
    ),
    [],
  );
});

test('the script writes a clean fixture and refuses one that still leaks', () => {
  const work = mkdtempSync(join(tmpdir(), 'bamboozle-sanitize-'));
  const run = (report: object) => {
    const input = join(work, 'raw.json');
    const output = join(work, 'fixture.json');
    rmSync(output, { force: true });
    writeFileSync(input, JSON.stringify(report));
    const result = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr, written: existsSync(output) ? readFileSync(output, 'utf8') : null };
  };
  try {
    const clean = run({ print: { device: { cam: { timelapse_path: '/media/usb0/timelapse/video.mp4' } } } });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.written, `${JSON.stringify({ print: { device: { cam: { timelapse_path: '' } } } }, null, 2)}\n`);

    const leaking = run({ print: { new_field: '/media/usb0/cache/my_secret_part' } });
    assert.equal(leaking.status, 1);
    assert.equal(leaking.written, null, 'nothing is written');
    assert.match(leaking.stderr, /path \/media\/usb0\/cache\/my_secret_part/);

    const hiddenLink = run({ print: { new_field: 'https:\t//cloud.example/my_secret_upload?token=abc' } });
    assert.equal(hiddenLink.status, 1);
    assert.equal(hiddenLink.written, null, 'nothing is written');
    assert.match(hiddenLink.stderr, /link https:/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
