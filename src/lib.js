'use strict';

// The logic of the extension that does not depend on the VS Code API,
// so it can be tested with the plain `node --test`.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The levels of the reports of noverify (src/linter/lintapi).
const LEVEL_ERROR = 1;
const LEVEL_WARNING = 2;
const LEVEL_NOTICE = 3; // "MAYBE"
const LEVEL_SECURITY = 4;

const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };

// The names of the minimum level setting -> the lowest rank that is shown.
const MIN_LEVEL_RANK = { notice: 1, warning: 2, error: 3 };

/**
 * @param {number} level the level of a report of noverify
 * @returns {'error'|'warning'|'info'}
 */
function severityOf(level) {
  switch (level) {
    case LEVEL_ERROR:
      return 'error';
    case LEVEL_WARNING:
    case LEVEL_SECURITY:
      return 'warning';
    default:
      return 'info'; // LEVEL_NOTICE
  }
}

/**
 * Converts an offset in UTF-8 bytes of the line (noverify counts bytes)
 * to an offset in UTF-16 code units (VS Code counts them).
 * An offset inside of a character is rounded down, an offset after the end
 * is the length of the text.
 *
 * @param {string} text
 * @param {number} byteOffset
 * @returns {number}
 */
function byteOffsetToUtf16(text, byteOffset) {
  if (!(byteOffset > 0)) {
    return 0;
  }

  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > byteOffset) {
      return i;
    }
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
    if (bytes === byteOffset) {
      return i;
    }
  }
  return text.length;
}

/**
 * @typedef {Object} Problem
 * @property {number} line zero-based
 * @property {number} startColumn zero-based, UTF-16
 * @property {number} endColumn zero-based, UTF-16
 * @property {'error'|'warning'|'info'} severity
 * @property {string} code the name of the check
 * @property {string} message
 * @property {Array<'unnecessary'|'deprecated'>} tags
 */

/**
 * Parses the output of `noverify check --output-json`.
 *
 * @param {string} jsonText
 * @param {{minLevel?: 'notice'|'warning'|'error'}} [options]
 * @returns {{byFile: Map<string, Problem[]>, total: number, counts: {error: number, warning: number, info: number}}}
 */
function parseReports(jsonText, options = {}) {
  const data = JSON.parse(jsonText);
  const reports = (data && data.Reports) || [];
  const minRank = MIN_LEVEL_RANK[options.minLevel || 'notice'] || 1;

  /** @type {Map<string, Problem[]>} */
  const byFile = new Map();
  const seen = new Set();
  const counts = { error: 0, warning: 0, info: 0 };
  let total = 0;

  for (const r of reports) {
    if (!r || !r.filename) {
      continue;
    }

    const severity = severityOf(r.level);
    if (SEVERITY_RANK[severity] < minRank) {
      continue;
    }

    // `context` is the source line (with \r for the CRLF files).
    const text = String(r.context || '').replace(/\r$/, '');
    let start = byteOffsetToUtf16(text, r.start_char);
    let end = byteOffsetToUtf16(text, r.end_char);
    if (end <= start) {
      // An empty or a collapsed range is not visible, highlight a character.
      end = Math.min(text.length, start + 1);
      if (end <= start) {
        start = Math.max(0, text.length - 1);
        end = text.length;
      }
    }

    const line = Math.max(0, (r.line || 1) - 1);
    const key = [r.filename, line, start, end, r.check_name, r.message].join('\u0000');
    if (seen.has(key)) {
      continue; // noverify reports some things twice (for example inside of anonymous classes)
    }
    seen.add(key);

    const tags = [];
    if (r.check_name === 'unused') {
      tags.push('unnecessary');
    } else if (r.check_name === 'deprecated') {
      tags.push('deprecated');
    }

    let problems = byFile.get(r.filename);
    if (!problems) {
      problems = [];
      byFile.set(r.filename, problems);
    }
    problems.push({
      line,
      startColumn: start,
      endColumn: end,
      severity,
      code: r.check_name || '',
      message: String(r.message || ''),
      tags,
    });
    counts[severity]++;
    total++;
  }

  for (const problems of byFile.values()) {
    problems.sort((a, b) => a.line - b.line || a.startColumn - b.startColumn);
  }

  return { byFile, total, counts };
}

function isFile(fsImpl, p) {
  try {
    return fsImpl.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

/**
 * Looks for the config file in the directory and then in its parents, so a file of a module
 * finds `<module>/dev/phpat/noverify.yaml`.
 *
 * @param {string} startDir
 * @param {string[]} names the relative paths of the config, in the order of the priority
 * @param {{stopDir?: string, fs?: typeof fs}} [options] stopDir is the last directory to look in
 * @returns {string|null} the absolute path of the config
 */
function findConfig(startDir, names, options = {}) {
  const fsImpl = options.fs || fs;
  const stopDir = options.stopDir ? path.resolve(options.stopDir) : null;

  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(fsImpl, candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir || (stopDir && dir === stopDir)) {
      return null;
    }
    dir = parent;
  }
}

function expandHome(p, home) {
  if (p === '~') {
    return home;
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

function isExecutable(fsImpl, p, platform) {
  if (!isFile(fsImpl, p)) {
    return false;
  }
  if (platform === 'win32') {
    return true;
  }
  try {
    fsImpl.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Finds the noverify binary.
 *
 * A path (with a separator or `~`) is used as is. A bare name is looked for in the PATH,
 * then in the places where `go install` puts it: $GOBIN, $GOPATH/bin and ~/go/bin.
 * VS Code started from a desktop launcher often has a short PATH without them.
 *
 * @param {string} setting the value of the `noverify.executable` setting
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, home?: string, fs?: typeof fs}} [options]
 * @returns {{path: string, source: string}|null}
 */
function resolveExecutable(setting, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const fsImpl = options.fs || fs;

  const name = (setting || 'noverify').trim() || 'noverify';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  const expanded = expandHome(name, home);
  if (name !== expanded || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return isExecutable(fsImpl, expanded, platform) ? { path: expanded, source: 'setting' } : null;
  }

  const pathVar = env.PATH || env.Path || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(fsImpl, candidate, platform)) {
        return { path: candidate, source: 'PATH' };
      }
    }
  }

  const goDirs = [];
  if (env.GOBIN) {
    goDirs.push(env.GOBIN);
  }
  if (env.GOPATH) {
    for (const p of env.GOPATH.split(path.delimiter)) {
      if (p) {
        goDirs.push(path.join(p, 'bin'));
      }
    }
  }
  goDirs.push(path.join(home, 'go', 'bin'));

  for (const dir of goDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(fsImpl, candidate, platform)) {
        return { path: candidate, source: 'go bin' };
      }
    }
  }

  return null;
}

/**
 * The arguments of the noverify command.
 *
 * @param {{config: string, outputFile: string, extraArgs?: string[]}} options
 * @returns {string[]}
 */
function buildArgs({ config, outputFile, extraArgs }) {
  return ['check', '-c', config, '--output-json', '--output', outputFile, ...(extraArgs || [])];
}

/**
 * @param {{languageId?: string, fileName?: string}} doc
 * @returns {boolean}
 */
function isPhpDocument(doc) {
  if (!doc) {
    return false;
  }
  return doc.languageId === 'php' || /\.(php|inc|phtml|php5)$/i.test(doc.fileName || '');
}

/**
 * Runs a task per key, but only one at a time. If it is requested while it is running,
 * it runs once more after the end (the saved file could change after the start).
 */
class SingleFlight {
  /**
   * @param {(key: string) => Promise<void>} run
   */
  constructor(run) {
    this.run = run;
    /** @type {Map<string, {running: boolean, dirty: boolean, promise: Promise<void>|null}>} */
    this.state = new Map();
  }

  /**
   * @param {string} key
   * @returns {Promise<void>} resolves when the task is finished and there is no pending rerun
   */
  request(key) {
    let s = this.state.get(key);
    if (!s) {
      s = { running: false, dirty: false, promise: null };
      this.state.set(key, s);
    }

    if (s.running) {
      s.dirty = true;
      return s.promise;
    }

    const state = s;
    state.running = true;
    state.promise = (async () => {
      try {
        do {
          state.dirty = false;
          try {
            await this.run(key);
          } catch (e) {
            // The task reports its errors itself, don't break the loop.
          }
        } while (state.dirty);
      } finally {
        state.running = false;
      }
    })();
    return state.promise;
  }

  isRunning(key) {
    const s = this.state.get(key);
    return !!(s && s.running);
  }
}

module.exports = {
  LEVEL_ERROR,
  LEVEL_WARNING,
  LEVEL_NOTICE,
  LEVEL_SECURITY,
  SingleFlight,
  buildArgs,
  byteOffsetToUtf16,
  findConfig,
  isPhpDocument,
  parseReports,
  resolveExecutable,
  severityOf,
};
