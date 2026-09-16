import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { splitMigration } from './split-migration.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultMigrationRoot = fileURLToPath(
  new URL('../apps/cloud-gateway/src/persistence/migrations/', import.meta.url),
);

const receiptTableSql = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ''
    || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}

export function discoverBaselineNames(migrationRoot = defaultMigrationRoot) {
  const migrations = readdirSync(migrationRoot)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .map((name) => ({ name, sequence: Number.parseInt(name.slice(0, 4), 10) }))
    .filter(({ sequence }) => sequence >= 1 && sequence <= 15)
    .sort((left, right) => left.sequence - right.sequence);
  const expectedSequences = Array.from({ length: 15 }, (_, index) => index + 1);
  if (migrations.length !== expectedSequences.length
      || migrations.some(({ sequence }, index) => sequence !== expectedSequences[index])) {
    throw new Error('Expected exactly one repository migration for every sequence from 0001 through 0015.');
  }
  return migrations.map(({ name }) => name);
}

export function loadMigrations({ migrationRoot = defaultMigrationRoot, names } = {}) {
  const selectedNames = names ?? discoverBaselineNames(migrationRoot);
  return selectedNames.map((name) => {
    const sql = readFileSync(resolve(migrationRoot, name), 'utf8');
    return { name, statements: splitMigration(sql) };
  });
}

function executeChecked(execute, request, description) {
  let result;
  try {
    result = execute(request);
  } catch (cause) {
    throw new Error(`${description} failed before returning an exit code.`, { cause });
  }
  if (result?.status !== 0) {
    const detail = result?.error instanceof Error ? ` ${result.error.message}` : '';
    throw new Error(`${description} failed with exit ${String(result?.status)}.${detail}`);
  }
}

export function applyBaseline({ migrations, execute, report = console.log }) {
  executeChecked(
    execute,
    { phase: 'receipt-table', sql: receiptTableSql },
    'Creating the scratch migration receipt table',
  );

  for (const migration of migrations) {
    report(`Applying ${migration.name}: ${migration.statements.length} split statements.`);
    for (const [index, sql] of migration.statements.entries()) {
      executeChecked(
        execute,
        { phase: 'statement', migration: migration.name, index, sql },
        `${migration.name} statement ${index + 1}/${migration.statements.length}`,
      );
    }
    const receiptSql = `INSERT INTO d1_migrations (name) VALUES (${sqlString(migration.name)})`;
    executeChecked(
      execute,
      { phase: 'receipt', migration: migration.name, sql: receiptSql },
      `Recording the ${migration.name} receipt`,
    );
    report(`BASELINE RECEIPT OK: ${migration.name}`);
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Usage: node scripts/prepare-d1-scratch-baseline.mjs --database <scratch-name> --config <outside-repo-toml>');
    }
    values.set(key, value);
  }
  const database = values.get('--database');
  const config = values.get('--config');
  if (values.size !== 2 || database === undefined || config === undefined) {
    throw new Error('Usage: node scripts/prepare-d1-scratch-baseline.mjs --database <scratch-name> --config <outside-repo-toml>');
  }
  return { database, config: resolve(config) };
}

export function runCli(argv) {
  const { database, config } = parseArguments(argv);
  if (!/scratch/iu.test(database)) throw new Error('The database name must visibly say scratch.');
  if (!existsSync(config)) throw new Error(`Scratch-only Wrangler config does not exist: ${config}`);
  if (isWithin(repoRoot, config)) {
    throw new Error('The scratch-only Wrangler config must remain outside the repository.');
  }
  const configText = readFileSync(config, 'utf8');
  const configuredNames = [...configText.matchAll(/^\s*database_name\s*=\s*"([^"]+)"\s*$/gimu)]
    .map((match) => match[1]);
  if (configuredNames.length !== 1 || configuredNames[0] !== database) {
    throw new Error('The scratch-only Wrangler config must declare exactly the case-sensitive scratch database name.');
  }
  const configuredRoots = [...configText.matchAll(/^\s*migrations_dir\s*=\s*"([^"]+)"\s*$/gimu)]
    .map((match) => resolve(dirname(config), match[1]));
  if (configuredRoots.length !== 1 || configuredRoots[0] !== resolve(defaultMigrationRoot)) {
    throw new Error('The scratch-only Wrangler config must point at the repository migration directory.');
  }

  const execute = ({ sql }) => spawnSync('pnpm.cmd', [
    'exec', 'wrangler', 'd1', 'execute', database, '--remote',
    '--config', config, '--env', '', '--command', sql,
  ], { cwd: repoRoot, stdio: 'inherit' });
  const migrations = loadMigrations();
  applyBaseline({ migrations, execute });
  console.log(`SCRATCH BASELINE OK: ${migrations.length}/${migrations.length} receipts through 0015.`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
