import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function one(text, pattern, description) {
  const values = [...text.matchAll(pattern)].map((match) => match[1]);
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error(`The restore config must declare exactly one ${description}.`);
  }
  return values[0];
}

function productionDatabaseId() {
  const text = readFileSync(productionConfig, 'utf8').split(/^\[env\.test\]$/mu)[0];
  return one(text, /^\s*database_id\s*=\s*"([^"]+)"\s*$/gimu, 'production database id');
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
  const configuredName = one(text, /^\s*database_name\s*=\s*"([^"]+)"\s*$/gimu, 'target database name');
  const configuredId = one(text, /^\s*database_id\s*=\s*"([^"]+)"\s*$/gimu, 'target database id');
  const configuredMain = realpathSync.native(resolve(
    dirname(resolvedConfig),
    one(text, /^\s*main\s*=\s*"([^"]+)"\s*$/gimu, 'operator main entry').replaceAll('/', sep),
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
