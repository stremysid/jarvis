// Run from any directory: node scripts/mutate-check-state.mjs [spec.json]
// Like reviewer-tools/mutate.ps1, a missed replacement is NOT APPLIED, never a
// surviving guard. A syntax error or an unnamed test failure is not a kill.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./check-state.mjs', import.meta.url));
const suite = fileURLToPath(new URL('./test/check-state.test.mjs', import.meta.url));
const spec = process.argv[2] ?? fileURLToPath(new URL('./test/check-state.mutations.json', import.meta.url));
const mutations = JSON.parse(readFileSync(spec, 'utf8'));
const original = readFileSync(source);
const text = original.toString('utf8');
const outcomes = [];

function run(name) {
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${pattern}$`, suite], { encoding: 'utf8' });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  const count = (label) => Number(new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output)?.[1] ?? NaN);
  return { status: result.status, output, pass: count('pass'), fail: count('fail'), skip: count('skipped'),
    namedFailure: output.split(/\r?\n/u).some((line) => /^not ok \d+ - /u.test(line) && line.replace(/^not ok \d+ - /u, '') === name) };
}

const green = (run) => run.status === 0 && run.pass === 1 && run.fail === 0 && run.skip === 0;
const dead = (run) => run.status === 1 && run.pass === 0 && run.fail === 1 && run.skip === 0 && run.namedFailure;
const counts = (run) => `${run.pass}/${run.fail}/${run.skip}`;

for (const mutation of mutations) {
  const { name, find, replace, test } = mutation;
  let verdict = 'INVALID';
  let detail = '';
  try {
    assert.equal(typeof find, 'string');
    assert.equal(typeof replace, 'string');
    assert.equal(typeof test, 'string');
    const matches = find ? text.split(find).length - 1 : 0;
    if (matches !== 1 || find === replace) {
      verdict = 'NOT APPLIED';
      detail = `literal matches=${matches}; source unchanged`;
    } else {
      const baseline = run(test);
      if (!green(baseline)) throw new Error(`Expected exactly one passing baseline test: ${baseline.output}`);
      const changed = text.replace(find, () => replace);
      writeFileSync(source, changed);
      assert.equal(readFileSync(source, 'utf8'), changed);
      const syntax = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' });
      if (syntax.status !== 0) throw new Error(`Invalid mutant syntax: ${syntax.stderr}`);
      const mutant = run(test);
      const confirmation = run(test);
      verdict = dead(mutant) && dead(confirmation) ? 'KILLED' :
        green(mutant) && green(confirmation) ? 'SURVIVED' : 'INVALID';
      detail = `baseline ${counts(baseline)}; mutant ${counts(mutant)}; confirmation ${counts(confirmation)}`;
      if (verdict === 'INVALID') detail += `; ${mutant.output}; ${confirmation.output}`;
    }
  } catch (error) {
    verdict = 'INVALID';
    detail = error.message;
  } finally {
    writeFileSync(source, original);
    assert.deepEqual(readFileSync(source), original, 'The source must be restored byte for byte.');
  }
  if (verdict !== 'NOT APPLIED') {
    const restored = run(test);
    detail += `; restored ${counts(restored)}`;
    if (!green(restored)) verdict = 'INVALID';
  }
  outcomes.push(verdict);
  console.log(`${verdict} ${name}: ${test} — ${detail}`);
}

for (const verdict of ['KILLED', 'SURVIVED', 'NOT APPLIED', 'INVALID']) {
  console.log(`${verdict}: ${outcomes.filter((value) => value === verdict).length}`);
}
console.log('Restore verified: source byte-identical. Counts are pass/fail/skip.');
process.exitCode = outcomes.some((value) => value === 'NOT APPLIED' || value === 'INVALID') ? 2 :
  outcomes.some((value) => value === 'SURVIVED') ? 1 : 0;
