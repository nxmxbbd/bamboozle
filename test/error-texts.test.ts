import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CUSTOM_FILE,
  ErrorTexts,
  bambuFileName,
  codeKey,
  drawableText,
  modelPrefix,
  parseBambuAnswer,
  saveBambuTable,
  updateErrorTexts,
} from '../src/error-texts.ts';

// Every code and text here is invented: Bambu's own texts stay with Bambu.
function answer(hms: Array<[string, string]>, errors: Array<[string, string]>, result = 0): unknown {
  return {
    result,
    ver: 1,
    data: {
      device_hms: { ver: '1', en: hms.map(([ecode, intro]) => ({ ecode, intro })) },
      device_error: { ver: '1', en: errors.map(([ecode, intro]) => ({ ecode, intro })) },
    },
  };
}

// CJK marks by code point: the repo keeps CJK characters out of its source.
const cp = (...points: number[]) => String.fromCodePoint(...points);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bamboozle-texts-'));
}

test('codes are read the ways people and Bambu write them', () => {
  assert.deepEqual(codeKey('0c00_0300_0002_abcd'), { kind: 'hms', key: '0C0003000002ABCD' });
  assert.deepEqual(codeKey('0C00-1234'), { kind: 'error', key: '0C001234' });
  assert.deepEqual(codeKey('0C001234'), { kind: 'error', key: '0C001234' });
  for (const bad of ['', '0C00', 'XYZ01234', '0C00_0300_0002', '0C00_0300_0002_ABCD_0000']) assert.equal(codeKey(bad), null, bad);
  assert.equal(modelPrefix('ab1cdef0123'), 'AB1');
});

test('texts keep only what the overlay font can draw', () => {
  assert.equal(drawableText('Check the “nozzle” – it’s hot (250°)…'), 'Check the "nozzle" - it\'s hot (250°)...');
  assert.equal(drawableText(`Line one.\nLine   two${cp(0x3002)}Then${cp(0xff0c)}more`), 'Line one. Line two. Then, more');
  assert.equal(drawableText(`Keep it \u2265 45\u2103 \u00b1 2, \u00d72 for D\u00fcse ${cp(0xff21, 0xff11)} \u2192 on`), 'Keep it >= 45\u00b0C +/- 2, x2 for Duse A1 -> on');
  // Another script than Latin: nothing the font can draw.
  assert.equal(drawableText('\u0391\u03ba\u03c1\u03bf\u03c6\u03cd\u03c3\u03b9\u03bf'), '');
  assert.equal(drawableText(cp(0x3002)), '');
  assert.equal(drawableText(`Clean it${cp(0xff61)}Gap 50 ${cp(0xb5)}m, A${cp(0xff64)}B${cp(0xfe51)}C, 5 \u03bcm`), 'Clean it. Gap 50 um, A, B, C, 5 um');
  assert.equal(drawableText('Nozzle \u0391\u03ba\u03c1\u03bf clogged'), 'Nozzle clogged');
  // A Greek word with a mu in it is still Greek; only a mu after a number is the micro prefix.
  assert.equal(drawableText('\u0398\u03b5\u03c1\u03bc\u03bf'), '');
  assert.equal(drawableText('Nozzle \u0398\u03b5\u03c1\u03bc\u03bf clogged'), 'Nozzle clogged');
});

test("Bambu's answer: texts kept, empty texts and odd entries skipped, failures refused", () => {
  const table = parseBambuAnswer(
    answer(
      [['0C0003000002ABCD', 'The camera saw something odd.'], ['0C0001000002EEEE', ''], ['nope', 'x'], ['0C001234', 'wrong list']],
      [['0C001234', 'The nozzle may be clogged.'], ['0C005678', '  ']],
    ),
  );
  assert.deepEqual(table.hms, { '0C0003000002ABCD': 'The camera saw something odd.' });
  assert.deepEqual(table.errors, { '0C001234': 'The nozzle may be clogged.' });
  assert.equal(table.version, '1');
  assert.throws(() => parseBambuAnswer({ result: 201, t: 0, ver: 0, msg: '' }), /result 201/);
  assert.throws(() => parseBambuAnswer(answer([], [])), /no texts/);
  assert.throws(() => parseBambuAnswer([]), /not a JSON object/);
  assert.throws(() => parseBambuAnswer({ result: 0, data: {} }), /no texts/);
  // A model with print errors only is still a table.
  const errorsOnly = { result: 0, data: { device_error: { ver: '2', en: [{ ecode: '0C001234', intro: 'Clogged.' }] } } };
  assert.deepEqual(parseBambuAnswer(errorsOnly), { version: '2', hms: {}, errors: { '0C001234': 'Clogged.' } });
});

test('lookup: custom texts first, then Bambu, an empty custom text hides Bambu', () => {
  const dir = tempDir();
  try {
    saveBambuTable(dir, 'AB1', { version: '1', hms: { '0C0003000002ABCD': 'Bambu says: odd plate.' }, errors: { '0C001234': 'Bambu says: clogged.' } }, 'test');
    writeFileSync(join(dir, CUSTOM_FILE), JSON.stringify({
      '0c00_0100_0002_eeee': 'A code Bambu keeps to itself.',
      '0C00_1234': 'My own words for a clog.',
      '0C00_0300_0002_ABCD': '',
    }));
    const texts = new ErrorTexts(dir, 'AB1');
    assert.equal(texts.hasBambuTable(), true);
    assert.equal(texts.explain('hms', '0C0001000002EEEE'), 'A code Bambu keeps to itself.');
    assert.equal(texts.explain('error', '0C001234'), 'My own words for a clog.');
    assert.equal(texts.explain('hms', '0C0003000002ABCD'), undefined);
    assert.equal(texts.explain('hms', '0C000300000200FF'), undefined);
    // Another model's printer does not get this model's table, only custom texts.
    const other = new ErrorTexts(dir, 'ZZ9');
    assert.equal(other.hasBambuTable(), false);
    assert.equal(other.explain('error', '0C001234'), 'My own words for a clog.');
    assert.equal(other.explain('hms', '0C0003000002ABCD'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookup: no files means no texts, and nothing is created', () => {
  const parent = tempDir();
  const dir = join(parent, 'missing');
  try {
    const texts = new ErrorTexts(dir, 'AB1');
    assert.equal(texts.hasBambuTable(), false);
    assert.equal(texts.explain('error', '0C001234'), undefined);
    assert.throws(() => statSync(dir));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('lookup: a changed file is picked up after the recheck interval, a broken one is reported once', () => {
  const dir = tempDir();
  let now = 0;
  const warnings: string[] = [];
  try {
    const texts = new ErrorTexts(dir, 'AB1', { recheckMs: 60_000, clock: () => now, warn: (m) => warnings.push(m) });
    assert.equal(texts.explain('error', '0C001234'), undefined);

    saveBambuTable(dir, 'AB1', { version: '1', hms: {}, errors: { '0C001234': 'First text.' } }, 'test');
    now = 59_999;
    assert.equal(texts.explain('error', '0C001234'), undefined, 'not checked again before the interval');
    now = 60_000;
    assert.equal(texts.explain('error', '0C001234'), 'First text.');

    writeFileSync(join(dir, CUSTOM_FILE), '{ not json');
    now = 120_000;
    assert.equal(texts.explain('error', '0C001234'), 'First text.', 'a broken custom file does not hide Bambu texts');
    now = 180_000;
    texts.explain('error', '0C001234');
    assert.equal(warnings.filter((w) => w.includes(CUSTOM_FILE)).length, 1, 'reported once until it changes');
    assert.match(warnings[0]!, /cannot be used/);

    writeFileSync(join(dir, CUSTOM_FILE), JSON.stringify({ '0C001234': 'Fixed text.', 'not-a-code': 'x', '0C005678': '\u0391\u03ba\u03c1\u03bf' }));
    now = 240_000;
    assert.equal(texts.explain('error', '0C001234'), 'Fixed text.');
    assert.equal(texts.explain('error', '0C005678'), undefined, 'a text the font cannot draw is ignored, not shown empty');
    assert.match(warnings.at(-1)!, /ignored 2 entries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    handler!(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${address.port}/query.php`, seen };
}

test('error-texts command: one download per model, saved privately; a failing model keeps its old table', async () => {
  const dir = tempDir();
  const { server, base, seen } = await listen((req, res) => {
    const model = new URL(req.url ?? '', 'http://x').searchParams.get('d');
    res.setHeader('content-type', 'application/json');
    if (model === 'AB1') res.end(JSON.stringify(answer([['0C0003000002ABCD', 'Odd plate.']], [['0C001234', 'Clogged.']])));
    else res.end(JSON.stringify({ result: 201, t: 0, ver: 0, msg: '' }));
  });
  try {
    saveBambuTable(join(dir, 'error-texts'), 'ZZ9', { version: 'old', hms: {}, errors: { '0C001234': 'Old text.' } }, 'test');
    const lines: string[] = [];
    const errors: string[] = [];
    const ok = await updateErrorTexts(
      [{ name: 'Left', serial: 'AB1000000001' }, { name: 'Right', serial: 'AB1000000002' }, { name: 'Other', serial: 'ZZ9000000003' }],
      dir,
      { base, log: { log: (m: string) => lines.push(m), error: (m: string) => errors.push(m) } },
    );
    assert.equal(ok, false);
    assert.deepEqual(seen.map((url) => new URL(url, 'http://x').searchParams.get('d')), ['AB1', 'ZZ9']);
    assert.ok(seen.every((url) => new URL(url, 'http://x').searchParams.get('lang') === 'en'));
    assert.match(lines[0]!, /^Left, Right \(model AB1\): 1 HMS texts and 1 print error texts/);
    assert.match(errors[0]!, /^Other \(model ZZ9\): no texts downloaded: .*result 201/);

    const path = join(dir, 'error-texts', bambuFileName('AB1'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(saved['errors'], { '0C001234': 'Clogged.' });
    const texts = new ErrorTexts(join(dir, 'error-texts'), 'AB1');
    assert.equal(texts.explain('hms', '0C0003000002ABCD'), 'Odd plate.');
    assert.equal(new ErrorTexts(join(dir, 'error-texts'), 'ZZ9').explain('error', '0C001234'), 'Old text.');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('error-texts command: HTTP errors and non-JSON answers fail without writing', async () => {
  const dir = tempDir();
  let status = 503;
  const { server, base } = await listen((_req, res) => {
    res.statusCode = status;
    res.end('<html>busy</html>');
  });
  try {
    const errors: string[] = [];
    const log = { log: () => {}, error: (m: string) => errors.push(m) };
    assert.equal(await updateErrorTexts([{ name: 'P', serial: 'AB1000000001' }], dir, { base, log }), false);
    assert.match(errors[0]!, /HTTP 503/);
    status = 200;
    assert.equal(await updateErrorTexts([{ name: 'P', serial: 'AB1000000001' }], dir, { base, log }), false);
    assert.match(errors[1]!, /did not answer with JSON/);
    // Nothing listening: the reason is in the message, not just "fetch failed".
    const closed = await listen(() => {});
    await new Promise((resolve) => closed.server.close(resolve));
    assert.equal(await updateErrorTexts([{ name: 'P', serial: 'AB1000000001' }], dir, { base: closed.base, log }), false);
    assert.match(errors[2]!, /ECONNREFUSED/);
    assert.throws(() => statSync(join(dir, 'error-texts', bambuFileName('AB1'))));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookup: a file that cannot be read is tried again, and reported once', () => {
  const dir = tempDir();
  let now = 0;
  let readable = false;
  let reads = 0;
  const warnings: string[] = [];
  try {
    saveBambuTable(dir, 'AB1', { version: '1', hms: {}, errors: { '0C001234': 'Readable at last.' } }, 'test');
    const texts = new ErrorTexts(dir, 'AB1', {
      recheckMs: 1000,
      clock: () => now,
      warn: (m) => warnings.push(m),
      readFile: (path) => {
        if (path.endsWith(bambuFileName('AB1'))) {
          reads++;
          if (!readable) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return readFileSync(path, 'utf8');
      },
    });
    assert.equal(texts.explain('error', '0C001234'), undefined);
    now = 1000;
    assert.equal(texts.explain('error', '0C001234'), undefined);
    assert.equal(reads, 2, 'tried again at the next check, though the file did not change');
    assert.equal(warnings.length, 1, 'the same failure is reported once');
    readable = true; // e.g. its owner was fixed: mtime and size stay the same
    now = 2000;
    assert.equal(texts.explain('error', '0C001234'), 'Readable at last.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('error-texts command: an answer over the byte limit is refused, counted in bytes', async () => {
  const dir = tempDir();
  // 400 three-byte characters: 400 characters, 1200 bytes.
  const body = JSON.stringify(answer([], [['0C001234', '–'.repeat(400)]]));
  const { server, base } = await listen((_req, res) => res.end(body));
  try {
    const errors: string[] = [];
    const ok = await updateErrorTexts([{ name: 'P', serial: 'AB1000000001' }], dir, {
      base,
      maxBytes: 1000,
      log: { log: () => {}, error: (m: string) => errors.push(m) },
    });
    assert.equal(ok, false);
    assert.match(errors[0] ?? '', /more than 1000 bytes/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lookup: a folder or file that cannot even be looked at is reported, not taken as missing', () => {
  const dir = tempDir();
  let now = 0;
  let blocked = true;
  const warnings: string[] = [];
  try {
    saveBambuTable(dir, 'AB1', { version: '1', hms: {}, errors: { '0C001234': 'Visible again.' } }, 'test');
    const texts = new ErrorTexts(dir, 'AB1', {
      recheckMs: 1000,
      clock: () => now,
      warn: (m) => warnings.push(m),
      stat: (path) => {
        // e.g. error-texts/ made by root with mode 0700, the bridge running as another user
        if (blocked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return statSync(path);
      },
    });
    assert.equal(texts.hasBambuTable(), true, 'there is a table, it just cannot be read: no "download it" hint');
    assert.equal(warnings.length, 1, 'reported at start, not at the first alert');
    assert.equal(texts.explain('error', '0C001234'), undefined);
    now = 1000;
    texts.explain('error', '0C001234');
    assert.equal(warnings.filter((w) => w.includes(bambuFileName('AB1'))).length, 1, 'reported once');
    blocked = false;
    now = 2000;
    assert.equal(texts.explain('error', '0C001234'), 'Visible again.');
    // Blocked, gone, blocked again: the second time is reported too.
    let gone = false;
    const again = new ErrorTexts(dir, 'AB1', {
      recheckMs: 1000,
      clock: () => now,
      warn: (m) => warnings.push(m),
      stat: (path) => {
        if (gone) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    });
    const tableWarnings = () => warnings.filter((w) => w.includes(bambuFileName('AB1'))).length;
    const before = tableWarnings();
    again.explain('error', '0C001234');
    gone = true;
    now = 3000;
    again.explain('error', '0C001234');
    gone = false;
    now = 4000;
    again.explain('error', '0C001234');
    assert.equal(tableWarnings() - before, 2);
    const missing = new ErrorTexts(join(dir, 'nothing-here'), 'AB1', { stat: (path) => statSync(path) });
    assert.equal(missing.hasBambuTable(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
