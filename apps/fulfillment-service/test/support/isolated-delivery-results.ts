import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { Pool } from 'pg';

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Isolated fulfillment test could not allocate a port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

export async function startIsolatedFulfillmentDatabase() {
  const suffix = randomUUID().replaceAll('-', '');
  const owner = `qa.phase5.delivery-results.${suffix}`;
  const name = owner.replaceAll('.', '-');
  const image = process.env.TEST_POSTGRES_IMAGE ?? 'postgres:17-bookworm';
  const port = await availablePort();
  const password = randomBytes(32).toString('hex');
  docker(['image', 'inspect', image]);
  let containerId: string | undefined;
  let pool: Pool | undefined;
  const dispose = async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
    if (containerId) {
      docker(['rm', '--force', containerId]);
      containerId = undefined;
    }
  };
  try {
    containerId = docker([
      'run',
      '--detach',
      '--pull=never',
      '--name',
      name,
      '--label',
      `logix.qa.owner=${owner}`,
      '--env',
      'POSTGRES_USER=fulfillment',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=fulfillment',
      '--publish',
      `127.0.0.1:${port}:5432`,
      image,
    ]);
    const databaseUrl = `postgresql://fulfillment:${password}@127.0.0.1:${port}/fulfillment?schema=fulfillment`;
    pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
    });
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        await pool.query('SELECT 1');
        ready = true;
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : '';
        if (!(
          error instanceof Error &&
          (error.message === 'Connection terminated unexpectedly' ||
            ['ECONNREFUSED', 'ECONNRESET', '57P03'].includes(code))
        ))
          throw error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    if (!ready)
      throw new Error('Isolated fulfillment PostgreSQL did not become ready');

    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DOTENV_CONFIG_PATH: resolve(process.cwd(), '.env.example'),
    };
    const migration = spawnSync(
      'pnpm',
      ['--filter', 'fulfillment-service', 'db:migrate:deploy'],
      {
        cwd: resolve(process.cwd(), '..', '..'),
        env,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 120_000,
      },
    );
    if (migration.error || migration.status !== 0) {
      const diagnostic =
        `${migration.stdout ?? ''}\n${migration.stderr ?? ''}`.replaceAll(
          databaseUrl,
          '[isolated database URL redacted]',
        );
      throw new Error(
        `Fulfillment migration deploy failed: ${diagnostic.slice(-4_000)}`,
      );
    }
    return { databaseUrl, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
