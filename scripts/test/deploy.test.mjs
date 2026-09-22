import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scripts = fileURLToPath(new URL('../', import.meta.url));
for (const [script, app] of [['deploy.ps1', 'cloud-gateway'], ['deploy-watchdog.ps1', 'watchdog']]) {
  test(`${script} preserves production targeting across the real PowerShell native boundary`, () => {
    // PowerShell reports the real directory, so an 8.3 alias in TEMP
    // (a runner's C:\Users\RUNNER~1\...) would never match the argv it
    // captures. Compare against the same canonical path the shell sees.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'jarvis deploy test ')));
    const origin = realpathSync.native(mkdtempSync(join(tmpdir(), 'jarvis deploy origin ')));
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
      // A publish checks the checkout against origin/main, so the fixture is a
      // real repository with a real remote: a clean checkout of origin/main.
      const git = (directory, ...args) => {
        const result = spawnSync('git', ['-C', directory, '-c', 'user.name=deploy-test',
          '-c', 'user.email=deploy-test@example.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git(origin, 'init', '-q', '--bare', '-b', 'main');
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'add', '--force', 'scripts', 'node_modules', 'apps');
      git(root, 'commit', '-q', '-m', 'fixture');
      git(root, 'remote', 'add', 'origin', origin);
      git(root, 'push', '-q', 'origin', 'main');
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

      // Each refusal must stop before wrangler runs, and name what it found.
      // PowerShell colours its error record and wraps it at the console width,
      // so the message is flattened back to one line before it is read.
      const refused = (pattern) => {
        rmSync(capture, { force: true });
        const result = run('-Publish -Confirm:$false');
        assert.notEqual(result.status, 0);
        const message = result.stderr.replace(/\x1B\[[0-9;]*m/g, '').replace(/\s*\r?\n\s*(?:\|\s*)?/g, ' ');
        assert.match(message, /Refusing to publish/);
        assert.match(message, pattern);
        assert.throws(() => readFileSync(capture), { code: 'ENOENT' });
      };
      // A tracked file changed and not committed.
      writeFileSync(config, 'changed = true\n');
      refused(/uncommitted changes/);
      // A dry run of the same tree still runs: only a publish ships anything.
      assert.equal(run().status, 0);
      checkArguments(true);
      git(root, 'checkout', '--', '.');
      // A commit origin/main does not have.
      git(root, 'commit', '-q', '--allow-empty', '-m', 'unpushed');
      refused(new RegExp(`HEAD is ${git(root, 'rev-parse', 'HEAD')}`));
      // Behind origin/main: the stale C:\javis this guard exists for. The script
      // must fetch to see it, because the local origin/main still matches HEAD.
      git(root, 'push', '-q', 'origin', 'main');
      git(root, 'reset', '-q', '--hard', 'HEAD~1');
      git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      refused(new RegExp(`origin/main is ${git(origin, 'rev-parse', 'main')}`));
      // Back on origin/main and clean, a publish runs again.
      git(root, 'reset', '-q', '--hard', 'origin/main');
      assert.equal(run('-Publish -Confirm:$false').status, 0);
      checkArguments(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  });
}
