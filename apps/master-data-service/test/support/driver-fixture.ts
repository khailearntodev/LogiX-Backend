import 'reflect-metadata';
import { InternalTripResourcesController } from '../../src/master-data/internal-trip-resources.controller.js';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  PermissionsGuard,
  InternalServiceGuard,
  INTERNAL_SERVICE_AUTH_OPTIONS,
} from '@logix/auth';
import { GlobalExceptionFilter } from '@logix/errors';
import cookieParser from 'cookie-parser';
import { PrismaService as MasterPrisma } from '../../src/database/prisma.service.js';
import { PrismaService as IdentityPrisma } from '../../../identity-service/src/database/prisma.service.js';
import { DriverUsersController } from '../../../identity-service/src/driver-users/driver-users.controller.js';
import { DriverUsersService } from '../../../identity-service/src/driver-users/driver-users.service.js';
import { DriversController } from '../../src/master-data/drivers/drivers.controller.js';
import { DriverService } from '../../src/master-data/drivers/driver.service.js';
import { IdentityDriverClient } from '../../src/master-data/drivers/identity-driver.client.js';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy.js';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard.js';
import { PassportModule } from '@nestjs/passport';
import { PrismaService as TransportPrisma } from '../../../transport-service/src/database/prisma.service.js';
import { DriverUsageController } from '../../../transport-service/src/drivers/driver-usage.controller.js';
import { DriverUsageService } from '../../../transport-service/src/drivers/driver-usage.service.js';
import { DriverLinkService } from '../../src/master-data/drivers/driver-link.service.js';
import { InternalDriverLinksController } from '../../src/master-data/drivers/internal-driver-links.controller.js';
import { TransportDriverClient } from '../../src/master-data/drivers/transport-driver.client.js';
import { WarehousesController } from '../../src/master-data/warehouses/warehouses.controller.js';
import { WarehouseService } from '../../src/master-data/warehouses/services/warehouse.service.js';
import { VehiclesController } from '../../src/master-data/vehicles/vehicles.controller.js';
import { VehicleService } from '../../src/master-data/vehicles/services/vehicle.service.js';

export async function driverFixture(
  options: { masterResources?: boolean } = {},
) {
  const databaseUrl = process.env.DRIVER_TEST_DATABASE_URL;
  if (
    !databaseUrl ||
    !new URL(databaseUrl).pathname.startsWith('/logix_driver_test_')
  )
    throw new Error(
      'DRIVER_TEST_DATABASE_URL must point to a migrated isolated logix_driver_test_* database; see test/README.md',
    );
  const secret = randomBytes(48).toString('hex');
  const master = new MasterPrisma(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  const identity = new IdentityPrisma(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  const transport = new TransportPrisma(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  const apps: INestApplication[] = [];
  const tenantId = randomUUID(),
    otherTenantId = randomUUID();
  const userId = randomUUID(),
    otherUserId = randomUUID(),
    unqualifiedId = randomUUID();
  const userIds = [userId, otherUserId, unqualifiedId];
  try {
    await Promise.all([
      master.$connect(),
      identity.$connect(),
      transport.$connect(),
    ]);
    for (const id of [tenantId, otherTenantId])
      await identity.tenant.create({
        data: {
          id,
          code: id,
          name: 'Driver test tenant',
          status: 'ACTIVE',
          settings: {},
        },
      });
    for (const [id, tenant, role] of [
      [userId, tenantId, 'OWNER'],
      [otherUserId, otherTenantId, 'OWNER'],
      [unqualifiedId, tenantId, 'MEMBER'],
    ]) {
      await identity.user.create({
        data: {
          id,
          email: `${id}@example.test`,
          displayName: `Driver ${id}`,
          passwordHash: 'not-a-login-credential',
          status: 'ACTIVE',
        },
      });
      await identity.userTenant.create({
        data: { userId: id, tenantId: tenant, role, status: 'ACTIVE' },
      });
    }
    const identityModule = await Test.createTestingModule({
      controllers: [DriverUsersController],
      providers: [
        {
          provide: DriverUsersService,
          useValue: new DriverUsersService(identity),
        },
        InternalServiceGuard,
        {
          provide: INTERNAL_SERVICE_AUTH_OPTIONS,
          useValue: { secret, serviceName: 'identity-service' },
        },
      ],
    }).compile();
    const configure = async (app: INestApplication) => {
      apps.push(app);
      app.setGlobalPrefix('api/v1');
      app.use(cookieParser());
      app.useGlobalFilters(new GlobalExceptionFilter());
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      );
      await app.listen(0, '127.0.0.1');
      return app.getUrl();
    };
    const identityApp = identityModule.createNestApplication();
    const identityUrl = await configure(identityApp);
    const transportModule = await Test.createTestingModule({
      controllers: [DriverUsageController],
      providers: [
        {
          provide: DriverUsageService,
          useValue: new DriverUsageService(transport),
        },
        InternalServiceGuard,
        {
          provide: INTERNAL_SERVICE_AUTH_OPTIONS,
          useValue: { secret, serviceName: 'transport-service' },
        },
      ],
    }).compile();
    const transportApp = transportModule.createNestApplication();
    const transportUrl = await configure(transportApp);
    const transportClient = new TransportDriverClient(
      new ConfigService({
        TRANSPORT_SERVICE_URL: transportUrl,
        INTERNAL_SERVICE_JWT_SECRET: secret,
      }),
    );
    const client = new IdentityDriverClient(
      new ConfigService({
        IDENTITY_SERVICE_URL: identityUrl,
        INTERNAL_SERVICE_JWT_SECRET: secret,
      }),
    );
    const masterModule = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [
        DriversController,
        InternalDriverLinksController,
        ...(options.masterResources
          ? [WarehousesController, VehiclesController, InternalTripResourcesController]
          : []),
      ],
      providers: [
        ...(options.masterResources
          ? [
              {
                provide: WarehouseService,
                useValue: new WarehouseService(master),
              },
              { provide: VehicleService, useValue: new VehicleService(master) },
            ]
          : []),
        { provide: DriverService, useValue: new DriverService(master, client) },
        { provide: IdentityDriverClient, useValue: client },
        {
          provide: DriverLinkService,
          useValue: new DriverLinkService(master, client, transportClient),
        },
        InternalServiceGuard,
        {
          provide: INTERNAL_SERVICE_AUTH_OPTIONS,
          useValue: { secret, serviceName: 'master-data-service' },
        },
        {
          provide: PermissionsGuard,
          useValue: new PermissionsGuard(new Reflector()),
        },
        {
          provide: JwtStrategy,
          useValue: new JwtStrategy(new ConfigService({ JWT_SECRET: secret })),
        },
        JwtAuthGuard,
      ],
    }).compile();
    const masterUrl = await configure(masterModule.createNestApplication());
    Object.assign(process.env, {
      NODE_ENV: 'test',
      SERVICE_NAME: 'api-gateway',
      MASTER_DATA_SERVICE_URL: masterUrl,
      IDENTITY_SERVICE_URL: identityUrl,
      ORDER_SERVICE_URL: masterUrl,
      FULFILLMENT_SERVICE_URL: masterUrl,
      TRANSPORT_SERVICE_URL: transportUrl,
    });
    const { AppModule } =
      await import('../../../api-gateway/src/app.module.js');
    const gatewayModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          MASTER_DATA_SERVICE_URL: masterUrl,
          IDENTITY_SERVICE_URL: identityUrl,
          ORDER_SERVICE_URL: masterUrl,
          FULFILLMENT_SERVICE_URL: masterUrl,
          TRANSPORT_SERVICE_URL: transportUrl,
        }),
      )
      .compile();
    const gatewayApp = gatewayModule.createNestApplication();
    apps.push(gatewayApp);
    gatewayApp.use(cookieParser());
    await gatewayApp.listen(0, '127.0.0.1');
    const url = await gatewayApp.getUrl();
    const token = (
      permissions: string[],
      tenant: string = tenantId,
      superAdmin = false,
    ) => {
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const content = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, email: `${userId}@example.test`, tenantId: tenant, permissions, isSuperAdmin: superAdmin, exp: Math.floor(Date.now() / 1000) + 600 })}`;
      return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
    };
    return {
      url,
      tenantId,
      otherTenantId,
      userId,
      otherUserId,
      unqualifiedId,
      identity,
      master,
      transport,
      masterUrl,
      transportUrl,
      transportClient,
      identityUrl,
      secret,
      token,
      async addEligibleUser(tenant: string = tenantId) {
        const id = randomUUID();
        userIds.push(id);
        await identity.user.create({
          data: {
            id,
            email: `${id}@example.test`,
            displayName: `Driver ${id}`,
            passwordHash: 'not-a-login-credential',
            status: 'ACTIVE',
          },
        });
        await identity.userTenant.create({
          data: {
            userId: id,
            tenantId: tenant,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        });
        return id;
      },
      async stopTransport() {
        apps.splice(apps.indexOf(transportApp), 1);
        await transportApp.close();
      },
      async close() {
        await Promise.all(apps.reverse().map((app) => app.close()));
        await transport.deliveryTrip.deleteMany({
          where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
        await master.outboxEvent.deleteMany({
          where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
        await master.driver.deleteMany({
          where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
        if (options.masterResources) {
          await master.warehouse.deleteMany({
            where: { tenantId: { in: [tenantId, otherTenantId] } },
          });
          await master.vehicle.deleteMany({
            where: { tenantId: { in: [tenantId, otherTenantId] } },
          });
        }
        await identity.userTenant.deleteMany({
          where: { tenantId: { in: [tenantId, otherTenantId] } },
        });
        await identity.user.deleteMany({
          where: { id: { in: userIds } },
        });
        await identity.tenant.deleteMany({
          where: { id: { in: [tenantId, otherTenantId] } },
        });
        await Promise.all([
          master.$disconnect(),
          identity.$disconnect(),
          transport.$disconnect(),
        ]);
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...apps.map((app) => app.close()),
      master.$disconnect(),
      identity.$disconnect(),
      transport.$disconnect(),
    ]);
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        [error, ...failures.map((result) => result.reason)],
        'Driver fixture startup and teardown failed',
      );
    throw error;
  }
}
