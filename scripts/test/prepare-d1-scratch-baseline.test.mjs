import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  applyBaseline,
  buildWranglerExecuteInvocation,
  discoverCandidateNames,
  loadMigrations,
} from '../prepare-d1-scratch-baseline.mjs';
import { splitMigration } from '../split-migration.mjs';

test('the runbook database id pattern accepts Wrangler JSON output and TOML', () => {
  const runbook = readFileSync(
    new URL('../../docs/runbooks/migration-scratch-proof.md', import.meta.url),
    'utf8',
  );
  const patternSource = runbook.match(
    /\$IdMatch = \[regex\]::Match\(\$CreateText, '([^']+)'\)/u,
  )?.[1];
  assert.ok(patternSource, 'expected the step 2 database id pattern in the runbook');

  const databaseId = '00000000-0000-4000-8000-000000000000';
  const createOutput = readFileSync(
    new URL('./fixtures/wrangler-4.127-create-output.txt', import.meta.url),
    'utf8',
  );
  const pattern = new RegExp(patternSource, 'u');

  assert.equal(createOutput.match(pattern)?.[1], databaseId);
  assert.equal(`database_id = "${databaseId}"`.match(pattern)?.[1], databaseId);
});

test('the scratch baseline invokes Wrangler through Node and keeps each SQL statement in one command argument', () => {
  const statements = [
    '-- Production was migrated before this replay.\nCREATE TABLE sample (id TEXT);',
    `INSERT INTO sample (id) VALUES ('{"source":"scratch"}');`,
  ];

  for (const sql of statements) {
    const invocation = buildWranglerExecuteInvocation({
      database: 'jarvis-scratch-test',
      config: 'C:\\outside repo\\scratch.toml',
      sql,
    });

    assert.equal(invocation.executable, process.execPath);
    assert.equal(
      invocation.args[0].replaceAll('\\', '/').endsWith('node_modules/wrangler/bin/wrangler.js'),
      true,
    );
    assert.deepEqual(invocation.args.filter((argument) => argument.startsWith('--command=')), [
      `--command=${sql}`,
    ]);
    assert.equal(invocation.args.includes(sql), false);
  }
});

test('the scratch baseline loader uses the shared splitter for a trigger-bearing migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis scratch baseline '));
  try {
    const migrationRoot = join(root, 'migrations');
    mkdirSync(migrationRoot);
    const name = '0001_trigger.sql';
    const sql = `CREATE TABLE sample (id TEXT PRIMARY KEY);
-- This comment belongs to the trigger.
CREATE TRIGGER sample_guard
BEFORE INSERT ON sample
BEGIN
  SELECT RAISE(ABORT, 'blocked') WHERE NEW.id = 'blocked';
END;
INSERT INTO sample (id) VALUES ('allowed');`;
    writeFileSync(join(migrationRoot, name), sql);

    const migrations = loadMigrations({ migrationRoot, names: [name] });

    assert.deepEqual(migrations, [{ name, statements: splitMigration(sql) }]);
    assert.match(migrations[0].statements[1], /^-- This comment belongs to the trigger\.\nCREATE TRIGGER/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the baseline script builds the 0015-equivalent schema from an empty database through the shared splitter', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const migrations = loadMigrations();
    applyBaseline({
      migrations,
      execute: ({ sql }) => {
        try {
          database.exec(sql);
          return { status: 0 };
        } catch (error) {
          return { status: 1, error };
        }
      },
      report: () => {},
    });

    const receipts = database.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
      .map(({ name }) => name);
    assert.deepEqual(receipts, migrations.map(({ name }) => name));
    assert.equal(receipts.at(-1), '0015_voice_runtime.sql');
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    database.close();
  }
});

test('the candidate range begins at 0016 with unique ordered sequences and includes the reviewed 0016 through 0025 prefix', () => {
  const candidates = discoverCandidateNames(undefined, () => {});
  const reviewedPrefix = [
    '0016_cloud_memory.sql',
    '0017_owner_passphrase.sql',
    '0018_owner_call_step_up.sql',
    '0019_memory_ingress.sql',
    '0020_school_catchup.sql',
    '0021_voice_owner_delivery.sql',
    '0022_university_tracker.sql',
    '0023_study_coach.sql',
    '0024_university_application_workflow.sql',
    '0025_archive_literal_history.sql',
  ];

  assert.deepEqual(candidates.slice(0, reviewedPrefix.length), reviewedPrefix);
  const sequences = candidates.map((name) => Number.parseInt(name.slice(0, 4), 10));
  assert.equal(sequences[0], 16);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
});

test('candidate discovery accepts and reports a reserved sequence gap', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis candidate gap '));
  try {
    writeFileSync(join(root, '0016_first.sql'), 'SELECT 16;\n');
    writeFileSync(join(root, '0018_later.sql'), 'SELECT 18;\n');
    const reports = [];

    assert.deepEqual(
      discoverCandidateNames(root, (message) => reports.push(message)),
      ['0016_first.sql', '0018_later.sql'],
    );
    assert.deepEqual(reports, [
      'CANDIDATE GAP: 0017 (reserved by open PRs, not rehearsed)',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate discovery refuses duplicate sequence numbers', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis duplicate candidate '));
  try {
    writeFileSync(join(root, '0016_first.sql'), 'SELECT 16;\n');
    writeFileSync(join(root, '0016_duplicate.sql'), 'SELECT 16;\n');
    assert.throws(
      () => discoverCandidateNames(root, () => {}),
      /Duplicate repository candidate sequence: 0016\./u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate discovery refuses a range that does not begin at 0016', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis invalid candidate start '));
  try {
    writeFileSync(join(root, '0017_after_gap.sql'), 'SELECT 17;\n');
    assert.throws(
      () => discoverCandidateNames(root, () => {}),
      /candidate range to begin at 0016/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate discovery refuses a sub-0016 file that is not the complete baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis candidate below floor '));
  try {
    writeFileSync(join(root, '0015_not_a_complete_baseline.sql'), 'SELECT 15;\n');
    writeFileSync(join(root, '0016_first.sql'), 'SELECT 16;\n');
    assert.throws(
      () => discoverCandidateNames(root, () => {}),
      /Migration files below 0016 must be exactly one baseline file/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the scratch baseline stops without recording a receipt when a statement fails', () => {
  const calls = [];
  const migration = { name: '0001_failure.sql', statements: ['first statement', 'failing statement', 'never reached'] };
  const execute = (request) => {
    calls.push(request);
    return { status: request.phase === 'statement' && request.index === 1 ? 17 : 0 };
  };

  assert.throws(
    () => applyBaseline({ migrations: [migration], execute, report: () => {} }),
    /0001_failure\.sql statement 2\/3 failed with exit 17/u,
  );
  assert.equal(calls.some(({ phase }) => phase === 'receipt'), false);
  assert.equal(calls.some(({ sql }) => sql === 'never reached'), false);
});
