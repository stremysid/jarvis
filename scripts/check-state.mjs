// Keeps the state carriers honest. Run: node scripts/check-state.mjs
// CI runs this in state-carriers; main does not yet require that job.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = new Map();
const CARRIERS = ['docs/STATE.md', 'docs/QUEUE.md', 'docs/OWNER-ACTIONS.md'];
const FACTS = 'docs/FACTS.md';
const STATE_LINE_BUDGET = 150;
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;

function linesOf(text) {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function blank(text) {
  return text.replace(/[^\r\n]/gu, ' ');
}

// Preserve offsets: an annotation must point at the original line, even when
// examples above it contain links that are deliberately not real destinations.
function prose(text, indentedCode = true) {
  let fence;
  let listIndent;
  let code = false;
  return linesOf(text).map((line, index, lines) => {
    const previousBlank = index === 0 || !lines[index - 1].trim();
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return blank(line);
    }
    if (marker) { fence = marker[1]; code = false; return blank(line); }
    if (!line.trim()) return line;
    const indentation = /^[ \t]*/u.exec(line)[0].replaceAll('\t', '    ').length;
    const list = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/u.exec(line);
    if (list) {
      const contentIndent = list[0].replaceAll('\t', '    ').length;
      listIndent = Math.min(listIndent ?? contentIndent, contentIndent);
    } else if (previousBlank && indentation < (listIndent ?? 0)) {
      listIndent = undefined;
    }
    // Four spaces alone can be a list continuation or a paragraph continuation.
    // Hiding either would let a nested bullet conceal a broken link or revision.
    code = indentedCode && !list && listIndent === undefined && indentation >= 4 && (previousBlank || code);
    if (code) return blank(line);
    return line;
  }).join('\n');
}

function withoutInlineCode(text) {
  return text.split(/(\r?\n[ \t]*\r?\n)/u)
    .map((paragraph) => paragraph.replace(/(?<![`\\])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, blank)).join('');
}

function escaped(text, index) {
  return (text.slice(0, index).match(/\\+$/u)?.[0].length ?? 0) % 2 === 1;
}

function cellsOf(line) {
  const visible = withoutInlineCode(line);
  const cells = [];
  let start = 0;
  for (let i = 0; i < visible.length; i++) {
    if (visible[i] === '|' && !escaped(visible, i)) {
      cells.push(line.slice(start, i).trim());
      start = i + 1;
    }
  }
  cells.push(line.slice(start).trim());
  if (visible.trimStart().startsWith('|')) cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

function dateValue(value) {
  const timestamp = Date.parse(value);
  // Date.parse normalizes February 30 and accepts non-ISO prose. Neither is
  // evidence of the calendar date the carrier claims to have recorded.
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
}

function warning(file, line, message) {
  if (!warnings.has(file)) warnings.set(file, []);
  warnings.get(file).push({ line, message });
}

function emitWarnings() {
  for (const [file, rows] of warnings) {
    // A bounded annotation count keeps every affected file visible. Row text
    // stays in prefixed plain log lines so it cannot forge workflow commands.
    console.warn(`::warning file=${file},line=${rows[0].line}::${rows.length} item(s) need re-verification; first affected line ${rows[0].line}.`);
    for (const row of rows) console.log(`  ${file}:${row.line}: ${row.message.replace(/[\r\n]/gu, ' ')}`);
  }
}

const plainCell = (cell) => cell.replace(/[`*_]/gu, '').trim();

function checkFacts(text) {
  const lines = linesOf(prose(text, false));
  const section = lines.findIndex((line) => /^ {0,3}##\s+The register\s*#*\s*$/u.test(line));
  if (section < 0) { failures.push(`${FACTS}: no 'The register' section.`); return; }
  const end = lines.findIndex((line, index) => index > section && /^ {0,3}#{1,2}(?:\s|$)/u.test(line));
  const stop = end < 0 ? lines.length : end;
  let first = section + 1;
  while (first < stop && !lines[first].includes('|')) first++;
  const expected = ['Fact', 'How we know', 'Observed', 'Still true?'];
  const header = cellsOf(lines[first] ?? '');
  const separator = cellsOf(lines[first + 1] ?? '');
  if (header.length !== 4 || header.some((cell, i) => cell !== expected[i]) ||
      separator.length !== 4 || separator.some((cell) => !/^:?-{3,}:?$/u.test(cell))) {
    failures.push(`${FACTS}: the register needs its four-column header and separator.`);
    return;
  }
  let tableEnded = false;
  for (let index = first + 2; index < stop; index++) {
    if (!lines[index].trim()) { tableEnded = true; continue; }
    if (tableEnded) {
      if (/^\s*\|/u.test(lines[index])) failures.push(`${FACTS}:${index + 1}: register row after the table ended. Remove the blank gap or move it to another section.`);
      continue;
    }
    const cells = cellsOf(lines[index]);
    const at = `${FACTS}:${index + 1}`;
    if (cells.length !== 4) { failures.push(`${at}: a register row must have 4 cells, found ${cells.length}.`); continue; }
    const [fact, source, observed, stillTrue] = cells;
    const timestamp = dateValue(observed);
    if (!Number.isFinite(timestamp)) failures.push(`${at}: the Observed cell is not a real YYYY-MM-DD date.`);
    if (timestamp > today + DAY) failures.push(`${at}: the Observed date is more than one UTC day ahead of today.`);
    if (!plainCell(fact)) failures.push(`${at}: the Fact cell is empty.`);
    if (/^(?:TODO|TBD|N\/A|none|[-—–?])?$/iu.test(plainCell(source))) failures.push(`${at}: no source. A placeholder is not evidence.`);
    if (!plainCell(stillTrue).toLowerCase().startsWith('yes') || today - timestamp > 30 * DAY) {
      warning(FACTS, index + 1, `re-verify before relying on it (${observed}): ${fact.slice(0, 70)}`);
    }
  }
}

function destination(text) {
  if (text[0] === '<') return /^<([^>\n]*)>/u.exec(text)?.[1];
  let depth = 0;
  let end = 0;
  for (; end < text.length; end++) {
    const char = text[end];
    if (escaped(text, end)) continue;
    if (char === '(') depth++;
    if (char === ')') { if (depth === 0) break; depth--; }
    if (/\s/u.test(char) && depth === 0) break;
  }
  return text.slice(0, end);
}

const labelKey = (label) => label.trim().replace(/\s+/gu, ' ').toLowerCase();

function bracketLabel(text, start) {
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\n' && /^[ \t]*\r?\n/u.test(text.slice(index + 1))) return;
    if (escaped(text, index)) continue;
    if (text[index] === '[') depth++;
    if (text[index] === ']' && --depth === 0) return { label: text.slice(start + 1, index), end: index };
  }
}

function linksIn(text) {
  const visible = withoutInlineCode(prose(text));
  const definitions = new Map();
  const body = visible.replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.*)$/gmu, (whole, label, value) => {
    // Footnote prose may contain real links, but its first word is not a URL.
    if (label.trim().startsWith('^')) return whole;
    if (!definitions.has(labelKey(label))) definitions.set(labelKey(label), destination(value));
    return blank(whole);
  });
  const links = [];
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== '[' || escaped(body, index)) continue;
    const label = bracketLabel(body, index);
    if (!label) continue;
    const after = label.end + 1;
    const reference = body[after] === '[' ? bracketLabel(body, after) : undefined;
    const target = body[after] === '(' ? destination(body.slice(after + 1).trimStart()) :
      definitions.get(labelKey(reference?.label || label.label));
    if (target !== undefined) links.push({ target, line: body.slice(0, index).split('\n').length });
    index = reference?.end ?? label.end;
  }
  return links;
}

function exactPath(path) {
  // existsSync follows Windows' case folding; GitHub and Linux do not.
  let current = root;
  for (const part of relativePath(root, path).split(/[\\/]/u).filter(Boolean)) {
    if (!readdirSync(current).includes(part)) return false;
    current = join(current, part);
  }
  return true;
}

function anchorsIn(text) {
  const lines = linesOf(prose(text));
  const anchors = new Set();
  for (const [index, line] of lines.entries()) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line)?.[1] ??
      (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/u.test(lines[index + 1]) ? line.trim() : undefined);
    if (heading !== undefined) {
      const base = heading.toLowerCase().replace(/<[^>]*>/gu, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, '').replace(/ /gu, '-');
      let slug = base;
      let suffix = 0;
      while (anchors.has(slug)) slug = `${base}-${++suffix}`;
      anchors.add(slug);
    }
    for (const match of withoutInlineCode(line).matchAll(/<(?:a|[a-z][a-z0-9]*)\b[^>]*\b(?:id|name)=["']([^"']+)["']/giu)) anchors.add(match[1]);
  }
  return anchors;
}

function checkLinks(file, text) {
  for (const { target, line } of linksIn(text)) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('//')) continue;
    const at = `${file}:${line}`;
    try {
      const hash = target.indexOf('#');
      const name = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split('?')[0]).replace(/\\([()])/gu, '$1');
      const anchor = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
      const path = name ? resolve(root, dirname(file), name) : join(root, file);
      if (!existsSync(path) || !exactPath(path)) {
        failures.push(`${at}: link to a file that does not exist with exact case: ${target}`);
        continue;
      }
      if (anchor && /\.md$/iu.test(path) && statSync(path).isFile() && !anchorsIn(readFileSync(path, 'utf8')).has(anchor)) {
        failures.push(`${at}: link to an anchor that does not exist: ${target}`);
      }
    } catch (error) {
      failures.push(`${at}: cannot resolve link ${target} (${error.code ?? error.name}).`);
    }
  }
}

function namesRevision(line) {
  if (!line.includes('origin/main')) return false;
  const urls = [...line.matchAll(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s<>`]+/giu)];
  for (const word of line.matchAll(/\b[0-9a-f]{7,40}\b/gu)) {
    if (/^[0-9]+$/u.test(word[0])) {
      const url = urls.find((url) => word.index >= url.index && word.index < url.index + url[0].length);
      if (url) {
        // Only the immediate actions run path identifies a URL token as a run.
        // A generic URL, query or fragment could otherwise conceal a revision.
        if (/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]+\/(?:[^?#]*\/)?actions\/runs\/$/iu.test(url[0].slice(0, word.index - url.index))) continue;
      } else if (/(?:\brun(?:\s+id)?(?:\s+|:\s*)|\bruns\/|#)[\s`*_]*$/iu.test(line.slice(0, word.index))) continue;
    }
    return true;
  }
  return false;
}

for (const file of [...CARRIERS, FACTS]) {
  const path = join(root, file);
  if (!existsSync(path)) { failures.push(`${file}: missing. The state carriers are not optional.`); continue; }
  const text = readFileSync(path, 'utf8');
  const lines = linesOf(text);
  checkLinks(file, text);
  if (file === FACTS) { checkFacts(text); continue; }

  const visibleLines = linesOf(prose(text));
  const generatedLine = visibleLines.findIndex((line) => /^Last regenerated:/u.test(line));
  const generated = /^Last regenerated:\s*(\d{4}-\d{2}-\d{2})(?=[\s,.]|$)/u.exec(visibleLines[generatedLine] ?? '')?.[1];
  const timestamp = dateValue(generated ?? '');
  if (!Number.isFinite(timestamp)) failures.push(`${file}: no real "Last regenerated: YYYY-MM-DD" date. An undated state file is a rumour.`);
  else if (today - timestamp > 30 * DAY) warning(file, generatedLine + 1, `Last regenerated ${generated}; re-verify this carrier.`);
  if (timestamp > today + DAY) failures.push(`${file}:${generatedLine + 1}: Last regenerated date is more than one UTC day ahead of today.`);

  if (file === 'docs/STATE.md') {
    if (lines.length > STATE_LINE_BUDGET) failures.push(`${file}: ${lines.length} lines, budget is ${STATE_LINE_BUDGET}. State that does not fit is not state.`);
    // Keep main's lowercase, whole-line rule. Only a marked decimal run ID is
    // exempt: neither a run label nor a URL must hide a revision beside it.
    visibleLines.forEach((line, index) => {
      if (namesRevision(line)) {
        failures.push(`${file}:${index + 1}: names origin/main and a literal sha. Query it instead.`);
      }
    });
  }
  if (file === 'docs/QUEUE.md' && !/\|\s*BLOCKS\s*\|/u.test(prose(text))) failures.push(`${file}: no BLOCKS column. Without it the priority rule stops being mechanical.`);
}

emitWarnings();
if (failures.length > 0) {
  console.error(`state check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`state check passed: ${CARRIERS.length} carriers and FACTS register, STATE.md within budget, local Markdown links resolve, BLOCKS present; ${warnings.size} warning(s).`);
