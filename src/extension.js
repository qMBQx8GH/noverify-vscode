'use strict';

// The extension shows the reports of noverify in the Problems panel.
//
// On save of a PHP file it finds the config of the module (`dev/phpat/noverify.yaml` in the
// directory of the file or in its parents) and runs
//
//     noverify check -c <config> --output-json --output <file>
//
// in the background. The reports of the whole module replace the previous ones.
//
// The factory takes the `vscode` module, so the tests can pass a fake one.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('./lib');

const SECTION = 'noverify';
const SOURCE = 'noverify';
const STDERR_LIMIT = 256 * 1024;

// The exit codes of noverify: 0 - no critical reports, 2 - there are some, 1 - an error.
const EXIT_OK = 0;
const EXIT_HAS_REPORTS = 2;

/**
 * @param {typeof import('vscode')} vscode
 * @param {{spawn?: Function, env?: NodeJS.ProcessEnv, debounceMs?: number, timeoutMs?: number}} [deps]
 */
function createExtension(vscode, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const env = deps.env || process.env;
  const debounceMs = deps.debounceMs === undefined ? 250 : deps.debounceMs;

  const diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  const output = vscode.window.createOutputChannel('NoVerify');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.command = 'noverify.checkModule';

  /** config path -> uri string -> uri, the files that have the reports of the config */
  const published = new Map();
  /** the configs that were checked at least once */
  const checked = new Set();
  /** config path -> the running process */
  const processes = new Map();
  /** config path -> the timer of the debounce */
  const timers = new Map();
  /** the notifications that are shown once */
  const notified = new Set();

  let lastStatus = null;
  let lastErrorMessage = '';
  let disposed = false;

  const flight = new lib.SingleFlight(runCheck);

  // --- settings ---

  function settings(resource) {
    const c = vscode.workspace.getConfiguration(SECTION, resource);
    return {
      executable: c.get('executable', 'noverify'),
      configFiles: c.get('configFiles', ['dev/phpat/noverify.yaml', 'noverify.yaml']),
      runOnSave: c.get('runOnSave', true),
      runOnOpen: c.get('runOnOpen', false),
      minimumLevel: c.get('minimumLevel', 'notice'),
      extraArgs: c.get('extraArgs', []),
      timeout: c.get('timeout', 600),
    };
  }

  // --- the output and the status ---

  function log(message) {
    output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  }

  function setStatus(status) {
    lastStatus = status;

    switch (status.state) {
      case 'running':
        statusBar.text = '$(sync~spin) NoVerify';
        statusBar.tooltip = `NoVerify: checking ${status.config}`;
        statusBar.backgroundColor = undefined;
        break;

      case 'error':
        statusBar.text = '$(error) NoVerify';
        statusBar.tooltip = `NoVerify: ${status.message}\nClick to run again`;
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;

      case 'done': {
        const { error, warning, info } = status.counts;
        const parts = [];
        if (error) {
          parts.push(`$(error) ${error}`);
        }
        if (warning) {
          parts.push(`$(warning) ${warning}`);
        }
        if (info) {
          parts.push(`$(info) ${info}`);
        }
        statusBar.text = parts.length ? `NoVerify ${parts.join(' ')}` : '$(check) NoVerify';
        statusBar.tooltip =
          `NoVerify: ${status.config}\n${error} errors, ${warning} warnings, ${info} notices (${status.seconds.toFixed(1)} s)\n` +
          'Click to run again';
        statusBar.backgroundColor = undefined;
        break;
      }

      default:
        statusBar.text = '$(search) NoVerify';
        statusBar.tooltip = 'NoVerify: click to check the module';
        statusBar.backgroundColor = undefined;
    }

    updateStatusVisibility();
  }

  function updateStatusVisibility() {
    const editor = vscode.window.activeTextEditor;
    if (lastStatus && lastStatus.state !== 'idle') {
      statusBar.show();
    } else if (editor && lib.isPhpDocument(editor.document)) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  }

  function notifyOnce(key, show) {
    if (notified.has(key)) {
      return;
    }
    notified.add(key);
    show();
  }

  // --- the check ---

  /**
   * Runs the process. It never rejects.
   *
   * @returns {Promise<{code: number|null, signal: string|null, stderr: string, error: Error|null, timedOut: boolean, killed: boolean}>}
   */
  function execute(command, args, { cwd, timeoutMs, key }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env });
      } catch (error) {
        resolve({ code: null, signal: null, stderr: '', error, timedOut: false, killed: false });
        return;
      }

      processes.set(key, child);

      let stderr = '';
      let timedOut = false;
      let killed = false;
      let done = false;

      const finish = (result) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        if (processes.get(key) === child) {
          processes.delete(key);
        }
        resolve(Object.assign({ stderr, timedOut, killed }, result));
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > STDERR_LIMIT) {
          stderr = stderr.slice(-STDERR_LIMIT);
        }
      });
      child.on('error', (error) => finish({ code: null, signal: null, error }));
      child.on('close', (code, signal) => {
        killed = signal !== null && !timedOut;
        finish({ code, signal, error: null, killed });
      });
    });
  }

  function interestingStderr(stderr) {
    return stderr
      .split('\n')
      .filter((line) => /Failed parsing|Panic|Could not|incorrect|error/i.test(line) && !/stubs\/phpstorm-stubs\//.test(line))
      .slice(0, 20);
  }

  function lastLines(stderr, n) {
    return stderr.trim().split('\n').slice(-n).join('\n');
  }

  function fail(configPath, message, details) {
    log(`ERROR ${message}`);
    if (details) {
      log(details);
    }
    setStatus({ state: 'error', config: configPath, message });

    if (message !== lastErrorMessage) {
      lastErrorMessage = message;
      vscode.window.showErrorMessage(`NoVerify: ${message}`, 'Show output').then((choice) => {
        if (choice === 'Show output') {
          output.show(true);
        }
      });
    }
  }

  async function runCheck(configPath) {
    if (disposed) {
      return;
    }

    const resource = vscode.Uri.file(configPath);
    const c = settings(resource);

    const executable = lib.resolveExecutable(c.executable, { env });
    if (!executable) {
      const message = `the noverify binary "${c.executable}" is not found`;
      setStatus({ state: 'error', config: configPath, message });
      notifyOnce('executable:' + c.executable, () => {
        log(`ERROR ${message}`);
        vscode.window
          .showErrorMessage(
            `NoVerify: ${message}. Install it (make install) or set noverify.executable.`,
            'Open settings'
          )
          .then((choice) => {
            if (choice === 'Open settings') {
              vscode.commands.executeCommand('workbench.action.openSettings', 'noverify.executable');
            }
          });
      });
      return;
    }

    checked.add(configPath);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noverify-vscode-'));
    const outputFile = path.join(tmpDir, 'reports.json');
    const args = lib.buildArgs({ config: configPath, outputFile, extraArgs: c.extraArgs });

    log(`$ ${[executable.path, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    setStatus({ state: 'running', config: configPath });

    const started = Date.now();
    try {
      const result = await execute(executable.path, args, {
        cwd: path.dirname(configPath),
        timeoutMs: deps.timeoutMs || Math.max(5, c.timeout) * 1000,
        key: configPath,
      });

      if (disposed || result.killed) {
        return;
      }
      if (result.error) {
        fail(configPath, `cannot run ${executable.path}: ${result.error.message}`);
        return;
      }
      if (result.timedOut) {
        fail(configPath, `the check took more than ${c.timeout} s and was stopped`, lastLines(result.stderr, 5));
        return;
      }
      if (result.code !== EXIT_OK && result.code !== EXIT_HAS_REPORTS) {
        // For example, the config is incorrect.
        const tail = lastLines(result.stderr, 5);
        const lastLine = tail.split('\n').pop().replace(/^\d\d:\d\d:\d\d\s+/, '');
        fail(configPath, lastLine || `noverify exited with the code ${result.code}`, tail);
        return;
      }

      let parsed;
      try {
        parsed = lib.parseReports(fs.readFileSync(outputFile, 'utf8'), { minLevel: c.minimumLevel });
      } catch (e) {
        fail(configPath, `cannot read the reports of noverify: ${e.message}`, lastLines(result.stderr, 5));
        return;
      }

      publish(configPath, parsed);
      lastErrorMessage = '';

      const seconds = (Date.now() - started) / 1000;
      log(`${parsed.total} reports in ${parsed.byFile.size} files, ${seconds.toFixed(1)} s (${configPath})`);
      for (const line of interestingStderr(result.stderr)) {
        log(`  ${line.trim()}`);
      }
      setStatus({ state: 'done', config: configPath, counts: parsed.counts, seconds });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  function toDiagnostic(problem) {
    const range = new vscode.Range(problem.line, problem.startColumn, problem.line, problem.endColumn);
    const severity = {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      info: vscode.DiagnosticSeverity.Information,
    }[problem.severity];

    const diagnostic = new vscode.Diagnostic(range, problem.message, severity);
    diagnostic.source = SOURCE;
    diagnostic.code = problem.code;

    const tags = [];
    if (problem.tags.includes('unnecessary')) {
      tags.push(vscode.DiagnosticTag.Unnecessary);
    }
    if (problem.tags.includes('deprecated')) {
      tags.push(vscode.DiagnosticTag.Deprecated);
    }
    if (tags.length) {
      diagnostic.tags = tags;
    }
    return diagnostic;
  }

  /** Replaces the reports of the config. The files that have no reports any more are cleared. */
  function publish(configPath, parsed) {
    const previous = published.get(configPath) || new Map();
    const next = new Map();

    for (const [filename, problems] of parsed.byFile) {
      const uri = vscode.Uri.file(filename);
      diagnostics.set(uri, problems.map(toDiagnostic));
      next.set(uri.toString(), uri);
    }

    for (const [key, uri] of previous) {
      if (!next.has(key)) {
        diagnostics.delete(uri);
      }
    }

    published.set(configPath, next);
  }

  // --- the triggers ---

  /** Runs the check after the pause, a series of saves is one check. */
  function schedule(configPath) {
    clearTimeout(timers.get(configPath));
    const timer = setTimeout(() => {
      timers.delete(configPath);
      flight.request(configPath);
    }, debounceMs);
    timers.set(configPath, timer);
  }

  function configFor(fileName) {
    const uri = vscode.Uri.file(fileName);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const names = settings(uri).configFiles;
    return lib.findConfig(path.dirname(fileName), names, { stopDir: folder ? folder.uri.fsPath : undefined });
  }

  function onDidSave(doc) {
    if (doc.uri.scheme !== 'file') {
      return;
    }

    // The config itself is saved: check the module that it describes.
    if (published.has(doc.fileName) || checked.has(doc.fileName)) {
      schedule(doc.fileName);
      return;
    }

    if (!lib.isPhpDocument(doc) || !settings(doc.uri).runOnSave) {
      return;
    }

    const config = configFor(doc.fileName);
    if (config) {
      schedule(config);
    }
  }

  function onDidOpen(doc) {
    if (doc.uri.scheme !== 'file' || !lib.isPhpDocument(doc) || !settings(doc.uri).runOnOpen) {
      return;
    }

    const config = configFor(doc.fileName);
    if (config && !checked.has(config) && !flight.isRunning(config) && !timers.has(config)) {
      schedule(config);
    }
  }

  // --- the commands ---

  async function pickConfig() {
    const folders = vscode.workspace.workspaceFolders || [];
    const names = folders.length ? settings(folders[0].uri).configFiles : settings(undefined).configFiles;
    if (!names.length) {
      return null;
    }

    const glob = names.length === 1 ? `**/${names[0]}` : `**/{${names.join(',')}}`;
    const files = await vscode.workspace.findFiles(glob, '**/{node_modules,vendor,.git}/**', 50);
    if (!files.length) {
      return null;
    }
    if (files.length === 1) {
      return files[0].fsPath;
    }

    const choice = await vscode.window.showQuickPick(
      files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      { placeHolder: 'The config of the module to check' }
    );
    return choice ? choice.uri.fsPath : null;
  }

  async function checkModule() {
    const editor = vscode.window.activeTextEditor;
    let config = null;
    if (editor && editor.document.uri.scheme === 'file') {
      config = configFor(editor.document.fileName);
    }
    if (!config) {
      config = await pickConfig();
    }
    if (!config) {
      vscode.window.showInformationMessage(
        `NoVerify: no config file found (${settings(undefined).configFiles.join(', ')}). Create dev/phpat/noverify.yaml, see "noverify check -c".`
      );
      return;
    }

    clearTimeout(timers.get(config));
    timers.delete(config);
    await flight.request(config);
  }

  function clear() {
    diagnostics.clear();
    published.clear();
    lastErrorMessage = '';
    setStatus({ state: 'idle' });
  }

  // --- the life cycle ---

  function activate(context) {
    log('NoVerify is active');

    const subscriptions = [
      diagnostics,
      output,
      statusBar,
      vscode.workspace.onDidSaveTextDocument(onDidSave),
      vscode.workspace.onDidOpenTextDocument(onDidOpen),
      vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility),
      vscode.commands.registerCommand('noverify.checkModule', checkModule),
      vscode.commands.registerCommand('noverify.clear', clear),
      vscode.commands.registerCommand('noverify.showOutput', () => output.show(true)),
    ];
    for (const s of subscriptions) {
      context.subscriptions.push(s);
    }

    setStatus({ state: 'idle' });

    for (const doc of vscode.workspace.textDocuments) {
      onDidOpen(doc);
    }
  }

  function deactivate() {
    disposed = true;
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const child of processes.values()) {
      child.kill();
    }
    processes.clear();
  }

  /** Waits until nothing is scheduled or running (for the tests). */
  async function idle() {
    for (;;) {
      const busy = timers.size > 0 || [...checked, ...timers.keys()].some((key) => flight.isRunning(key));
      if (!busy) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return { activate, deactivate, checkModule, clear, idle };
}

let instance = null;

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  instance = createExtension(require('vscode'));
  instance.activate(context);
}

function deactivate() {
  if (instance) {
    instance.deactivate();
    instance = null;
  }
}

module.exports = { activate, deactivate, createExtension };
