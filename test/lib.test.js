'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const lib = require('../src/lib');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noverify-vscode-test-'));
}

function touch(file, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x', { mode: mode || 0o644 });
}

test('byteOffsetToUtf16: ASCII is not changed', () => {
  assert.equal(lib.byteOffsetToUtf16('echo foo();', 5), 5);
  assert.equal(lib.byteOffsetToUtf16('echo foo();', 0), 0);
  assert.equal(lib.byteOffsetToUtf16('echo foo();', -3), 0);
  assert.equal(lib.byteOffsetToUtf16('echo foo();', undefined), 0);
});

test('byteOffsetToUtf16: multi-byte characters', () => {
  // The real report of noverify: the offset of undefined_fn is 26 bytes (20 characters).
  const line = '$s = "привет"; echo undefined_fn(1), $s;';
  assert.equal(lib.byteOffsetToUtf16(line, 26), 20);
  assert.equal(line.slice(20, lib.byteOffsetToUtf16(line, 38)), 'undefined_fn');

  // 2 bytes (Cyrillic), 3 bytes (euro), 4 bytes (emoji, two UTF-16 code units).
  assert.equal(lib.byteOffsetToUtf16('ж', 2), 1);
  assert.equal(lib.byteOffsetToUtf16('€', 3), 1);
  assert.equal(lib.byteOffsetToUtf16('😀x', 4), 2);
  assert.equal(lib.byteOffsetToUtf16('😀x', 5), 3);
});

test('byteOffsetToUtf16: inside of a character and after the end', () => {
  assert.equal(lib.byteOffsetToUtf16('жж', 1), 0); // rounded down
  assert.equal(lib.byteOffsetToUtf16('жж', 3), 1);
  assert.equal(lib.byteOffsetToUtf16('abc', 100), 3);
  assert.equal(lib.byteOffsetToUtf16('', 5), 0);
});

test('severityOf', () => {
  assert.equal(lib.severityOf(lib.LEVEL_ERROR), 'error');
  assert.equal(lib.severityOf(lib.LEVEL_WARNING), 'warning');
  assert.equal(lib.severityOf(lib.LEVEL_SECURITY), 'warning');
  assert.equal(lib.severityOf(lib.LEVEL_NOTICE), 'info');
  assert.equal(lib.severityOf(undefined), 'info');
});

function report(extra) {
  return Object.assign(
    {
      check_name: 'undefinedFunction',
      level: 1,
      context: '    echo undefined_here();',
      message: 'Call to undefined function undefined_here',
      filename: '/m/lib/a.php',
      line: 4,
      start_char: 9,
      end_char: 23,
      hash: 0,
    },
    extra
  );
}

test('parseReports: a report becomes a problem', () => {
  const { byFile, total, counts } = lib.parseReports(JSON.stringify({ Reports: [report()], Errors: null }));

  assert.equal(total, 1);
  assert.deepEqual(counts, { error: 1, warning: 0, info: 0 });
  assert.deepEqual(byFile.get('/m/lib/a.php'), [
    {
      line: 3,
      startColumn: 9,
      endColumn: 23,
      severity: 'error',
      code: 'undefinedFunction',
      message: 'Call to undefined function undefined_here',
      tags: [],
    },
  ]);
});

test('parseReports: the offsets are bytes, the CRLF files and the tabs', () => {
  const cyrillic = report({ context: '$s = "привет"; echo undefined_fn(1), $s;', start_char: 26, end_char: 38, line: 2 });
  const crlf = report({ context: 'echo undefined_crlf();\r', start_char: 5, end_char: 19, line: 3, filename: '/m/lib/b.php' });
  const tabs = report({ context: '\t\t$x = 1;', start_char: 2, end_char: 4, line: 3, filename: '/m/lib/c.php', check_name: 'unused', level: 2 });

  const { byFile } = lib.parseReports(JSON.stringify({ Reports: [cyrillic, crlf, tabs] }));

  const p1 = byFile.get('/m/lib/a.php')[0];
  assert.deepEqual([p1.startColumn, p1.endColumn], [20, 32]);
  assert.equal(cyrillic.context.slice(p1.startColumn, p1.endColumn), 'undefined_fn');

  const p2 = byFile.get('/m/lib/b.php')[0];
  assert.equal(crlf.context.slice(p2.startColumn, p2.endColumn), 'undefined_crlf');

  const p3 = byFile.get('/m/lib/c.php')[0];
  assert.equal(tabs.context.slice(p3.startColumn, p3.endColumn), '$x');
});

test('parseReports: the ranges are never empty and stay in the line', () => {
  const { byFile } = lib.parseReports(
    JSON.stringify({
      Reports: [
        report({ start_char: 5, end_char: 5, filename: '/m/1.php' }), // collapsed
        report({ start_char: 5, end_char: 500, filename: '/m/2.php' }), // after the end of the line
        report({ start_char: 500, end_char: 600, filename: '/m/3.php' }), // all after the end
        report({ context: '', start_char: 0, end_char: 0, filename: '/m/4.php' }), // empty line
      ],
    })
  );

  const text = '    echo undefined_here();';
  const p1 = byFile.get('/m/1.php')[0];
  assert.deepEqual([p1.startColumn, p1.endColumn], [5, 6]);
  const p2 = byFile.get('/m/2.php')[0];
  assert.deepEqual([p2.startColumn, p2.endColumn], [5, text.length]);
  const p3 = byFile.get('/m/3.php')[0];
  assert.deepEqual([p3.startColumn, p3.endColumn], [text.length - 1, text.length]);
  const p4 = byFile.get('/m/4.php')[0];
  assert.deepEqual([p4.startColumn, p4.endColumn], [0, 0]);
});

test('parseReports: tags, severities and counts', () => {
  const { byFile, counts, total } = lib.parseReports(
    JSON.stringify({
      Reports: [
        report({ check_name: 'unused', level: 2, message: 'unused var', line: 1 }),
        report({ check_name: 'deprecated', level: 3, message: 'old', line: 2 }),
        report({ check_name: 'security', level: 4, message: 'sec', line: 3 }),
        report({ check_name: 'undefinedFunction', level: 1, message: 'fn', line: 4 }),
      ],
    })
  );

  const problems = byFile.get('/m/lib/a.php');
  assert.deepEqual(problems.map((p) => [p.code, p.severity, p.tags]), [
    ['unused', 'warning', ['unnecessary']],
    ['deprecated', 'info', ['deprecated']],
    ['security', 'warning', []],
    ['undefinedFunction', 'error', []],
  ]);
  assert.deepEqual(counts, { error: 1, warning: 2, info: 1 });
  assert.equal(total, 4);
});

test('parseReports: the minimum level', () => {
  const json = JSON.stringify({
    Reports: [
      report({ level: 1, message: 'e', line: 1 }),
      report({ level: 2, message: 'w', line: 2 }),
      report({ level: 3, message: 'n', line: 3 }),
    ],
  });

  const messages = (minLevel) => lib.parseReports(json, { minLevel }).byFile.get('/m/lib/a.php').map((p) => p.message);
  assert.deepEqual(messages('notice'), ['e', 'w', 'n']);
  assert.deepEqual(messages(undefined), ['e', 'w', 'n']);
  assert.deepEqual(messages('warning'), ['e', 'w']);
  assert.deepEqual(messages('error'), ['e']);
});

test('parseReports: duplicates are removed, the problems are sorted', () => {
  const { byFile, total } = lib.parseReports(
    JSON.stringify({
      Reports: [
        report({ line: 9, message: 'b' }),
        report({ line: 2, message: 'a' }),
        report({ line: 9, message: 'b' }), // the same
        report({ line: 9, message: 'b', start_char: 1, end_char: 3 }), // another place
      ],
    })
  );

  assert.equal(total, 3);
  assert.deepEqual(byFile.get('/m/lib/a.php').map((p) => [p.line, p.startColumn]), [[1, 9], [8, 1], [8, 9]]);
});

test('parseReports: no reports', () => {
  for (const json of ['{"Reports":null,"Errors":null}', '{"Reports":[]}', '{}']) {
    const { byFile, total } = lib.parseReports(json);
    assert.equal(byFile.size, 0);
    assert.equal(total, 0);
  }
  assert.throws(() => lib.parseReports('not json'));
});

test('findConfig: looks up the parents', () => {
  const root = tmpDir();
  touch(path.join(root, 'modules/clouds/dev/phpat/noverify.yaml'));
  touch(path.join(root, 'modules/clouds/lib/deep/dir/file.php'));
  touch(path.join(root, 'modules/main/lib/file.php'));
  const names = ['dev/phpat/noverify.yaml', 'noverify.yaml'];

  assert.equal(
    lib.findConfig(path.join(root, 'modules/clouds/lib/deep/dir'), names),
    path.join(root, 'modules/clouds/dev/phpat/noverify.yaml')
  );
  assert.equal(
    lib.findConfig(path.join(root, 'modules/clouds'), names),
    path.join(root, 'modules/clouds/dev/phpat/noverify.yaml')
  );
  // The other module has no config.
  assert.equal(lib.findConfig(path.join(root, 'modules/main/lib'), names, { stopDir: root }), null);
});

test('findConfig: the order of the names and stopDir', () => {
  const root = tmpDir();
  touch(path.join(root, 'noverify.yaml'));
  touch(path.join(root, 'mod/noverify.yaml'));
  touch(path.join(root, 'mod/dev/phpat/noverify.yaml'));
  fs.mkdirSync(path.join(root, 'mod/lib'), { recursive: true });
  const lib1 = path.join(root, 'mod/lib');

  // In the same directory the first name wins.
  assert.equal(
    lib.findConfig(path.join(root, 'mod'), ['dev/phpat/noverify.yaml', 'noverify.yaml']),
    path.join(root, 'mod/dev/phpat/noverify.yaml')
  );
  assert.equal(
    lib.findConfig(path.join(root, 'mod'), ['noverify.yaml', 'dev/phpat/noverify.yaml']),
    path.join(root, 'mod/noverify.yaml')
  );

  // The closest directory wins over the order.
  assert.equal(lib.findConfig(lib1, ['noverify.yaml']), path.join(root, 'mod/noverify.yaml'));

  // stopDir is the last directory that is looked in.
  assert.equal(lib.findConfig(lib1, ['noverify.yaml'], { stopDir: lib1 }), null);
  assert.equal(lib.findConfig(lib1, ['noverify.yaml'], { stopDir: path.join(root, 'mod') }), path.join(root, 'mod/noverify.yaml'));
  assert.equal(lib.findConfig(path.join(root, 'mod'), ['dev/phpat/noverify.yaml'], { stopDir: path.join(root, 'mod') }), path.join(root, 'mod/dev/phpat/noverify.yaml'));

  // A directory with the name of the config is not a config.
  fs.mkdirSync(path.join(root, 'dir/noverify.yaml'), { recursive: true });
  assert.equal(lib.findConfig(path.join(root, 'dir'), ['noverify.yaml'], { stopDir: path.join(root, 'dir') }), null);
});

test('resolveExecutable: a path is used as is, a name is looked for in the PATH and in go bin', () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const pathBin = path.join(root, 'pathbin');
  const exe = (dir, name = 'noverify') => {
    touch(path.join(dir, name), 0o755);
    return path.join(dir, name);
  };

  // Nothing is installed.
  assert.equal(lib.resolveExecutable('noverify', { env: { PATH: pathBin }, home }), null);

  // go install puts it to ~/go/bin, that is not in the short PATH of the desktop launcher.
  const goBin = exe(path.join(home, 'go/bin'));
  assert.deepEqual(lib.resolveExecutable('noverify', { env: { PATH: pathBin }, home }), { path: goBin, source: 'go bin' });
  assert.deepEqual(lib.resolveExecutable(undefined, { env: { PATH: '' }, home }), { path: goBin, source: 'go bin' });
  assert.deepEqual(lib.resolveExecutable('  ', { env: {}, home }), { path: goBin, source: 'go bin' });

  // PATH wins.
  const inPath = exe(pathBin);
  assert.deepEqual(lib.resolveExecutable('noverify', { env: { PATH: pathBin }, home }), { path: inPath, source: 'PATH' });

  // GOBIN and GOPATH are before ~/go/bin.
  const gobin = exe(path.join(root, 'gobin'));
  assert.deepEqual(lib.resolveExecutable('noverify', { env: { PATH: '', GOBIN: path.join(root, 'gobin') }, home }), { path: gobin, source: 'go bin' });
  const gopath = exe(path.join(root, 'gopath/bin'));
  assert.deepEqual(lib.resolveExecutable('noverify', { env: { PATH: '', GOPATH: path.join(root, 'gopath') }, home }), { path: gopath, source: 'go bin' });

  // A path is not looked for.
  assert.deepEqual(lib.resolveExecutable(goBin, { env: { PATH: '' }, home }), { path: goBin, source: 'setting' });
  assert.equal(lib.resolveExecutable(path.join(root, 'nothing/noverify'), { env: { PATH: pathBin }, home }), null);
  assert.deepEqual(lib.resolveExecutable('~/go/bin/noverify', { env: {}, home }), { path: goBin, source: 'setting' });

  // A file that is not executable is not found.
  const notExe = path.join(root, 'plain/noverify');
  touch(notExe, 0o644);
  assert.equal(lib.resolveExecutable(notExe, { env: {}, home }), null);
});

test('buildArgs', () => {
  assert.deepEqual(lib.buildArgs({ config: '/m/c/dev/phpat/noverify.yaml', outputFile: '/tmp/o.json' }), [
    'check', '-c', '/m/c/dev/phpat/noverify.yaml', '--output-json', '--output', '/tmp/o.json',
  ]);
  assert.deepEqual(lib.buildArgs({ config: 'c.yaml', outputFile: 'o.json', extraArgs: ['--disable-cache', '--debug'] }).slice(-2), [
    '--disable-cache', '--debug',
  ]);
});

test('isPhpDocument', () => {
  assert.ok(lib.isPhpDocument({ languageId: 'php', fileName: '/a/b' }));
  assert.ok(lib.isPhpDocument({ languageId: 'plaintext', fileName: '/a/b.php' }));
  assert.ok(lib.isPhpDocument({ languageId: 'plaintext', fileName: '/a/b.INC' }));
  assert.ok(!lib.isPhpDocument({ languageId: 'javascript', fileName: '/a/b.js' }));
  assert.ok(!lib.isPhpDocument({ languageId: 'yaml', fileName: '/a/noverify.yaml' }));
  assert.ok(!lib.isPhpDocument(undefined));
});

test('SingleFlight: one at a time per key, one rerun for any number of requests', async () => {
  const log = [];
  let release;
  let running = 0;
  let maxRunning = 0;

  const flight = new lib.SingleFlight(async (key) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    log.push('start ' + key);
    await new Promise((resolve) => {
      release = resolve;
    });
    log.push('end ' + key);
    running--;
  });

  const first = flight.request('a');
  assert.ok(flight.isRunning('a'));
  flight.request('a');
  flight.request('a');
  flight.request('a');
  assert.deepEqual(log, ['start a']);

  release(); // the first run ends, the rerun starts
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ['start a', 'end a', 'start a']);

  release(); // the rerun ends, there is nothing more
  await first;
  assert.deepEqual(log, ['start a', 'end a', 'start a', 'end a']);
  assert.ok(!flight.isRunning('a'));
  assert.equal(maxRunning, 1);

  // It can run again after the end.
  const next = flight.request('a');
  release();
  await next;
  assert.equal(log.filter((l) => l === 'start a').length, 3);
});

test('SingleFlight: the keys are independent, an error does not stop it', async () => {
  const started = [];
  let fail = true;

  const flight = new lib.SingleFlight(async (key) => {
    started.push(key);
    if (key === 'bad' && fail) {
      fail = false;
      throw new Error('boom');
    }
  });

  const a = flight.request('a');
  const b = flight.request('b');
  assert.ok(flight.isRunning('a') && flight.isRunning('b'));
  await Promise.all([a, b]);

  await flight.request('bad'); // throws inside, but does not reject
  assert.ok(!flight.isRunning('bad'));
  await flight.request('bad'); // and can run again
  assert.deepEqual(started, ['a', 'b', 'bad', 'bad']);
});

const counts = (error, warning, info) => ({ error, warning, info });

test('countProblems', () => {
  assert.deepEqual(lib.countProblems([]), counts(0, 0, 0));
  assert.deepEqual(
    lib.countProblems([{ severity: 'error' }, { severity: 'warning' }, { severity: 'error' }, { severity: 'info' }]),
    counts(2, 1, 1)
  );
});

test('aggregateCounts: a directory has the sum of its files up to the root', () => {
  const root = path.join(path.sep, 'w', 'modules');
  const f = (rel) => path.join(root, rel);
  const result = lib.aggregateCounts(
    [
      new Map([
        [f('clouds/lib/a.php'), counts(2, 0, 0)],
        [f('clouds/lib/deep/b.php'), counts(0, 1, 0)],
        [f('clouds/tests/c.php'), counts(0, 0, 1)],
        [f('clouds/lib/clean.php'), counts(0, 0, 0)], // a file without problems is not counted
      ]),
    ],
    () => root
  );

  assert.deepEqual(result.get(f('clouds/lib/a.php')), counts(2, 0, 0));
  assert.deepEqual(result.get(f('clouds/lib/deep/b.php')), counts(0, 1, 0));
  assert.deepEqual(result.get(f('clouds/lib/deep')), counts(0, 1, 0));
  assert.deepEqual(result.get(f('clouds/lib')), counts(2, 1, 0));
  assert.deepEqual(result.get(f('clouds/tests')), counts(0, 0, 1));
  assert.deepEqual(result.get(f('clouds')), counts(2, 1, 1));
  assert.deepEqual(result.get(root), counts(2, 1, 1));

  assert.ok(!result.has(f('clouds/lib/clean.php')));
  assert.ok(!result.has(path.dirname(root)), 'not above the root');
  assert.ok(!result.has(path.sep));
});

test('aggregateCounts: several configs, a file without a root, a file outside of the root', () => {
  const root = path.join(path.sep, 'w', 'modules');
  const f = (rel) => path.join(root, rel);
  const outside = path.join(path.sep, 'other', 'x.php');
  const nowhere = path.join(path.sep, 'free', 'y.php');

  const result = lib.aggregateCounts(
    [
      new Map([[f('clouds/a.php'), counts(1, 0, 0)]]),
      new Map([
        [f('perfmon/p.php'), counts(0, 2, 0)],
        [outside, counts(1, 0, 0)],
        [nowhere, counts(0, 0, 3)],
      ]),
    ],
    (file) => (file === nowhere ? null : file === outside ? root : root)
  );

  assert.deepEqual(result.get(root), counts(1, 2, 0), 'the sum of the configs');
  assert.deepEqual(result.get(f('clouds')), counts(1, 0, 0));
  assert.deepEqual(result.get(f('perfmon')), counts(0, 2, 0));

  // The file is counted, its directories are not: there is no root.
  assert.deepEqual(result.get(nowhere), counts(0, 0, 3));
  assert.ok(!result.has(path.dirname(nowhere)));
  // A file that is not inside of its root does not add to the directories.
  assert.deepEqual(result.get(outside), counts(1, 0, 0));
  assert.ok(!result.has(path.dirname(outside)));
});

test('aggregateCounts: nothing', () => {
  assert.equal(lib.aggregateCounts([], () => '/r').size, 0);
  assert.equal(lib.aggregateCounts([new Map()], () => '/r').size, 0);
});

test('changedKeys', () => {
  const before = new Map([
    ['a', counts(1, 0, 0)],
    ['b', counts(0, 1, 0)],
    ['gone', counts(0, 0, 1)],
  ]);
  const after = new Map([
    ['a', counts(1, 0, 0)], // the same
    ['b', counts(0, 2, 0)], // changed
    ['new', counts(1, 1, 1)],
  ]);

  assert.deepEqual(lib.changedKeys(before, after).sort(), ['b', 'gone', 'new']);
  assert.deepEqual(lib.changedKeys(after, after), []);
  assert.deepEqual(lib.changedKeys(new Map(), new Map()), []);
});

test('badgeText: at most two characters', () => {
  assert.equal(lib.badgeText(0), undefined);
  assert.equal(lib.badgeText(-1), undefined);
  assert.equal(lib.badgeText(undefined), undefined);
  assert.equal(lib.badgeText(1), '1');
  assert.equal(lib.badgeText(9), '9');
  assert.equal(lib.badgeText(10), '10');
  assert.equal(lib.badgeText(99), '99');
  assert.equal(lib.badgeText(100), '∞');
  assert.equal(lib.badgeText(123456), '∞');
  for (const n of [1, 9, 10, 99, 100, 1000]) {
    assert.ok(lib.badgeText(n).length <= 2, `badge of ${n}`);
  }
});

test('dominantSeverity and describeCounts', () => {
  assert.equal(lib.dominantSeverity(counts(1, 5, 5)), 'error');
  assert.equal(lib.dominantSeverity(counts(0, 5, 5)), 'warning');
  assert.equal(lib.dominantSeverity(counts(0, 0, 5)), 'info');
  assert.equal(lib.dominantSeverity(counts(0, 0, 0)), null);

  assert.equal(lib.describeCounts(counts(2, 1, 3)), 'NoVerify: 2 errors, 1 warning, 3 notices');
  assert.equal(lib.describeCounts(counts(1, 0, 0)), 'NoVerify: 1 error');
  assert.equal(lib.describeCounts(counts(0, 0, 1)), 'NoVerify: 1 notice');
  assert.equal(lib.describeCounts(counts(0, 7, 0)), 'NoVerify: 7 warnings');
});
