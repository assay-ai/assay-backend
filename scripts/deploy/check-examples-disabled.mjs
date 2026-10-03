/**
 * Deploy gate: the production build does not load `src/modules/_examples/`.
 *
 *     yarn build
 *     yarn deploy:check:examples [--env-file .deploy/production.env]
 *
 * ## What it actually proves
 *
 * Not "the flag defaults to off" — that is a unit test, and it was already
 * true. This runs against the **built artifact in `dist/`** and reads the Nest
 * module graph the way Nest will: `areExamplesEnabled()` is called *inline* in
 * each bootstrap's `imports` array, so it has already run by the time the
 * `@Module` decorator records its metadata. Requiring the compiled module in a
 * child process with a given environment and reading
 * `Reflect.getMetadata('imports', AppApiModule)` therefore answers the exact
 * question a deploy wants answered: *with this environment, will these routes
 * exist?*
 *
 * All three service bootstraps are checked. The API one is the one with routes
 * on it, but `ExamplesWorkerModule` registers processors that consume queues and
 * `ExamplesSchedulerModule` registers a cron — a half-loaded example group is
 * worse than a fully loaded one.
 *
 * ## The four checks, and why each exists
 *
 * 1. **Fails closed.** `NODE_ENV=production`, nothing else set → absent.
 * 2. **Not vacuous.** Same, plus `EXAMPLES_ENABLED=true` → *present*. Without
 *    this, a probe that silently stopped finding any modules at all would report
 *    a clean bill of health forever. This is the check that checks the checker.
 * 3. **This deployment.** With `--env-file`, the file that will actually ship is
 *    applied and the graph re-read. `.env` does not override a variable that is
 *    already set, but it very much does set one that is not — a shipped `.env`
 *    carrying `EXAMPLES_ENABLED=true` turns the sample routes on in production
 *    and no amount of "the default is off" prevents it. This repo's own
 *    `.env.example` carries exactly that line.
 * 4. **Nothing can smuggle one in.** `.dockerignore` must exclude `.env*`, so
 *    the image cannot carry a file that check 3 never saw.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(BACKEND, 'dist');

/** Every bootstrap that can load the example group, and the class to inspect. */
const BOOTSTRAPS = [
  { service: 'api', module: 'AppApiModule', path: 'bootstrap/api/app.module.js' },
  { service: 'worker', module: 'AppWorkerModule', path: 'bootstrap/worker/app.module.js' },
  {
    service: 'scheduler',
    module: 'AppSchedulerModule',
    path: 'bootstrap/scheduler/app.module.js',
  },
];

/** Modules whose presence means the example group is loaded. */
const EXAMPLE_MODULE = /^Examples(Api|Worker|Scheduler)Module$/;

const args = process.argv.slice(2);
const envFileFlag = args.indexOf('--env-file');
const envFile = envFileFlag === -1 ? null : args[envFileFlag + 1];

if (!existsSync(DIST)) {
  fail(`dist/ does not exist. This gate reads the built artifact — run \`yarn build\` first.`);
}
for (const { path } of BOOTSTRAPS) {
  if (!existsSync(join(DIST, path))) {
    fail(`dist/${path} does not exist. The build is incomplete or its layout changed.`);
  }
}

/**
 * Read one bootstrap's `imports` metadata under a given environment.
 *
 * A child process per environment, because module metadata is computed at
 * import time and a single process can only answer for one environment. `cwd`
 * is a temp directory so that `src/load-env.ts` — which calls
 * `dotenv.config({ path: ['.env.local', '.env'] })` at import, relative to the
 * working directory — cannot read a developer's local `.env` into a check that
 * is supposed to describe a deployment. Check 3 is where a real env file is
 * applied, deliberately and by name.
 */
function importedModules(relativePath, className, env) {
  const script = `
    require(${JSON.stringify(join(BACKEND, 'node_modules', 'reflect-metadata'))});
    const loaded = require(${JSON.stringify(join(DIST, relativePath))});
    const target = loaded[${JSON.stringify(className)}];
    if (!target) {
      console.error('MISSING_CLASS');
      process.exit(3);
    }
    const imports = Reflect.getMetadata('imports', target) || [];
    const names = imports.map((entry) => {
      if (!entry) return String(entry);
      if (typeof entry === 'function') return entry.name;
      if (entry.module && typeof entry.module === 'function') return entry.module.name;
      return String(entry);
    });
    process.stdout.write(JSON.stringify(names));
  `;

  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function examplesIn(env) {
  const found = [];
  for (const { service, module, path } of BOOTSTRAPS) {
    const loaded = importedModules(path, module, env).filter((name) => EXAMPLE_MODULE.test(name));
    for (const name of loaded) {
      found.push(`${service}: ${name}`);
    }
  }
  return found;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── 1. fails closed ─────────────────────────────────────────────────────────

const defaultProduction = examplesIn({ NODE_ENV: 'production' });
if (defaultProduction.length > 0) {
  fail(
    `NODE_ENV=production still loads the example modules:\n` +
      defaultProduction.map((entry) => `         ${entry}`).join('\n') +
      `\n\n       See src/modules/_examples/examples.flag.ts — this is supposed to fail closed.`,
  );
}
console.log('OK  default    NODE_ENV=production, EXAMPLES_ENABLED unset → not loaded');

// ── 2. not vacuous ──────────────────────────────────────────────────────────

const forcedOn = examplesIn({ NODE_ENV: 'production', EXAMPLES_ENABLED: 'true' });
if (forcedOn.length !== BOOTSTRAPS.length) {
  fail(
    `the probe cannot see the example modules even with EXAMPLES_ENABLED=true.\n` +
      `       Expected one per bootstrap (${BOOTSTRAPS.length}), saw ${forcedOn.length}: ${
        forcedOn.join(', ') || '(none)'
      }\n\n` +
      `       Check 1 above is therefore meaningless — it would pass whether or not\n` +
      `       the modules were gated. Fix this before trusting anything else here.`,
  );
}
console.log(`OK  probe      EXAMPLES_ENABLED=true → loaded in all ${forcedOn.length} bootstraps`);

// ── 3. this deployment's own environment ────────────────────────────────────

if (envFile) {
  const path = resolve(envFile);
  if (!existsSync(path)) {
    fail(`--env-file ${envFile} does not exist (resolved to ${path}).`);
  }
  const fileEnv = parseEnvFile(readFileSync(path, 'utf8'));

  if (fileEnv.NODE_ENV !== undefined && fileEnv.NODE_ENV !== 'production') {
    fail(
      `${envFile} sets NODE_ENV=${fileEnv.NODE_ENV}. A production deploy that is not\n` +
        `       NODE_ENV=production has every fail-closed default turned the other way.`,
    );
  }

  const deployed = examplesIn({ NODE_ENV: 'production', ...fileEnv });
  if (deployed.length > 0) {
    fail(
      `${envFile} loads the example modules in production:\n` +
        deployed.map((entry) => `         ${entry}`).join('\n') +
        `\n\n       EXAMPLES_ENABLED=${fileEnv.EXAMPLES_ENABLED ?? '(unset)'} in that file.\n` +
        `       Remove the line, or set it to false. Note that .env.example ships it as\n` +
        `       true — a file copied from it and deployed is how this happens.`,
    );
  }
  console.log(`OK  deployment ${envFile} → not loaded`);
} else {
  console.log('--  deployment no --env-file given; check 4 is what covers the gap');
}

// ── 4. no env file can reach the image ──────────────────────────────────────

const dockerignore = join(BACKEND, '.dockerignore');
if (!existsSync(dockerignore)) {
  fail(
    `.dockerignore does not exist, and the Dockerfile's build stage runs \`COPY . .\`.\n` +
      `       A developer's .env — this repo's ships EXAMPLES_ENABLED=true — is copied\n` +
      `       into the image, and check 1 above never sees it.`,
  );
}
const ignoresEnv = readFileSync(dockerignore, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .some((line) => line === '.env' || line === '.env*' || line === '**/.env*');
if (!ignoresEnv) {
  fail(`.dockerignore does not exclude .env — add a \`.env*\` line.`);
}
console.log('OK  image      .dockerignore excludes .env*');

console.log('');
console.log('The production build does not load src/modules/_examples/.');

/**
 * A deliberately small `.env` parser.
 *
 * `dotenv` is a dependency and could be used, but it resolves `${VAR}`
 * interpolation and multiline values, and this gate should read the file the
 * same way a reviewer does. `KEY=value`, comments, blank lines, optional
 * surrounding quotes.
 */
function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // An empty value is "unset" to `areExamplesEnabled()`, and passing an empty
    // string through would be indistinguishable from setting it. Left out so
    // the child sees the same thing the flag does.
    if (value !== '') {
      env[key] = value;
    }
  }
  return env;
}
