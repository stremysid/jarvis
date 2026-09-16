import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyBaseline, loadMigrations } from '../prepare-d1-scratch-baseline.mjs';
import { splitMigration } from '../split-migration.mjs';

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
