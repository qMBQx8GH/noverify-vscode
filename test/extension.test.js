'use strict';

// The whole flow with a fake `vscode` and a fake `noverify` binary
// that writes the prepared JSON and exits with the prepared code.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createExtension } = require('../src/extension');
const { createVscode } = require('./fakeVscode');

const FAKE_NOVERIFY = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const control = JSON.parse(fs.readFileSync(process.env.FAKE_CONTROL, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
process.on('SIGTERM', () => {
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ killed: true }) + '\\n');
  process.exit(143);
});
const out = args[args.indexOf('--output') + 1];
setTimeout(() => {
  if (control.stderr) process.stderr.write(control.stderr);
  if (control.writeReports !== false) {
    fs.writeFileSync(out, control.rawOutput !== undefined ? control.rawOutput : JSON.stringify({ Reports: control.reports || [], Errors: null }));
  }
  process.exit(control.exit === undefined ? 2 : control.exit);
}, control.delayMs || 0);
`;

function report(root, file, extra) {
  return Object.assign(
    {
      check_name: 'undefinedFunction',
      level: 1,
      context: '    echo undefined_here();',
      message: 'Call to undefined function undefined_here',
      filename: path.join(root, file),
      line: 4,
      start_char: 9,
      end_char: 23,
      hash: 0,
    },
    extra
  );
}

/** Creates the project, the fake binary and the extension. */
function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noverify-vscode-e2e-'));
  const modules = path.join(root, 'modules');

  const write = (rel, contents = '<?php\n') => {
    const file = path.join(modules, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };

  const config = write('clouds/dev/phpat/noverify.yaml', 'paths:\n  - ../..\n');
  const files = {
    config,
    a: write('clouds/lib/a.php'),
    b: write('clouds/lib/deep/b.php'),
    c: write('clouds/tests/c.php'),
    main: write('main/lib/m.php'), // the module without a config
    readme: write('clouds/README.md', '# readme\n'),
  };

  const binary = path.join(root, 'bin', 'noverify');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, FAKE_NOVERIFY, { mode: 0o755 });

  const controlFile = path.join(root, 'control.json');
  const callsFile = path.join(root, 'calls.log');
  fs.writeFileSync(callsFile, '');

  const control = (obj) => fs.writeFileSync(controlFile, JSON.stringify(obj));
  control({ reports: [] });

  const calls = () =>
    fs
      .readFileSync(callsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const runs = () => calls().filter((c) => c.args);

  const fake = createVscode({
    folders: [modules],
    settings: Object.assign({ 'noverify.executable': options.executable || binary }, options.settings),
    activeEditor: options.activeEditor,
    findFiles: options.findFiles,
    textDocuments: options.textDocuments,
  });

  const ext = createExtension(fake.vscode, {
    env: Object.assign({}, process.env, { FAKE_CONTROL: controlFile, FAKE_CALLS: callsFile }),
    debounceMs: options.debounceMs === undefined ? 5 : options.debounceMs,
    timeoutMs: options.timeoutMs,
  });
  const context = { subscriptions: [] };
  ext.activate(context);

  const cleanup = () => {
    ext.deactivate();
    fs.rmSync(root, { recursive: true, force: true });
  };

  return { root, modules, files, fake, ext, control, calls, runs, cleanup, report: (file, extra) => report(modules, path.relative(modules, file), extra) };
}

test('saving a PHP file runs the check of its module and shows the reports', async () => {
  const t = setup();
  try {
    t.control({
      reports: [
        t.report(t.files.a),
        t.report(t.files.b, { check_name: 'unused', level: 2, message: 'Variable $x is unused', line: 2, context: '$x = 1;', start_char: 0, end_char: 2 }),
        t.report(t.files.c, { check_name: 'deprecated', level: 3, message: 'old' }),
      ],
    });

    t.fake.save(t.fake.doc(t.files.b));
    await t.ext.idle();

    // The command line: the config is found in the parent directory of the saved file.
    assert.equal(t.runs().length, 1);
    const run = t.runs()[0];
    assert.equal(run.args[0], 'check');
    assert.deepEqual(run.args.slice(1, 3), ['-c', t.files.config]);
    assert.ok(run.args.includes('--output-json'));
    assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(path.dirname(t.files.config)));

    // The reports of the whole module are shown, not only of the saved file.
    assert.deepEqual(t.fake.collection.files(), [t.files.a, t.files.b, t.files.c].sort());

    const [d] = t.fake.collection.get(t.fake.vscode.Uri.file(t.files.a));
    assert.equal(d.message, 'Call to undefined function undefined_here');
    assert.equal(d.source, 'noverify');
    assert.equal(d.code, 'undefinedFunction');
    assert.equal(d.severity, t.fake.vscode.DiagnosticSeverity.Error);
    assert.deepEqual([d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character], [3, 9, 3, 23]);

    const [unused] = t.fake.collection.get(t.fake.vscode.Uri.file(t.files.b));
    assert.equal(unused.severity, t.fake.vscode.DiagnosticSeverity.Warning);
    assert.deepEqual(unused.tags, [t.fake.vscode.DiagnosticTag.Unnecessary]);

    const [deprecated] = t.fake.collection.get(t.fake.vscode.Uri.file(t.files.c));
    assert.equal(deprecated.severity, t.fake.vscode.DiagnosticSeverity.Information);
    assert.deepEqual(deprecated.tags, [t.fake.vscode.DiagnosticTag.Deprecated]);

    // The status bar.
    assert.match(t.fake.statusBar.text, /\$\(error\) 1/);
    assert.match(t.fake.statusBar.text, /\$\(warning\) 1/);
    assert.match(t.fake.statusBar.text, /\$\(info\) 1/);
    assert.ok(t.fake.statusBar.visible);
  } finally {
    t.cleanup();
  }
});

test('the new run replaces the old reports, the files without reports are cleared', async () => {
  const t = setup();
  try {
    t.control({ reports: [t.report(t.files.a), t.report(t.files.b)] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.deepEqual(t.fake.collection.files(), [t.files.a, t.files.b].sort());

    // b is fixed, c is a new one.
    t.control({ reports: [t.report(t.files.a, { line: 7 }), t.report(t.files.c)] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    assert.deepEqual(t.fake.collection.files(), [t.files.a, t.files.c].sort());
    assert.equal(t.fake.collection.get(t.fake.vscode.Uri.file(t.files.a))[0].range.start.line, 6);

    // Everything is fixed.
    t.control({ reports: [] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.deepEqual(t.fake.collection.files(), []);
    assert.match(t.fake.statusBar.text, /\$\(check\) NoVerify/);
  } finally {
    t.cleanup();
  }
});

test('the reports of the other module are not touched', async () => {
  const t = setup();
  try {
    // The second module with its own config.
    const config2 = path.join(t.modules, 'perfmon/dev/phpat/noverify.yaml');
    fs.mkdirSync(path.dirname(config2), { recursive: true });
    fs.writeFileSync(config2, 'paths:\n  - ../..\n');
    const p = path.join(t.modules, 'perfmon/lib/p.php');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '<?php\n');

    t.control({ reports: [t.report(t.files.a)] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    t.control({ reports: [t.report(p)] });
    t.fake.save(t.fake.doc(p));
    await t.ext.idle();

    assert.deepEqual(t.fake.collection.files(), [t.files.a, p].sort());
    assert.equal(t.runs().length, 2);
    assert.equal(t.runs()[1].args[2], config2);
  } finally {
    t.cleanup();
  }
});

test('a series of saves is one check, a save during a check is one more check', async () => {
  const t = setup({ debounceMs: 30 });
  try {
    t.control({ reports: [], delayMs: 200 });

    for (let i = 0; i < 5; i++) {
      t.fake.save(t.fake.doc(t.files.a));
    }
    await new Promise((resolve) => setTimeout(resolve, 100)); // the debounce is over, the process is running
    assert.equal(t.runs().length, 1);

    // Saved while it is running: the files could change after the start.
    t.fake.save(t.fake.doc(t.files.b));
    await new Promise((resolve) => setTimeout(resolve, 60));
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    assert.equal(t.runs().length, 2, 'one more run, not one per save');
  } finally {
    t.cleanup();
  }
});

test('nothing is run for a file without a config, for not PHP files and if runOnSave is off', async () => {
  const t = setup();
  try {
    t.fake.save(t.fake.doc(t.files.main)); // the module without a config
    t.fake.save(t.fake.doc(t.files.readme, 'markdown'));
    t.fake.save(t.fake.doc(path.join(t.modules, 'clouds/lib/a.js'), 'javascript'));
    await t.ext.idle();
    assert.equal(t.runs().length, 0);

    t.fake.settings['noverify.runOnSave'] = false;
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.runs().length, 0);

    t.fake.settings['noverify.runOnSave'] = true;
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.runs().length, 1);
  } finally {
    t.cleanup();
  }
});

test('a file with a PHP extension is checked even if the editor has another language mode', async () => {
  const t = setup();
  try {
    t.fake.save(t.fake.doc(t.files.a, 'plaintext'));
    await t.ext.idle();
    assert.equal(t.runs().length, 1);
  } finally {
    t.cleanup();
  }
});

test('saving the config checks the module again', async () => {
  const t = setup();
  try {
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.runs().length, 1);

    t.fake.save(t.fake.doc(t.files.config, 'yaml'));
    await t.ext.idle();
    assert.equal(t.runs().length, 2);
    assert.equal(t.runs()[1].args[2], t.files.config);
  } finally {
    t.cleanup();
  }
});

test('runOnOpen checks the module when its first PHP file is opened, once', async () => {
  const t = setup({ settings: { 'noverify.runOnOpen': true } });
  try {
    t.fake.open(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.runs().length, 1);

    t.fake.open(t.fake.doc(t.files.b)); // the same module
    await t.ext.idle();
    assert.equal(t.runs().length, 1);

    t.fake.open(t.fake.doc(t.files.main)); // no config
    await t.ext.idle();
    assert.equal(t.runs().length, 1);
  } finally {
    t.cleanup();
  }

  const off = setup();
  try {
    off.fake.open(off.fake.doc(off.files.a));
    await off.ext.idle();
    assert.equal(off.runs().length, 0, 'runOnOpen is off by default');
  } finally {
    off.cleanup();
  }
});

test('the documents that are already open are checked on the start if runOnOpen is on', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noverify-vscode-e2e-'));
  fs.rmSync(root, { recursive: true, force: true });

  const t = setup({ settings: { 'noverify.runOnOpen': true } });
  try {
    // A second extension instance that starts when a document is already open.
    const fake = createVscode({
      folders: [t.modules],
      settings: Object.assign({}, t.fake.settings),
      textDocuments: [{ fileName: t.files.a, languageId: 'php', uri: t.fake.vscode.Uri.file(t.files.a) }],
    });
    const ext = createExtension(fake.vscode, {
      env: Object.assign({}, process.env, { FAKE_CONTROL: path.join(t.root, 'control.json'), FAKE_CALLS: path.join(t.root, 'calls.log') }),
      debounceMs: 5,
    });
    ext.activate({ subscriptions: [] });
    await ext.idle();
    ext.deactivate();

    assert.equal(t.runs().length, 1);
  } finally {
    t.cleanup();
  }
});

test('minimumLevel and extraArgs settings', async () => {
  const t = setup({ settings: { 'noverify.minimumLevel': 'warning', 'noverify.extraArgs': ['--disable-cache', '--exclude-checks', 'unused'] } });
  try {
    t.control({
      reports: [
        t.report(t.files.a, { level: 1, message: 'e', line: 1 }),
        t.report(t.files.a, { level: 2, message: 'w', line: 2 }),
        t.report(t.files.a, { level: 3, message: 'n', line: 3 }),
      ],
    });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    assert.deepEqual(
      t.fake.collection.get(t.fake.vscode.Uri.file(t.files.a)).map((d) => d.message),
      ['e', 'w']
    );
    assert.deepEqual(t.runs()[0].args.slice(-3), ['--disable-cache', '--exclude-checks', 'unused']);
  } finally {
    t.cleanup();
  }
});

test('the config file names are a setting', async () => {
  const t = setup({ settings: { 'noverify.configFiles': ['tools/lint.yaml'] } });
  try {
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.runs().length, 0, 'the default config name is not used');

    const custom = path.join(t.modules, 'clouds/tools/lint.yaml');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    fs.writeFileSync(custom, 'paths: []\n');
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.runs().length, 1);
    assert.equal(t.runs()[0].args[2], custom);
  } finally {
    t.cleanup();
  }
});

test('an error of noverify: the old reports stay, the error is shown once', async () => {
  const t = setup();
  try {
    t.control({ reports: [t.report(t.files.a)] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.deepEqual(t.fake.collection.files(), [t.files.a]);

    t.control({ exit: 1, writeReports: false, stderr: '11:20:00 Started\n11:20:00 config /m/noverify.yaml: field pths not found in type cmd.FileConfig\n' });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    assert.deepEqual(t.fake.collection.files(), [t.files.a], 'the previous reports are kept');
    assert.match(t.fake.statusBar.text, /\$\(error\)/);
    assert.ok(t.fake.statusBar.backgroundColor);
    assert.equal(t.fake.state.errors.length, 1);
    assert.match(t.fake.state.errors[0].message, /field pths not found/);
    assert.match(t.fake.output.lines.join('\n'), /ERROR/);

    // The same error again does not bother the user again.
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.fake.state.errors.length, 1);

    // Fixed.
    t.control({ reports: [] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.deepEqual(t.fake.collection.files(), []);
    assert.equal(t.fake.statusBar.backgroundColor, undefined);
  } finally {
    t.cleanup();
  }
});

test('unreadable output is an error', async () => {
  const t = setup();
  try {
    t.control({ rawOutput: 'not json', exit: 0 });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.match(t.fake.state.errors[0].message, /cannot read the reports/);

    t.control({ writeReports: false, exit: 0 });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.fake.state.errors.length, 2);
  } finally {
    t.cleanup();
  }
});

test('the binary is not found: one message with the way to fix it', async () => {
  const t = setup({ executable: '/nonexistent/noverify' });
  try {
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    assert.equal(t.fake.state.errors.length, 1);
    assert.match(t.fake.state.errors[0].message, /not found/);
    assert.deepEqual(t.fake.state.errors[0].items, ['Open settings']);
    assert.match(t.fake.statusBar.text, /\$\(error\)/);
  } finally {
    t.cleanup();
  }
});

test('a too long check is stopped', async () => {
  const t = setup({ timeoutMs: 150 });
  try {
    t.control({ reports: [], delayMs: 5000 });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    assert.match(t.fake.state.errors[0].message, /took more than/);
    assert.ok(t.calls().some((c) => c.killed), 'the process is killed');
  } finally {
    t.cleanup();
  }
});

test('deactivate kills the running check', async () => {
  const t = setup();
  try {
    t.control({ reports: [], delayMs: 5000 });
    t.fake.save(t.fake.doc(t.files.a));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(t.runs().length, 1);

    t.ext.deactivate();
    await t.ext.idle();
    assert.ok(t.calls().some((c) => c.killed));
    assert.equal(t.fake.state.errors.length, 0, 'a killed check is not an error');
  } finally {
    t.cleanup();
  }
});

test('the command "Check the module" works for the active editor', async () => {
  const t = setup();
  try {
    t.control({ reports: [t.report(t.files.a)] });
    t.fake.setActiveEditor(t.fake.doc(t.files.b));
    assert.ok(t.fake.statusBar.visible, 'the status bar is shown for a PHP file');

    await t.fake.vscode.commands.executeCommand('noverify.checkModule');

    assert.equal(t.runs().length, 1);
    assert.deepEqual(t.fake.collection.files(), [t.files.a]);

    t.fake.setActiveEditor(t.fake.doc(t.files.readme, 'markdown'));
    assert.ok(t.fake.statusBar.visible, 'it stays after the first check');
  } finally {
    t.cleanup();
  }
});

test('the command without an editor looks for the configs in the workspace', async () => {
  const Uri = require('./fakeVscode').Uri;
  const t = setup();
  try {
    t.control({ reports: [t.report(t.files.a)] });

    // One config.
    t.fake.state.findFilesResult = [Uri.file(t.files.config)];
    await t.fake.vscode.commands.executeCommand('noverify.checkModule');
    assert.equal(t.runs().length, 1);
    assert.match(t.fake.state.findFilesGlob, /^\*\*\/\{dev\/phpat\/noverify\.yaml,noverify\.yaml\}$/);

    // Several configs: the user chooses.
    const other = path.join(t.modules, 'perfmon/dev/phpat/noverify.yaml');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'paths: []\n');
    t.fake.state.findFilesResult = [Uri.file(t.files.config), Uri.file(other)];
    t.fake.state.quickPickAnswer = (items) => items.find((i) => i.label.startsWith('perfmon'));
    await t.fake.vscode.commands.executeCommand('noverify.checkModule');
    assert.equal(t.fake.state.quickPicks.length, 1);
    assert.deepEqual(t.fake.state.quickPicks[0].map((i) => i.label).sort(), ['clouds/dev/phpat/noverify.yaml', 'perfmon/dev/phpat/noverify.yaml']);
    assert.equal(t.runs().length, 2);
    assert.equal(t.runs()[1].args[2], other);

    // The choice is cancelled.
    t.fake.state.quickPickAnswer = () => undefined;
    await t.fake.vscode.commands.executeCommand('noverify.checkModule');
    assert.equal(t.runs().length, 2);

    // No configs at all.
    t.fake.state.findFilesResult = [];
    await t.fake.vscode.commands.executeCommand('noverify.checkModule');
    assert.equal(t.runs().length, 2);
    assert.match(t.fake.state.infos[0], /no config file found/);
  } finally {
    t.cleanup();
  }
});

test('the commands "Clear the reports" and "Show the output"', async () => {
  const t = setup();
  try {
    t.control({ reports: [t.report(t.files.a), t.report(t.files.b)] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();
    assert.equal(t.fake.collection.files().length, 2);

    await t.fake.vscode.commands.executeCommand('noverify.clear');
    assert.deepEqual(t.fake.collection.files(), []);
    assert.match(t.fake.statusBar.text, /NoVerify/);

    await t.fake.vscode.commands.executeCommand('noverify.showOutput');
    assert.equal(t.fake.state.openedOutput, 1);
  } finally {
    t.cleanup();
  }
});

test('the offsets are bytes: the report of a line with Cyrillic', async () => {
  const t = setup();
  try {
    const line = '$s = "привет"; echo undefined_fn(1), $s;';
    t.control({ reports: [t.report(t.files.a, { context: line, start_char: 26, end_char: 38, line: 2 })] });
    t.fake.save(t.fake.doc(t.files.a));
    await t.ext.idle();

    const [d] = t.fake.collection.get(t.fake.vscode.Uri.file(t.files.a));
    assert.equal(line.slice(d.range.start.character, d.range.end.character), 'undefined_fn');
  } finally {
    t.cleanup();
  }
});
