import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkRestoreTarget } from '../check-memory-backup-restore-target.mjs';

const operatorEntry = fileURLToPath(new URL(
  '../../apps/cloud-gateway/src/backup/memory-backup-restore-operator.ts',
  import.meta.url,
)).replaceAll('\\', '/');
const productionConfig = readFileSync(new URL('../../apps/cloud-gateway/wrangler.toml', import.meta.url), 'utf8');
const productionId = productionConfig.split(/^\[env\.test\]$/mu)[0]
  .match(/^\s*database_id\s*=\s*"([^"]+)"\s*$/imu)?.[1];

function configText(databaseId, previewDatabaseId) {
  return `main = "${operatorEntry}"
compatibility_date = "2026-09-16"
[[d1_databases]]
binding = "DB"
database_name = "jarvis-memory-restore-scratch"
database_id = "${databaseId}"
${previewDatabaseId === undefined ? '' : `preview_database_id = "${previewDatabaseId}"`}
`;
}

function withConfig(databaseId, run, previewDatabaseId) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis backup restore target '));
  try {
    const config = join(root, 'restore.toml');
    writeFileSync(config, configText(databaseId, previewDatabaseId));
    run(config);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the restore target checker accepts only the separately confirmed scratch config', () => {
  withConfig('00000000-0000-4000-8000-000000000001', (config) => {
    assert.deepEqual(checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch',
      config,
    }).database, 'jarvis-memory-restore-scratch');
  });
});

test('the restore target checker refuses the production database id from wrangler.toml', () => {
  assert.ok(productionId);
  withConfig(productionId, (config) => {
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch',
      config,
    }), /refuses the production database id/u);
  });
});

test('the restore target checker refuses a TOML-escaped production database id', () => {
  assert.ok(productionId);
  const escapedProductionId = `\\u${productionId.charCodeAt(0).toString(16).padStart(4, '0')}${productionId.slice(1)}`;
  withConfig(escapedProductionId, (config) => {
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch',
      config,
    }), /refuses the production database id/u);
  });
});

test('the restore target checker refuses every preview database id', () => {
  withConfig('00000000-0000-4000-8000-000000000001', (config) => {
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch',
      config,
    }), /refuses every preview_database_id/u);
  }, productionId);
});

test('the restore target checker refuses a target name that was not typed twice', () => {
  withConfig('00000000-0000-4000-8000-000000000001', (config) => {
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch-typo',
      config,
    }), /separately typed restore target name did not match/u);
  });
});

test('the restore target checker refuses a config kept inside the repository', () => {
  const config = fileURLToPath(new URL('restore-inside-repository.test.toml', import.meta.url));
  try {
    writeFileSync(config, configText('00000000-0000-4000-8000-000000000001'));
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch',
      config,
    }), /must remain outside the repository/u);
  } finally {
    rmSync(config, { force: true });
  }
});

test('the restore target checker refuses a target name without scratch', () => {
  withConfig('00000000-0000-4000-8000-000000000001', (config) => {
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore',
      confirmation: 'jarvis-memory-restore',
      config,
    }), /must visibly say scratch/u);
  });
});
