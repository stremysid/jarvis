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
  ['annotates an old fact as a warning without failing the check', fact(row('Old fact', 'Source', '2026-08-01')), 0, /::warning file=docs\/FACTS\.md,line=7::1 item/],
  ['lists an unset Still true cell as a warning', fact(row('Unset fact', 'Source', date, '')), 0, /::warning file=docs\/FACTS\.md,line=7::1 item/],
  ['lists a no Still true cell as a warning', fact(row('Retired fact', 'Source', date, 'no')), 0, /::warning file=docs\/FACTS\.md,line=7::1 item/],
  ['warns when a carrier was last regenerated more than thirty days ago', { 'docs/STATE.md': state.replace(date, '2026-08-01') }, 0, /::warning file=docs\/STATE\.md,line=2::1 item/],
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
    assert.match(result.output, /::warning file=docs\/FACTS\.md,line=7::1 item/);
    assert.match(result.output, /^  docs\/FACTS\.md:7: .*Check this fact$/mu);
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

test('keeps row text out of warning annotations', () => {
  const result = run(fact(row('Value %0A::error::forged', 'Source', date, 'unknown')));
  assert.equal(result.status, 0, result.output);
  const annotation = result.output.split('\n').find((line) => line.startsWith('::warning '));
  assert.ok(annotation, result.output);
  assert.doesNotMatch(annotation, /Value|%0A|::error/);
  assert.match(result.output, /^  docs\/FACTS\.md:7: .*Value %0A::error::forged$/mu);
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

const revisionForms = [
  ['rejects a parenthesized revision after origin main', 'origin/main (a666097)'],
  ['rejects a revision after an arrow from origin main', 'origin/main → a666097'],
  ['rejects a revision after origin main is now', 'origin/main is now a666097'],
  ['rejects a full revision after origin main was', 'origin/main was a666097ffe6e0b2c99dc83ce29fc43efacdf7f4d'],
  ['rejects a revision before parenthesized origin main', 'a666097 (origin/main)'],
  ['rejects a revision after origin main comma at', 'origin/main, at a666097'],
];
for (const [name, line] of revisionForms) {
  test(name, () => {
    const result = run({ 'docs/STATE.md': state + line + '\n' });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /literal sha/);
  });
}

test('exempts only the marked run tokens and URL tokens on a revision line', () => {
  for (const token of ['run 35532044202', 'run id `35532044202`', 'runs/35532044202', '#35532044202', 'https://example.invalid/a666097']) {
    const result = run({ 'docs/STATE.md': state + `origin/main: ${token}\n` });
    assert.equal(result.status, 0, result.output);
    const withRevision = run({ 'docs/STATE.md': state + `origin/main: ${token}; actual revision (a666097)\n` });
    assert.equal(withRevision.status, 1, withRevision.output);
    assert.match(withRevision.output, /literal sha/);
  }
});

test('permits a revision on a line without origin main', () => {
  const result = run({ 'docs/STATE.md': state + 'Observed commit a666097.\n' });
  assert.equal(result.status, 0, result.output);
});

test('checks a broken link in a four-space nested bullet', () => {
  const result = run({ 'docs/STATE.md': state + '- a\n  - b\n    - c [x](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('checks a revision in a four-space bullet', () => {
  const result = run({ 'docs/STATE.md': state + '\n    - origin/main = a666097\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /literal sha/);
});

test('checks an indented list continuation after a blank line', () => {
  const result = run({ 'docs/STATE.md': state + '- a\n\n    [x](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('checks an indented paragraph continuation without a blank line', () => {
  const result = run({ 'docs/STATE.md': state + 'A paragraph\n    [x](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('recognizes an indented code block after a list has ended', () => {
  const result = run({ 'docs/STATE.md': state + '- a\n\nOutside the list.\n\n    [x](Missing.md)\n    [y](Also-missing.md)\n' });
  assert.equal(result.status, 0, result.output);
});

test('does not pair an unmatched backtick across a paragraph boundary', () => {
  const result = run({ 'docs/STATE.md': state + 'Press the ` key.\n\nSee `x` and [x](Missing.md) and `y`.\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('allows an inline code span to continue within its paragraph', () => {
  const result = run({ 'docs/STATE.md': state + 'Example `first line\n[x](Missing.md)` ends here.\n' });
  assert.equal(result.status, 0, result.output);
});

test('rejects a register row appended after a blank line', () => {
  const result = run(fact(row() + '\n' + row('Dropped fact', 'Source')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FACTS\.md:9:.*after.*table/);
});

test('rejects an indented register row after intervening prose', () => {
  const result = run(fact(row() + '\nExtra prose.\n  ' + row('Dropped fact', 'Source')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FACTS\.md:10:.*after.*table/);
});

test('emits one warning per file with a count and the first affected line', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`Old fact ${i}`)).join('');
  const result = run({ ...fact(rows), 'clock.mjs': "Date.now = () => Date.parse('2026-10-25T12:00:00Z');\n" });
  assert.equal(result.status, 0, result.output);
  const annotations = result.output.split('\n').filter((line) => /^::warning(?: |::)/u.test(line));
  assert.equal(annotations.length, 4, result.output);
  assert.match(result.output, /::warning file=docs\/FACTS\.md,line=7::12 item\(s\) .*first.*7/);
  for (const file of ['STATE', 'QUEUE', 'OWNER-ACTIONS']) {
    assert.equal(annotations.filter((line) => line.startsWith(`::warning file=docs/${file}.md,line=2::1 item`)).length, 1, result.output);
  }
  for (let i = 0; i < 12; i++) assert.match(result.output, new RegExp(`^  docs/FACTS\\.md:${7 + i}: .*Old fact ${i}$`, 'mu'));
});

for (const status of ['unverified', 'not verified', '?', 'false', 'superseded', 'partly']) {
  test(`warns when Still true starts with ${status}`, () => {
    const result = run(fact(row('Recheck this fact', 'Source', date, status)));
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /::warning file=docs\/FACTS\.md,line=7::/);
  });
}

test('accepts a Still true cell starting with yes and an explanation', () => {
  const result = run(fact(row('Current fact', 'Source', date, '**Yes**; unconfirmed details are recorded elsewhere')));
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /::warning/);
});

for (const source of ['—', '–', 'TBD', 'N/A', '?', 'none']) {
  test(`rejects ${source} as a placeholder fact source`, () => {
    const result = run(fact(row('Recorded fact', source)));
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /no source/);
  });
}

test('rejects an empty Fact cell', () => {
  const result = run(fact(row('')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Fact cell.*empty/);
});

test('rejects an observation more than one UTC day ahead', () => {
  const result = run(fact(row('Future fact', 'Source', '2026-09-25')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Observed.*ahead/);
});

test('rejects a regeneration date more than one UTC day ahead', () => {
  const result = run({ 'docs/STATE.md': state.replace(date, '2026-09-25') });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Last regenerated.*ahead/);
});

test('allows an observation and regeneration stamp one UTC day ahead', () => {
  const result = run({ ...fact(row('Tomorrow', 'Source', '2026-09-24')), 'docs/STATE.md': state.replace(date, '2026-09-24') });
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /::warning/);
});

test('does not interpret a footnote definition as a link destination', () => {
  const result = run({ 'docs/STATE.md': state + 'Evidence[^1].\n\n[^1]: Sid said so\n' });
  assert.equal(result.status, 0, result.output);
});

test('still checks a Markdown link inside a footnote body', () => {
  const result = run({ 'docs/STATE.md': state + 'Evidence[^1].\n\n[^1]: See [x](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
  assert.doesNotMatch(result.output, /exact case: See/);
});

test('checks a link whose label contains nested brackets', () => {
  const result = run({ 'docs/STATE.md': state + '[see [1]](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('checks a reference link whose label contains nested brackets', () => {
  const result = run({ 'docs/STATE.md': state + '[see [1]][ref]\n\n[ref]: Missing.md\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

const anchorCases = [
  ['preserves both spaces around removed punctuation in an anchor', 'Voice — tools', 'voice--tools'],
  ['strips HTML tags from a heading anchor', '<em>Voice</em> tools', 'voice-tools'],
  ['uses the visible link text in a heading anchor', '[Voice](Target.md) tools', 'voice-tools'],
  ['preserves underscores in a heading anchor', 'snake_case', 'snake_case'],
  ['decodes a percent-encoded Unicode anchor', 'Café', 'caf%C3%A9'],
];
for (const [name, heading, anchor] of anchorCases) {
  test(name, () => {
    const result = run({ 'docs/STATE.md': state + `[heading](Target.md#${anchor})\n`, 'docs/Target.md': `# ${heading}\n` });
    assert.equal(result.status, 0, result.output);
  });
}

test('strips the query before resolving a local link', () => {
  const result = run({ 'docs/STATE.md': state + '[target](Target.md?view=plain#ready)\n' });
  assert.equal(result.status, 0, result.output);
});

test('does not join bracket labels across a paragraph boundary', () => {
  const result = run({ 'docs/STATE.md': state + 'Open [some text\n\nHere is [x](Missing.md) and end].\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('keeps control characters inside prefixed warning detail lines', () => {
  const result = run(fact(row('Value\r::warning::forged', 'Source', date, 'unknown')));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /^  docs\/FACTS\.md:7: .*Value ::warning::forged$/mu);
});

test('does not create indented code merely because a fence followed a blank line', () => {
  const result = run({ 'docs/STATE.md': state + '\n~~~md\nexample\n~~~\n    [x](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('permits prose with a pipe after the register table', () => {
  const result = run(fact(row() + '\nExtra | prose.\n'));
  assert.equal(result.status, 0, result.output);
});

test('ignores an escaped opening bracket inside a link label', () => {
  const result = run({ 'docs/STATE.md': state + '[see \\[1](Missing.md)\n' });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Missing\.md/);
});

test('permits an unfinished bracket in ordinary prose', () => {
  const result = run({ 'docs/STATE.md': state + 'An unfinished [ label.\n' });
  assert.equal(result.status, 0, result.output);
});

test('uses an explicit reference instead of a shortcut with the same link text', () => {
  const result = run({ 'docs/STATE.md': state + '[wrong][ref]\n\n[wrong]: Missing.md\n[ref]: Target.md\n' });
  assert.equal(result.status, 0, result.output);
});
