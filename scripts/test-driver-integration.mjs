import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const image = 'postgres:17-bookworm';
const suffix = randomUUID().replaceAll('-', '');
const database = `logix_driver_test_${suffix}`;
const password = randomBytes(32).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password };
let container;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: 'utf8',
    shell: command === 'pnpm' && process.platform === 'win32',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status})`);
  return result.stdout?.trim();
}

try {
  run('docker', ['info'], { capture: true });
  run('docker', ['image', 'inspect', image], { capture: true });
  container = run('docker', ['run', '--rm', '-d', '--name', `logix-driver-test-${suffix}`,
    '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${database}`,
    '-p', '127.0.0.1::5432', image], { capture: true });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', database], { stdio: 'ignore' });
    if (probe.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Owned test PostgreSQL did not become ready');
  const binding = run('docker', ['port', container, '5432/tcp'], { capture: true });
  const port = binding.split(':').at(-1);
  if (!/^\d+$/.test(port)) throw new Error('Invalid test PostgreSQL port binding');
  const base = `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`;
  env.DRIVER_TEST_DATABASE_URL = base;
  for (const [service, schema] of [['identity-service', 'identity'], ['master-data-service', 'master_data'], ['transport-service', 'transport']]) {
    env.DATABASE_URL = `${base}?schema=${schema}`;
    run('pnpm', ['--filter', service, 'db:migrate:deploy']);
    run('pnpm', ['--filter', service, 'db:migrate:status']);
  }
  run('pnpm', ['--filter', 'master-data-service', 'test:e2e']);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Driver integration runner failed');
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      run('docker', ['rm', '-f', container], { capture: true });
      console.info('Owned isolated Driver PostgreSQL removed');
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Owned PostgreSQL cleanup failed');
      process.exitCode = 1;
    }
  }
}
