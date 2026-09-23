import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const date = '2026-09-23';
const state = `# State\nLast regenerated: ${date}\n`;
const header = '# Facts\n\n## The register\n\n| Fact | How we know | Observed | Still true? |\n|---|---|---|---|\n';
const row = (fact = 'A durable fact', source = 'A direct observation', observed = date, stillTrue = 'yes') =>
  `| ${fact} | ${source} | ${observed} | ${stillTrue} |\n`;
const fact = (value) => ({ 'docs/FACTS.md': header + value });

function run(changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-check-state-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../check-state.mjs', import.meta.url), join(root, 'scripts/check-state.mjs'));
    const files = {
      'docs/STATE.md': state,
      'docs/QUEUE.md': `# Queue\nLast regenerated: ${date}\n\n| Item | BLOCKS |\n|---|---|\n`,
      'docs/OWNER-ACTIONS.md': `# Owner actions\nLast regenerated: ${date}\n`,
      'docs/FACTS.md': header + row(),
      'docs/Target.md': '# Target\n\n## Ready\n',
      'clock.mjs': `Date.now = () => Date.parse('${date}T12:00:00Z');\n`,
      ...changes,
    };
    for (const [relative, text] of Object.entries(files)) {
      if (text === null) continue;
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'clock.mjs')).href,
      join(root, 'scripts/check-state.mjs')], { cwd: tmpdir(), encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    // A test must never remove a caller's directory if its temporary root changes.
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

const regressions = [
  ['rejects a three-cell fact row instead of silently dropping it', fact('| Fact without status | Source | 2026-09-23 |\n'), 1, /FACTS\.md/],
  ['checks an indented fact row for a missing source', fact('  ' + row('Indented fact', '')), 1, /source/],
  ['rejects an impossible observation date', fact(row('Recorded fact', 'Source', '2026-13-45')), 1, /Observed cell is not a real YYYY-MM-DD date/],
  ['rejects TODO as a fact source', fact(row('Recorded fact', 'TODO')), 1, /source/],
  ['rejects a dash as a fact source', fact(row('Recorded fact', '-')), 1, /source/],
  ['annotates an old fact as a warning without failing the check', fact(row('Old fact', 'Source', '2026-08-01')), 0, /::warning file=docs\/FACTS\.md,line=7::.*re-verify/],
  ['lists an unset Still true cell as a warning', fact(row('Unset fact', 'Source', date, '')), 0, /::warning .*Unset fact/],
  ['lists a no Still true cell as a warning', fact(row('Retired fact', 'Source', date, 'no')), 0, /::warning .*Retired fact/],
  ['warns when a carrier was last regenerated more than thirty days ago', { 'docs/STATE.md': state.replace(date, '2026-08-01') }, 0, /::warning file=docs\/STATE\.md,line=2::.*regenerated/],
  ['accepts a backticked pipe inside a fact cell', fact(row('The value is `left|right`')), 0],
  ['leaves a table after the register to its own section', fact(row() + '\n## Other material\n\n| A | B | C | D |\n|---|---|---|---|\n| a | b | c | d |\n'), 0],
  ['allows a CI run id beside origin main', { 'docs/STATE.md': state + 'CI run 35532044202 checked `origin/main`.\n' }, 0],
  ['ignores link syntax inside inline code', { 'docs/STATE.md': state + '`[example](missing.md)`\n' }, 0],
  ['counts a terminal newline as the end of line one hundred fifty', { 'docs/STATE.md': state + '\n'.repeat(148) }, 0],
  ['checks links in the facts register', fact(row('[missing](Missing.md)')), 1, /Missing\.md/],
  ['rejects an absent same-file anchor', { 'docs/STATE.md': state + '[missing](#absent)\n' }, 1, /absent/],
  ['rejects an absent anchor in an existing file', { 'docs/STATE.md': state + '[missing](Target.md#absent)\n' }, 1, /absent/],
  ['checks a reference-style link destination', { 'docs/STATE.md': state + '[missing][ref]\n\n[ref]: Missing.md\n' }, 1, /Missing\.md/],
  ['checks an angle-wrapped destination containing spaces', { 'docs/STATE.md': state + '[missing](<Missing document.md>)\n' }, 1, /Missing document\.md/],
  ['rejects a wrong-case path even on Windows', { 'docs/STATE.md': state + '[target](target.md)\n' }, 1, /target\.md/],
];

for (const [name, changes, status, pattern] of regressions) {
  test(name, () => {
    const result = run(changes);
    assert.equal(result.status, status, result.output);
    if (pattern) assert.match(result.output, pattern);
  });
}

test('accepts the unchanged valid fixture without warnings', () => {
  const result = run();
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /::warning|re-verify/);
});

test('rejects a genuinely over-budget state file', () => {
  const result = run({ 'docs/STATE.md': state + '\n'.repeat(149) });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /151 lines, budget is 150/);
});

test('rejects an explicit current revision including an all-digit sha', () => {
  for (const line of ['`origin/main` = `abcdef1`', 'origin/main is 1234567', 'origin/main: abcdef1', 'origin/main is at abcdef1', 'origin/main abcdef1', '`abcdef1` = `origin/main`']) {
    const result = run({ 'docs/STATE.md': state + line + '\n' });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /literal sha/);
  }
});

test('rejects an observation date that overflows February', () => {
  const result = run(fact(row('Recorded fact', 'Source', '2026-02-30')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /date/);
});

test('rejects a malformed regeneration date', () => {
  const result = run({ 'docs/STATE.md': state.replace(date, '2026-13-45') });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /date/);
});

test('does not warn until a date is more than thirty calendar days old', () => {
  const result = run({ ...fact(row('Recorded fact', 'Source', '2026-08-24')), 'docs/STATE.md': state.replace(date, '2026-08-24') });
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /::warning|re-verify/);
});

test('warns for unknown and unconfirmed facts', () => {
  for (const status of ['unknown', 'unconfirmed', '-', 'No longer true', '**no**']) {
    const result = run(fact(row('Check this fact', 'Source', date, status)));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /::warning .*Check this fact/);
  }
});

test('rejects a missing register table or a changed register header', () => {
  for (const text of ['# Facts\n', '# Facts\n## The register\n', header.replace('Observed', 'Other') + row()]) {
    const result = run({ 'docs/FACTS.md': text });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /register/);
  }
});

test('rejects a fifth fact cell instead of discarding its evidence', () => {
  const result = run(fact(row().trimEnd() + ' extra |\n'));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /4 cells/);
});

test('accepts escaped pipes and multiple-backtick code spans', () => {
  const result = run(fact(row('A \\| value and ``code ` with | pipe``')));
  assert.equal(result.status, 0, result.output);
});

test('ignores code fences and indented code when checking links', () => {
  const result = run({ 'docs/STATE.md': state + '\n```md\n[example](missing.md)\n```\n\n~~~md\n[example](another.md)\n~~~\n\n    [example](also-missing.md)\n' });
  assert.equal(result.status, 0, result.output);
});

test('accepts real anchors and spaced paths with optional link titles', () => {
  const result = run({
    'docs/STATE.md': state + '[self](#state) [other](Target.md#ready) [space](<A document.md> "title") [title](Target.md "title")\n',
    'docs/A document.md': '# A document\n',
  });
  assert.equal(result.status, 0, result.output);
});

test('accepts full collapsed and shortcut reference links', () => {
  const result = run({ 'docs/STATE.md': state + '[one][Ref] [ref][] [ref]\n\n[ref]: Target.md#ready "title"\n' });
  assert.equal(result.status, 0, result.output);
});

test('checks collapsed and shortcut reference link destinations', () => {
  for (const use of ['[ref][]', '[ref]']) {
    const result = run({ 'docs/STATE.md': state + use + '\n\n[ref]: Missing.md\n' });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Missing\.md/);
  }
});

test('checks path casing in every directory component', () => {
  const result = run({ 'docs/STATE.md': state + '[target](nested/Target.md)\n', 'docs/Nested/Target.md': '# Target\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /nested\/Target\.md/);
});

test('checks percent-encoded paths and balanced parentheses', () => {
  const result = run({ 'docs/STATE.md': state + '[space](A%20document.md) [paren](A(1).md)\n',
    'docs/A document.md': '# Space\n', 'docs/A(1).md': '# Parentheses\n' });
  assert.equal(result.status, 0, result.output);
});

test('retains missing-carrier and missing-BLOCKS failures', () => {
  for (const relative of ['docs/STATE.md', 'docs/QUEUE.md', 'docs/OWNER-ACTIONS.md', 'docs/FACTS.md']) {
    const result = run({ [relative]: null });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /missing/);
  }
  const result = run({ 'docs/QUEUE.md': `# Queue\nLast regenerated: ${date}\n` });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /BLOCKS/);
});

test('stops the register at the next section even without a blank line', () => {
  const result = run(fact(row() + '## Other material\n| a | b | c | d |\n'));
  assert.equal(result.status, 0, result.output);
});

test('does not borrow a register table from a later section', () => {
  const result = run({ 'docs/FACTS.md': '# Facts\n## The register\n\n## Later\n' + header.split('\n').slice(4).join('\n') + row() });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /register/);
});

test('rejects a missing table separator', () => {
  const result = run({ 'docs/FACTS.md': header.replace('|---|---|---|---|', '| x | y | z | w |') + row() });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /register/);
});

test('checks a fact named Fact and a row without outer pipes', () => {
  for (const value of [row('Fact', 'TODO'), 'Recorded fact | TODO | 2026-09-23 | yes\n']) {
    const result = run(fact(value));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /source/);
  }
});

test('does not manufacture a header from a code example', () => {
  const result = run({ 'docs/FACTS.md': '```md\n' + header + row() + '```\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /register/);
});

test('rejects a non-ISO observation date', () => {
  const result = run(fact(row('Recorded fact', 'Source', 'September 23, 2026')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /date/);
});

test('escapes percent sequences in warning annotations', () => {
  const result = run(fact(row('Value %0A::error::forged', 'Source', date, 'unknown')));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Value %250A::error::forged/);
});

test('checks real links following a closed fence', () => {
  const result = run({ 'docs/STATE.md': state + '~~~md\n[ignored](ignore.md)\n~~~\n[real](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
  assert.doesNotMatch(result.output, /ignore\.md/);
});

test('ignores escaped links and external URLs', () => {
  const result = run({ 'docs/STATE.md': state + '\\[literal](missing.md) [web](https://example.invalid/missing) [cdn](//example.invalid/missing) [ordinary brackets]\n' });
  assert.equal(result.status, 0, result.output);
});

test('uses the first reference definition and normalizes its label', () => {
  const result = run({ 'docs/STATE.md': state + '[a][  A   Ref  ]\n\n[a ref]: Target.md\n[A REF]: Missing.md\n' });
  assert.equal(result.status, 0, result.output);
});

test('accepts duplicate headings setext headings and explicit HTML anchors', () => {
  const result = run({
    'docs/STATE.md': state + '[one](Target.md#ready-1) [two](Target.md#underlined) [three](Target.md#custom)\n',
    'docs/Target.md': '# Target\n## Ready\n## Ready\n\nUnderlined\n----------\n\n<a id="custom"></a>\n',
  });
  assert.equal(result.status, 0, result.output);
});

test('does not create anchors from code examples', () => {
  const result = run({ 'docs/STATE.md': state + '[example](Target.md#pretend)\n', 'docs/Target.md': '```md\n## Pretend\n```\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anchor/);
});

test('reports malformed URL escapes as link failures', () => {
  const result = run({ 'docs/STATE.md': state + '[bad](bad%ZZ.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /cannot resolve link/);
});

test('rejects a missing regeneration stamp', () => {
  const result = run({ 'docs/STATE.md': '# State\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Last regenerated/);
});

test('rejects a revision immediately after origin main', () => {
  const result = run({ 'docs/STATE.md': state + '`origin/main` `abcdef1`\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /literal sha/);
});

test('does not create an HTML anchor from inline code', () => {
  const result = run({ 'docs/STATE.md': state + '[bad](Target.md#fake)\n', 'docs/Target.md': '`<a id="fake"></a>`\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /anchor/);
});

test('rejects a site-root link that does not name a repository file', () => {
  const result = run({ 'docs/STATE.md': state + '[target](/docs/Target.md#ready)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /does not exist with exact case/);
});

test('accepts escaped parentheses in destinations', () => {
  const result = run({ 'docs/STATE.md': state + '[target](A\\(1\\).md) [unbalanced](A\\).md)\n', 'docs/A(1).md': '# Target\n', 'docs/A).md': '# Target\n' });
  assert.equal(result.status, 0, result.output);
});

test('resolves normalized reference labels before checking their destinations', () => {
  const result = run({ 'docs/STATE.md': state + '[a][  A   Ref  ]\n\n[a ref]: Missing.md\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('checks Markdown anchors without interpreting source-file fragments', () => {
  const result = run({ 'docs/STATE.md': state + '[source](sample.txt#L1)\n', 'docs/sample.txt': 'source code\n' });
  assert.equal(result.status, 0, result.output);
});
