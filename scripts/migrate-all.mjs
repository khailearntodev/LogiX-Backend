#!/usr/bin/env node

/**
 * LogiX Backend - Unified Migration Runner
 * Executes migrations across all 11 microservices (8 Prisma + 3 Alembic).
 *
 * Usage:
 *   node scripts/migrate-all.mjs
 *   node scripts/migrate-all.mjs --prisma-only
 *   node scripts/migrate-all.mjs --python-only
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

const PRISMA_SERVICES = [
  'identity-service',
  'master-data-service',
  'order-service',
  'inventory-service',
  'fulfillment-service',
  'transport-service',
  'notification-service',
  'audit-service',
];

const ALEMBIC_SERVICES = [
  'agent-service',
  'forecast-service',
  'route-optimizer-service',
];

const args = process.argv.slice(2);
const prismaOnly = args.includes('--prisma-only');
const pythonOnly = args.includes('--python-only');

function runCommand(command, args, cwd) {
  const isWindows = process.platform === 'win32';
  const executable = isWindows && command === 'pnpm' ? 'pnpm.cmd' : command;

  console.log(`\x1b[36m> [${cwd}] ${command} ${args.join(' ')}\x1b[0m`);
  const result = spawnSync(executable, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env },
  });

  if (result.error) {
    console.error(`\x1b[31mFailed to spawn ${command}: ${result.error.message}\x1b[0m`);
    return false;
  }
  return result.status === 0;
}

function resolvePythonCommand() {
  const venvPython = join(ROOT_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

async function main() {
  console.log('\n\x1b[35m===============================================================');
  console.log('              LogiX Database Migration Runner                 ');
  console.log('===============================================================\x1b[0m\n');

  let successCount = 0;
  let failCount = 0;
  const failedServices = [];

  // 1. Prisma Services
  if (!pythonOnly) {
    console.log('\x1b[33m--- Phase 1: Prisma Migrations (Node.js Services) ---\x1b[0m');
    for (const service of PRISMA_SERVICES) {
      console.log(`\n\x1b[1m[Prisma] Migrating ${service}...\x1b[0m`);
      const serviceDir = join(ROOT_DIR, 'apps', service);
      const ok = runCommand('pnpm', ['--filter', service, 'db:migrate:deploy'], ROOT_DIR);
      if (ok) {
        console.log(`\x1b[32m✔ ${service} migration succeeded\x1b[0m`);
        successCount++;
      } else {
        console.error(`\x1b[31m✘ ${service} migration failed\x1b[0m`);
        failCount++;
        failedServices.push(service);
      }
    }
  }

  // 2. Python / Alembic Services
  if (!prismaOnly) {
    console.log('\n\x1b[33m--- Phase 2: Alembic Migrations (Python Services) ---\x1b[0m');
    const pythonCmd = resolvePythonCommand();

    for (const service of ALEMBIC_SERVICES) {
      console.log(`\n\x1b[1m[Alembic] Migrating ${service}...\x1b[0m`);
      const iniPath = join('apps', service, 'alembic.ini');
      const ok = runCommand(pythonCmd, ['-m', 'alembic', '-c', iniPath, 'upgrade', 'head'], ROOT_DIR);
      if (ok) {
        console.log(`\x1b[32m✔ ${service} migration succeeded\x1b[0m`);
        successCount++;
      } else {
        console.error(`\x1b[31m✘ ${service} migration failed\x1b[0m`);
        failCount++;
        failedServices.push(service);
      }
    }
  }

  // Summary
  console.log('\n\x1b[35m===============================================================');
  console.log('                      Migration Summary                       ');
  console.log('===============================================================\x1b[0m');
  console.log(`Total: ${successCount + failCount} | Succeeded: \x1b[32m${successCount}\x1b[0m | Failed: \x1b[31m${failCount}\x1b[0m`);

  if (failCount > 0) {
    console.error(`\n\x1b[31mThe following services failed: ${failedServices.join(', ')}\x1b[0m`);
    console.error('Make sure PostgreSQL is running on port 5433 (docker compose database.yml)');
    process.exit(1);
  } else {
    console.log('\n\x1b[32mAll database migrations applied successfully! 🎉\x1b[0m\n');
  }
}

main().catch((err) => {
  console.error('\x1b[31mUnexpected migration error:\x1b[0m', err);
  process.exit(1);
});

