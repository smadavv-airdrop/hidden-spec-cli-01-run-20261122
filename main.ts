// main.ts is mend, the CLI SPEC.md specifies (MIT).
// Implements sections 1 to 10 of SPEC.md: the command line, output and exit codes, safe paths, format
// detection, the three line-matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON
// edits and the all-or-nothing write. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below).

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

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its own line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return f.final ? f.br : '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

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

/* ---------- section 5: matching lines ---------- */

const rtrim = (s: string): string => s.replace(/[ \t]+$/, '');
const btrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrim(a) === rtrim(b);
  return btrim(a) === btrim(b);
}

function findOcc(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!eqTier(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** first tier at which O occurs at or after `from`, and the first such occurrence */
function matchTier(O: string[], lines: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; at: number } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const hits: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!eqTier(O[j]!, lines[i + j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    if (eofOnly) {
      const last = hits.filter((i) => i + O.length === lines.length);
      if (last.length > 0) return { tier, at: last[0]! };
    } else if (hits.length > 0) return { tier, at: hits[0]! };
  }
  return null;
}

/** one body line: a context line (both sides), an old line (O only) or a new line (N only) */
interface BLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noEol: boolean;
}

function splitON(body: BLine[]): { O: string[]; N: Array<{ kind: 'ctx' | 'new'; text: string; ctxIdx: number }> } {
  const O: string[] = [];
  const N: Array<{ kind: 'ctx' | 'new'; text: string; ctxIdx: number }> = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ kind: 'ctx', text: b.text, ctxIdx: O.length - 1 });
    } else if (b.kind === 'old') O.push(b.text);
    else N.push({ kind: 'new', text: b.text, ctxIdx: -1 });
  }
  return { O, N };
}

/** at tier 2 the non-context lines of N are re-indented from P to F; context lines are the file's own */
function renderN(N: Array<{ kind: 'ctx' | 'new'; text: string; ctxIdx: number }>, fileLines: string[], start: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  let F: string | null = null;
  let P: string | null = null;
  if (tier === 2 && O.length > 0) {
    F = lead(fileLines[start] ?? '');
    P = lead(O[0]!);
  }
  for (const n of N) {
    if (n.kind === 'ctx') {
      out.push(fileLines[start + n.ctxIdx] ?? n.text);
      continue;
    }
    let t = n.text;
    if (tier === 2 && F !== null && P !== null && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

function lastLineNoEol(body: BLine[]): boolean {
  if (body.length === 0) return false;
  return body[body.length - 1]!.noEol;
}

/** the hunks of a section, in order, each to the result of the ones before it */
function applyHunks(f: FileState, bodies: BLine[][], anchors: number[], path: string, strict: boolean): FileState {
  let d = 0;
  let out: FileState = { lines: f.lines.slice(), br: f.br, final: f.final };
  for (let h = 0; h < bodies.length; h++) {
    const b = bodies[h]!;
    const A = anchors[h]!;
    const { O, N } = splitON(b);
    if (O.length === 0) {
      let idx = A + d;
      if (idx < 0) idx = 0;
      if (idx > out.lines.length) idx = out.lines.length;
      const ins = renderN(N, out.lines, idx, O, 0);
      const atEnd = idx === out.lines.length;
      out = {
        lines: [...out.lines.slice(0, idx), ...ins, ...out.lines.slice(idx)],
        br: out.br,
        final: atEnd ? !lastLineNoEol(b) : out.final,
      };
      d += N.length;
      continue;
    }
    const maxTier = strict ? 0 : 2;
    let chosen: { tier: number; at: number } | null = null;
    for (let tier = 0; tier <= maxTier && chosen === null; tier++) {
      const occ = findOcc(O, out.lines, tier);
      if (occ.length === 0) continue;
      const target = A - 1 + d;
      let best = occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const o of occ) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) {
          best = o;
          bestDist = dist;
        }
      }
      chosen = { tier, at: best };
    }
    if (chosen === null) throw new Fail('no-match', path);
    const start = chosen.at;
    const matchedEnd = start + O.length;
    const atEnd = matchedEnd === out.lines.length;
    const ins = renderN(N, out.lines, start, O, chosen.tier);
    out = {
      lines: [...out.lines.slice(0, start), ...ins, ...out.lines.slice(matchedEnd)],
      br: out.br,
      final: atEnd ? !lastLineNoEol(b) : out.final,
    };
    d += N.length - O.length;
  }
  return out;
}

/* ---------- section 6: unified diffs ---------- */

interface USection {
  gitOld?: string | null;
  gitNew?: string | null;
  oldPath?: string | null;
  newPath?: string | null;
  create: boolean;
  del: boolean;
  moveFrom?: string;
  moveTo?: string;
  line: number;
  anchors: number[];
  bodies: BLine[][];
}

function normPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseBody(lines: string[], from: number): { body: BLine[]; next: number } {
  const raw: BLine[] = [];
  let i = from;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      raw.push({ kind: 'ctx', text: '', noEol: false });
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') raw.push({ kind: 'ctx', text: l.slice(1), noEol: false });
    else if (c === '-') raw.push({ kind: 'old', text: l.slice(1), noEol: false });
    else if (c === '+') raw.push({ kind: 'new', text: l.slice(1), noEol: false });
    else if (c === '\\') {
      if (raw.length > 0) raw[raw.length - 1]!.noEol = true;
      i++;
      continue;
    } else break;
    i++;
  }
  let end = raw.length;
  while (end > 0 && raw[end - 1]!.kind === 'ctx' && raw[end - 1]!.text === '' && !raw[end - 1]!.noEol) end--;
  return { body: raw.slice(0, end), next: i };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let headerDone = false;
  const newSection = (line: number): USection => ({ create: false, del: false, line, anchors: [], bodies: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      const at = rest.indexOf(' b/');
      if (!rest.startsWith('a/') || at <= 2) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(i + 1);
      cur.gitOld = rest.slice(2, at);
      cur.gitNew = rest.slice(at + 3);
      sections.push(cur);
      headerDone = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || headerDone) {
        cur = newSection(i + 1);
        sections.push(cur);
        headerDone = false;
      }
      cur.oldPath = normPath(l.slice(4));
      cur.newPath = normPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      headerDone = true;
      cur.anchors.push(Number(m[1]));
      const b = parseBody(lines, i + 1);
      cur.bodies.push(b.body);
      i = b.next;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (l.startsWith('rename from ')) cur.moveFrom = normPath(l.slice('rename from '.length)) ?? undefined;
      else if (l.startsWith('rename to ')) cur.moveTo = normPath(l.slice('rename to '.length)) ?? undefined;
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

function makeUnifiedEdit(s: USection, strict: boolean): Edit {
  return (tree, moves) => {
    const oldP: string | null = s.oldPath !== undefined ? s.oldPath : s.moveFrom !== undefined ? s.moveFrom : s.gitOld !== undefined ? s.gitOld : null;
    const newP: string | null = s.newPath !== undefined ? s.newPath : s.moveTo !== undefined ? s.moveTo : s.gitNew !== undefined ? s.gitNew : null;
    const creation = s.create || s.oldPath === null;
    const deletion = !creation && (s.del || s.newPath === null);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (creation) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const lines: string[] = [];
      let noEol = false;
      for (const b of s.bodies) for (const bl of b) if (bl.kind === 'new') lines.push(bl.text);
      if (s.bodies.length > 0) noEol = lastLineNoEol(s.bodies[s.bodies.length - 1]!);
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (oldP === null) throw new Fail('unsafe', '');
    if (deletion) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (newP === null) throw new Fail('unsafe', '');
    const was = tree.get(oldP);
    if (was === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const out = applyHunks(splitFile(was), s.bodies, s.anchors, oldP, strict);
    const next = joinFile(out);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, next);
      moves.push([oldP, newP]);
    } else tree.now.set(oldP, next);
  };
}

/* ---------- section 7: SEARCH/REPLACE blocks ---------- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let sep = -1;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (sep < 0 && t === '=======') {
        sep = j;
        continue;
      }
      if (sep >= 0 && t === '>>>>>>> REPLACE') {
        close = j;
        break;
      }
    }
    if (sep < 0 || close < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let k = searchLine - 1; k >= lastEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    const p = path;
    const olds = lines.slice(searchLine + 1, sep);
    const news = lines.slice(sep + 1, close);
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (olds.length === 0) {
        if (cur !== null) throw new Fail('exists', p);
        tree.now.set(p, news.length === 0 ? '' : news.join('\n') + '\n');
        return;
      }
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const hit = matchTier(olds, f.lines, strict);
      if (hit === null) throw new Fail('no-match', p);
      if (findOcc(olds, f.lines, hit.tier).length !== 1) throw new Fail('ambiguous', p);
      const start = hit.at;
      const N = news.map((t) => ({ kind: 'new' as const, text: t, ctxIdx: -1 }));
      const ins = renderN(N, f.lines, start, olds, hit.tier);
      const lines2 = [...f.lines.slice(0, start), ...ins, ...f.lines.slice(start + olds.length)];
      tree.now.set(p, joinFile({ lines: lines2, br: f.br, final: f.final }));
    });
    lastEnd = close + 1;
    i = close + 1;
  }
  return edits;
}

/* ---------- section 8: V4A patches ---------- */

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  at: number;
  moveTo?: string;
  lines: string[];
  chunks: Array<{ anchor: string | null; eof: boolean; body: BLine[] }>;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: { anchor: string | null; eof: boolean; body: BLine[] } | null = null;
  let sawChunk = false;
  let sawMove = false;
  let i = firstIdx + 1;
  /** hand the open chunk to its section and check the section had something */
  const closeSection = (): void => {
    if (cur === null) return;
    const sec: VSection = cur;
    if (chunk !== null) {
      sec.chunks.push(trimBlank(chunk));
      chunk = null;
    }
    if (sec.kind === 'update' && !sawChunk && !sawMove) throw new Exit2(`error: parse ${sec.at}`);
    if (sec.kind === 'add') {
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    }
  };
  while (i < lastIdx) {
    const l = lines[i]!;
    const startSection = (kind: 'add' | 'delete' | 'update', path: string): void => {
      closeSection();
      cur = { kind, path, at: i + 1, lines: [], chunks: [] };
      sections.push(cur);
      chunk = null;
      sawChunk = false;
      sawMove = false;
    };
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      if (l.startsWith('*** Add File: ')) startSection('add', l.slice('*** Add File: '.length).trim());
      else if (l.startsWith('*** Delete File: ')) startSection('delete', l.slice('*** Delete File: '.length).trim());
      else startSection('update', l.slice('*** Update File: '.length).trim());
      i++;
      continue;
    }
    if (blank(l)) {
      // an empty line of an Add File section, an empty context line of a chunk, else ignored
      if (cur === null || cur.kind === 'delete') {
        i++;
        continue;
      }
      if (cur.kind === 'add') cur.lines.push('');
      else if (chunk !== null) chunk.body.push({ kind: 'ctx', text: '', noEol: false });
      i++;
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = cur;
    if (sec.kind === 'add') {
      if (l.startsWith('+')) sec.lines.push(l.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (sec.kind === 'delete') throw new Exit2(`error: parse ${i + 1}`);
    if (!sawChunk && !sawMove && l.startsWith('*** Move to: ')) {
      sec.moveTo = l.slice('*** Move to: '.length).trim();
      sawMove = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (chunk !== null) sec.chunks.push(trimBlank(chunk));
      const anchor = l.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      sawChunk = true;
      i++;
      continue;
    }
    if (l.startsWith('*** End of File')) {
      if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
      chunk.eof = true;
      sawChunk = true;
      sec.chunks.push(trimBlank(chunk));
      chunk = null;
      i++;
      continue;
    }
    if (chunk === null) {
      chunk = { anchor: null, eof: false, body: [] };
      sawChunk = true;
    }
    if (l === '') chunk.body.push({ kind: 'ctx', text: '', noEol: false });
    else if (l[0] === ' ') chunk.body.push({ kind: 'ctx', text: l.slice(1), noEol: false });
    else if (l[0] === '-') chunk.body.push({ kind: 'old', text: l.slice(1), noEol: false });
    else if (l[0] === '+') chunk.body.push({ kind: 'new', text: l.slice(1), noEol: false });
    else throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  closeSection();
  return sections.map((s) => makeV4AEdit(s, strict));
}

/** blank lines at the end of a chunk are not part of it */
function trimBlank(c: { anchor: string | null; eof: boolean; body: BLine[] }): { anchor: string | null; eof: boolean; body: BLine[] } {
  const body = c.body.slice();
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '' && !body[body.length - 1]!.noEol) body.pop();
  return { anchor: c.anchor, eof: c.eof, body };
}

function makeV4AEdit(s: VSection, strict: boolean): Edit {
  const p = s.path;
  if (s.kind === 'add') {
    const body = s.lines;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, body.length === 0 ? '' : body.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const moveTo = s.moveTo;
  return (tree, moves) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const was = tree.get(p);
    if (was === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(was);
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const found = matchTier([c.anchor], f.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.at + 1;
      }
      const { O, N } = splitON(c.body);
      if (O.length === 0) {
        const idx = c.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const ins = renderN(N, f.lines, idx, O, 0);
        f = { lines: [...f.lines.slice(0, idx), ...ins, ...f.lines.slice(idx)], br: f.br, final: f.final };
        cursor = idx + N.length;
        continue;
      }
      const hit = matchTier(O, f.lines, strict, cursor, c.eof);
      if (hit === null) throw new Fail('no-match', p);
      const start = hit.at;
      const ins = renderN(N, f.lines, start, O, hit.tier);
      f = { lines: [...f.lines.slice(0, start), ...ins, ...f.lines.slice(start + O.length)], br: f.br, final: f.final };
      cursor = start + N.length;
    }
    const next = joinFile(f);
    if (moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(moveTo, next);
      moves.push([p, moveTo]);
    } else tree.now.set(p, next);
  };
}

/* ---------- section 9: JSON edits ---------- */

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

/* ---------- driver: sections 1, 2 and 10 ---------- */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'v4a') edits = parseV4A(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseUnified(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.slice();
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = 0;
      moves.push(...movesBefore);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveTargets = new Map<string, string>();
  const moveSources = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(n) !== null) {
      moveTargets.set(n, o);
      moveSources.add(o);
    }
  }
  const rows: Array<{ sort: string; text: string }> = [];
  const paths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of paths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) {
      if (moveSources.has(p)) continue;
      rows.push({ sort: p, text: `D ${p}` });
      continue;
    }
    if (moveTargets.has(p)) {
      rows.push({ sort: p, text: `R ${moveTargets.get(p)} -> ${p}` });
      continue;
    }
    rows.push({ sort: p, text: `${was === null ? 'A' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  if (!check) {
    for (const p of paths) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
