'use strict';

// A minimal fake of the `vscode` module: only what the extension uses.

const path = require('node:path');

class Uri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(s) {
    return new Uri(s.replace(/^file:\/\//, ''));
  }
  toString() {
    return 'file://' + this.fsPath;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

function disposable(fn) {
  return { dispose: fn || (() => {}) };
}

function createVscode(options = {}) {
  const settings = options.settings || {};
  const folders = (options.folders || []).map((p) => ({ uri: Uri.file(p), name: path.basename(p) }));

  const handlers = { save: [], open: [], activeEditor: [] };
  const commands = new Map();
  const state = {
    errors: [],
    infos: [],
    executed: [],
    quickPicks: [],
    openedOutput: 0,
    findFilesResult: options.findFiles || [],
    quickPickAnswer: undefined,
  };

  const collection = {
    map: new Map(),
    set(uri, diags) {
      this.map.set(uri.toString(), { uri, diags });
    },
    delete(uri) {
      this.map.delete(uri.toString());
    },
    clear() {
      this.map.clear();
    },
    get(uri) {
      const e = this.map.get(uri.toString());
      return e ? e.diags : undefined;
    },
    files() {
      return [...this.map.values()].map((e) => e.uri.fsPath).sort();
    },
    dispose() {},
  };

  const output = {
    lines: [],
    appendLine(line) {
      this.lines.push(line);
    },
    show() {
      state.openedOutput++;
    },
    dispose() {},
  };

  const statusBar = {
    text: '',
    tooltip: '',
    command: undefined,
    backgroundColor: undefined,
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose() {},
  };

  const vscode = {
    Uri,
    Position,
    Range,
    Diagnostic,
    ThemeColor,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },

    languages: {
      createDiagnosticCollection: () => collection,
    },

    window: {
      activeTextEditor: options.activeEditor,
      createOutputChannel: () => output,
      createStatusBarItem: () => statusBar,
      onDidChangeActiveTextEditor: (h) => {
        handlers.activeEditor.push(h);
        return disposable();
      },
      showErrorMessage: (message, ...items) => {
        state.errors.push({ message, items });
        return Promise.resolve(undefined);
      },
      showInformationMessage: (message) => {
        state.infos.push(message);
        return Promise.resolve(undefined);
      },
      showQuickPick: (items) => {
        state.quickPicks.push(items);
        return Promise.resolve(state.quickPickAnswer ? state.quickPickAnswer(items) : undefined);
      },
    },

    workspace: {
      workspaceFolders: folders.length ? folders : undefined,
      textDocuments: options.textDocuments || [],
      getConfiguration: (section, resource) => ({
        get: (key, def) => {
          const full = section + '.' + key;
          return Object.prototype.hasOwnProperty.call(settings, full) ? settings[full] : def;
        },
      }),
      getWorkspaceFolder: (uri) => folders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
      onDidSaveTextDocument: (h) => {
        handlers.save.push(h);
        return disposable();
      },
      onDidOpenTextDocument: (h) => {
        handlers.open.push(h);
        return disposable();
      },
      findFiles: (glob) => {
        state.findFilesGlob = glob;
        return Promise.resolve(state.findFilesResult);
      },
      asRelativePath: (uri) => {
        const folder = folders.find((f) => uri.fsPath.startsWith(f.uri.fsPath + path.sep));
        return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
      },
    },

    commands: {
      registerCommand: (name, fn) => {
        commands.set(name, fn);
        return disposable(() => commands.delete(name));
      },
      executeCommand: (name, ...args) => {
        state.executed.push([name, ...args]);
        const fn = commands.get(name);
        return Promise.resolve(fn ? fn(...args) : undefined);
      },
    },
  };

  return {
    vscode,
    collection,
    output,
    statusBar,
    state,
    commands,
    settings,
    doc(fileName, languageId = 'php') {
      return { fileName, languageId, uri: Uri.file(fileName) };
    },
    save(doc) {
      handlers.save.forEach((h) => h(doc));
    },
    open(doc) {
      handlers.open.forEach((h) => h(doc));
    },
    setActiveEditor(doc) {
      vscode.window.activeTextEditor = doc ? { document: doc } : undefined;
      handlers.activeEditor.forEach((h) => h(vscode.window.activeTextEditor));
    },
  };
}

module.exports = { createVscode, Uri };
