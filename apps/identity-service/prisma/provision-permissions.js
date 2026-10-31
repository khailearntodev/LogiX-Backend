import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';
import { SYSTEM_PERMISSIONS } from './seed.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to provision permissions');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    await prisma.$transaction(async (tx) => {
      for (const permission of SYSTEM_PERMISSIONS) {
        await tx.permission.upsert({
          where: { code: permission.code },
          update: {
            module: permission.module,
            resource: permission.resource,
            action: permission.action,
            name: permission.name,
            description: permission.description,
            deletedAt: null,
          },
          create: {
            code: permission.code,
            module: permission.module,
            resource: permission.resource,
            action: permission.action,
            name: permission.name,
            description: permission.description,
          },
        });
      }
    });

    console.log(`Provisioned ${SYSTEM_PERMISSIONS.length} permission catalogue entries.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('Permission catalogue provisioning failed:', error);
    process.exitCode = 1;
  });
}
