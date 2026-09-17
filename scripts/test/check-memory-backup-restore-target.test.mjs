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

function withConfig(databaseId, run) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis backup restore target '));
  try {
    const config = join(root, 'restore.toml');
    writeFileSync(config, `main = "${operatorEntry}"
compatibility_date = "2026-09-16"
[[d1_databases]]
binding = "DB"
database_name = "jarvis-memory-restore-scratch"
database_id = "${databaseId}"
`);
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

test('the restore target checker refuses a target name that was not typed twice', () => {
  withConfig('00000000-0000-4000-8000-000000000001', (config) => {
    assert.throws(() => checkRestoreTarget({
      database: 'jarvis-memory-restore-scratch',
      confirmation: 'jarvis-memory-restore-scratch-typo',
      config,
    }), /separately typed restore target name did not match/u);
  });
});
