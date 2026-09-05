import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scripts = fileURLToPath(new URL('../', import.meta.url));
for (const [script, app] of [['deploy.ps1', 'cloud-gateway'], ['deploy-watchdog.ps1', 'watchdog']]) {
  test(`${script} preserves production targeting across the real PowerShell native boundary`, () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis deploy test '));
    try {
      const entry = join(root, 'scripts', script);
      const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
      const config = join(root, 'apps', app, 'wrangler.toml');
      for (const path of [entry, cli, config]) mkdirSync(dirname(path), { recursive: true });
      copyFileSync(join(scripts, script), entry);
      writeFileSync(config, '');
      // A native Node process records argv after PowerShell has serialized it.
      writeFileSync(cli, `const fs = require('node:fs');
fs.writeFileSync(process.env.DEPLOY_TEST_CAPTURE, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}));
process.exit(Number(process.env.DEPLOY_TEST_EXIT ?? 0));
`);
      const capture = join(root, 'argv.json');
      const run = (argumentsText = '', exit = '0') => spawnSync('pwsh', [
        '-NoProfile', '-NonInteractive', '-Command',
        `& '${entry.replaceAll("'", "''")}' ${argumentsText}`,
      ], { encoding: 'utf8', cwd: tmpdir(), env: { ...process.env, DEPLOY_TEST_CAPTURE: capture, DEPLOY_TEST_EXIT: exit } });
      const checkArguments = (dryRun) => {
        const result = JSON.parse(readFileSync(capture, 'utf8'));
        assert.deepEqual(result.argv, [
          'deploy', '--config', config, '--env', '', '--keep-vars', '--strict', '--no-autoconfig',
          ...(dryRun ? ['--dry-run'] : []),
        ]);
        assert.equal(result.cwd, root);
      };
      assert.equal(run().status, 0);
      checkArguments(true);
      assert.equal(run('-Publish -Confirm:$false').status, 0);
      checkArguments(false);
      rmSync(capture);
      assert.notEqual(run('-Publish').status, 0);
      assert.throws(() => readFileSync(capture), { code: 'ENOENT' });
      assert.equal(run('-Publish -WhatIf').status, 0);
      assert.throws(() => readFileSync(capture), { code: 'ENOENT' });
      const failed = run('', '17');
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /failed \(exit 17\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
