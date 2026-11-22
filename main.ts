// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a line break (SPEC.md section 3). */
interface FileModel {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Leading spaces and tabs of a line. */
function leadingWS(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function stripTrailing(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function stripBoth(s: string): string {
  return stripTrailing(s).replace(/^[ \t]+/, '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, for the `R <old> -> <new>` output lines (SPEC.md section 2). */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

function matchAt(lines: string[], O: string[], pos: number, tier: number): boolean {
  for (let k = 0; k < O.length; k++) {
    const a = lines[pos + k]!;
    const b = O[k]!;
    if (tier === 0) {
      if (a !== b) return false;
    } else if (tier === 1) {
      if (stripTrailing(a) !== stripTrailing(b)) return false;
    } else if (stripBoth(a) !== stripBoth(b)) return false;
  }
  return true;
}

/** The first tier at which O occurs at least once, with every occurrence position. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = 0; i + O.length <= lines.length; i++) {
      if (matchAt(lines, O, i, t)) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (matchAt(lines, [anchor], i, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one. */
function findOccurrence(lines: string[], O: string[], from: number, eof: boolean, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i + O.length <= lines.length; i++) {
      if (eof && i + O.length !== lines.length) continue;
      if (matchAt(lines, O, i, t)) return { tier: t, pos: i };
    }
  }
  return null;
}

/**
 * Replace the k matched lines at `pos` with N. Context lines (nCtx[j] is the line's index in O)
 * are written as the file's own matched line; at tier 2 every other line of N is re-indented.
 */
function applyReplacement(lines: string[], pos: number, O: string[], N: string[], nCtx: (number | null)[], tier: number): string[] {
  const F = leadingWS(lines[pos] ?? '');
  const P = leadingWS(O[0] ?? '');
  const rep: string[] = [];
  for (let j = 0; j < N.length; j++) {
    const ci = nCtx[j];
    if (ci !== null && ci !== undefined) {
      rep.push(lines[pos + ci]!);
    } else {
      const line = N[j]!;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) rep.push(F + line.slice(P.length));
      else rep.push(line);
    }
  }
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos + O.length)];
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits.                                              */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  O: string[];
  N: string[];
  nCtx: (number | null)[];
  noFinal: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string | null, diffNew: string | null): Section {
  return { diffOld, diffNew, oldPath: null, newPath: null, newFile: false, deletedFile: false, hunks: [] };
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new Exit2(`error: parse ${idx + 1}`);
  return parseInt(m[1]!, 10);
}

function deriveHunk(a: number, body: BodyLine[]): Hunk {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      nCtx.push(null);
      N.push(b.text);
    }
  }
  let noFinal = false;
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') {
      noFinal = body[j + 1]?.kind === 'bs';
      break;
    }
  }
  return { a, body, O, N, nCtx, noFinal };
}

/** A hunk's body, starting at `start`; returns the hunk and the index after the body. */
function parseHunkBody(lines: string[], start: number, a: number): [Hunk, number] {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith(' ')) {
      body.push({ kind: 'ctx', text: line.slice(1) });
      i++;
    } else if (line.startsWith('-')) {
      body.push({ kind: 'old', text: line.slice(1) });
      i++;
    } else if (line.startsWith('+')) {
      body.push({ kind: 'new', text: line.slice(1) });
      i++;
    } else if (line.startsWith('\\')) {
      body.push({ kind: 'bs', text: line.slice(1) });
      i++;
    } else if (line === '') {
      body.push({ kind: 'ctx', text: '' });
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return [deriveHunk(a, body), i];
}

/** Apply one unified hunk to the model; returns the updated offset d. */
function applyUnifiedHunk(model: FileModel, h: Hunk, strict: boolean, path: string, d: number): number {
  if (h.O.length === 0) {
    const idx = Math.min(Math.max(h.a + d, 0), model.lines.length);
    const atEnd = idx === model.lines.length;
    model.lines.splice(idx, 0, ...h.N);
    if (atEnd) model.final = !h.noFinal;
    return d + h.N.length;
  }
  const found = findTier(model.lines, h.O, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const atEnd = best + h.O.length === model.lines.length;
  model.lines = applyReplacement(model.lines, best, h.O, h.N, h.nCtx, found.tier);
  if (atEnd) model.final = !h.noFinal;
  return d + (h.N.length - h.O.length);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.oldPath ?? sec.diffOld ?? '';
  const newP = sec.newPath ?? sec.diffNew ?? '';
  const isCreation = oldP === '/dev/null' || sec.newFile;
  const isDeletion = !isCreation && (newP === '/dev/null' || sec.deletedFile);
  return (tree) => {
    if (isCreation) {
      if (newP === '/dev/null') throw new Fail('unsafe', newP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (oldP !== '/dev/null' && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') out.push(b.text);
        }
      }
      let final = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let j = body.length - 1; j >= 0; j--) {
          if (body[j]!.kind === 'new') {
            final = body[j + 1]?.kind !== 'bs';
            break outer;
          }
        }
      }
      tree.now.set(newP, renderFile({ br: '\n', lines: out, final }));
      return;
    }
    if (isDeletion) {
      if (oldP === '/dev/null') throw new Fail('unsafe', oldP);
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== '/dev/null' && !safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const isMove = oldP !== newP;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      d = applyUnifiedHunk(model, h, strict, oldP, d);
    }
    const text = renderFile(model);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'top' | 'header' | 'between' = 'top';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (state === 'top') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection(null, null);
        sections.push(cur);
        cur.oldPath = stripAB(headerPath(line));
        cur.newPath = stripAB(headerPath(lines[i + 1]!));
        i += 2;
        state = 'header';
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const [hunk, ni] = parseHunkBody(lines, i + 1, a);
        cur!.hunks.push(hunk);
        i = ni;
        state = 'between';
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.oldPath = stripAB(headerPath(line));
          cur!.newPath = stripAB(headerPath(lines[i + 1]!));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (cur!.oldPath === null) cur!.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur!.newPath === null) cur!.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // state === 'between'
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i);
      const [hunk, ni] = parseHunkBody(lines, i + 1, a);
      cur!.hunks.push(hunk);
      i = ni;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection(null, null);
      sections.push(cur);
      cur.oldPath = stripAB(headerPath(line));
      cur.newPath = stripAB(headerPath(lines[i + 1]!));
      i += 2;
      state = 'header';
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderFile({ br: '\n', lines: [...newLines], final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    model.lines = applyReplacement(model.lines, pos, oldLines, newLines, newLines.map(() => null), found.tier);
    tree.now.set(path, renderFile(model));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= blockEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    blockEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function vBody(body: BodyLine[]): { O: string[]; N: string[]; nCtx: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      nCtx.push(null);
      N.push(b.text);
    }
  }
  return { O, N, nCtx };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, renderFile({ br: '\n', lines: [...fileLines], final: true }));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(model.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N, nCtx } = vBody(ch.body);
      if (O.length === 0) {
        const idx = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(idx, 0, ...N);
        cursor = idx + N.length;
      } else {
        const found = findOccurrence(model.lines, O, cursor, ch.eof, strict);
        if (!found) throw new Fail('no-match', path);
        model.lines = applyReplacement(model.lines, found.pos, O, N, nCtx, found.tier);
        cursor = found.pos + N.length;
      }
    }
    const text = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/** A section's lines, from `start` to the next section start or `last` (the End Patch line). */
function collectV4aSection(lines: string[], start: number, last: number): { content: { text: string; idx: number }[]; next: number } {
  const content: { text: string; idx: number }[] = [];
  let i = start;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    content.push({ text: l, idx: i });
    i++;
  }
  while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
  return { content, next: i };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { content, next } = collectV4aSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const cl of content) {
        if (cl.text.startsWith('+')) fileLines.push(cl.text.slice(1));
        else if (blank(cl.text)) fileLines.push('');
        else throw new Exit2(`error: parse ${cl.idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const { content, next } = collectV4aSection(lines, i + 1, last);
      for (const cl of content) {
        if (!blank(cl.text)) throw new Exit2(`error: parse ${cl.idx + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateIdx = i;
      const path = line.slice('*** Update File: '.length).trim();
      const { content, next } = collectV4aSection(lines, i + 1, last);
      let moveTo: string | null = null;
      let j = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
        moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      const flush = (): void => {
        if (cur) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < content.length) {
        const { text, idx: li } = content[j]!;
        if (text.startsWith('@@')) {
          flush();
          const a = text.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          started = true;
          j++;
          continue;
        }
        if (text === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${li + 1}`);
          cur.eof = true;
          flush();
          j++;
          continue;
        }
        if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
          if (!cur) {
            if (started) throw new Exit2(`error: parse ${li + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          const kind: BodyLine['kind'] = text === '' ? 'ctx' : text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'old' : 'new';
          cur.body.push({ kind, text: text === '' ? '' : text.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${li + 1}`);
      }
      flush();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the patch (SPEC.md sections 1, 2, 10).                      */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const suppressed = new Set<string>();
  const rows: { sortKey: string; line: string }[] = [];
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.get(m.old);
    const newWas = tree.original(m.new);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      suppressed.add(m.old);
      suppressed.add(m.new);
      rows.push({ sortKey: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
