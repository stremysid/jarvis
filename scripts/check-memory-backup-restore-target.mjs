import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import TOML from '@iarna/toml';

const repoRoot = realpathSync.native(fileURLToPath(new URL('../', import.meta.url)));
const productionConfig = resolve(repoRoot, 'apps/cloud-gateway/wrangler.toml');
const operatorEntry = realpathSync.native(resolve(
  repoRoot,
  'apps/cloud-gateway/src/backup/memory-backup-restore-operator.ts',
));

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ''
    || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}

function parseToml(text, description) {
  try {
    return TOML.parse(text);
  } catch {
    throw new Error(`The ${description} is not valid TOML.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneDatabase(config, description) {
  const databases = config.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || !isRecord(databases[0])) {
    throw new Error(`The restore config must declare exactly one ${description}.`);
  }
  return databases[0];
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((child) => containsKey(child, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, child]) => childKey === key || containsKey(child, key));
}

function requireString(value, description) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The restore config must declare exactly one ${description}.`);
  }
  return value;
}

function productionDatabaseId() {
  const config = parseToml(readFileSync(productionConfig, 'utf8'), 'production Wrangler config');
  const database = oneDatabase(config, 'production database binding');
  return requireString(database.database_id, 'production database id');
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      throw new Error('Usage: node scripts/check-memory-backup-restore-target.mjs --database <scratch-name> --confirm-database <same-scratch-name> --config <outside-repo-toml>');
    }
    values.set(key, value);
  }
  const database = values.get('--database');
  const confirmation = values.get('--confirm-database');
  const config = values.get('--config');
  if (values.size !== 3 || database === undefined || confirmation === undefined || config === undefined) {
    throw new Error('Usage: node scripts/check-memory-backup-restore-target.mjs --database <scratch-name> --confirm-database <same-scratch-name> --config <outside-repo-toml>');
  }
  return { database, confirmation, config: resolve(config) };
}

export function checkRestoreTarget({ database, confirmation, config }) {
  if (!/^[A-Za-z0-9_-]*scratch[A-Za-z0-9_-]*$/u.test(database)) {
    throw new Error('The restore target name must visibly say scratch.');
  }
  if (confirmation !== database) throw new Error('The separately typed restore target name did not match.');
  if (!existsSync(config)) throw new Error('The scratch-only restore Wrangler config does not exist.');
  const resolvedConfig = realpathSync.native(config);
  if (isWithin(repoRoot, resolvedConfig)) {
    throw new Error('The scratch-only restore Wrangler config must remain outside the repository.');
  }
  const text = readFileSync(resolvedConfig, 'utf8');
  const parsed = parseToml(text, 'scratch-only restore Wrangler config');
  if (containsKey(parsed, 'preview_database_id')) {
    throw new Error('The restore entry point refuses every preview_database_id.');
  }
  const configuredDatabase = oneDatabase(parsed, 'target database binding');
  const configuredName = requireString(configuredDatabase.database_name, 'target database name');
  const configuredId = requireString(configuredDatabase.database_id, 'target database id');
  const configuredMain = realpathSync.native(resolve(
    dirname(resolvedConfig),
    requireString(parsed.main, 'operator main entry').replaceAll('/', sep),
  ));
  if (configuredName !== database) {
    throw new Error('The restore config database name does not match the separately typed target.');
  }
  if (configuredId.toLowerCase() === productionDatabaseId().toLowerCase()) {
    throw new Error('The restore entry point refuses the production database id from wrangler.toml.');
  }
  if (configuredMain !== operatorEntry) {
    throw new Error('The restore config main entry is not the bounded memory backup restore operator.');
  }
  return Object.freeze({ database, config: resolvedConfig });
}

export function runCli(argv) {
  const checked = checkRestoreTarget(parseArguments(argv));
  console.log(`RESTORE TARGET OK: ${checked.database} is separately confirmed scratch.`);
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
