import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { GlobalExceptionFilter } from '@logix/errors';
import {
  signInternalServiceToken,
  InternalServiceGuard,
  INTERNAL_SERVICE_AUTH_OPTIONS,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { OutboxRelay } from '@logix/messaging';
import { driverFixture } from '../../../master-data-service/test/support/driver-fixture.js';
import { startIsolatedKafka } from '../../../../libs/messaging/test/support/isolated-kafka.js';
import { PrismaService as FulfillmentPrisma } from '../../../fulfillment-service/src/database/prisma.service.js';
import { PrismaService as OrderPrisma } from '../../../order-service/src/database/prisma.service.js';
import { InternalShipmentTripController } from '../../../fulfillment-service/src/shipments/internal-shipment-trip.controller.js';
import { ShipmentTripClaimService } from '../../../fulfillment-service/src/shipments/shipment-trip-claim.service.js';
import { ShipmentPoolService } from '../../../fulfillment-service/src/shipments/shipment-pool.service.js';
import { ShipmentDispatchBatchService } from '../../../fulfillment-service/src/shipments/shipment-dispatch-batch.service.js';
import { OrderClient } from '../../../fulfillment-service/src/shipments/order.client.js';
import { OrderDispatchBatchService } from '../../../order-service/src/orders/services/order-dispatch-batch.service.js';
import { OrderDispatchService } from '../../../order-service/src/orders/services/order-dispatch.service.js';
import { OrdersDispatchInternalController } from '../../../order-service/src/orders/orders-dispatch.internal.controller.js';
import { OrdersFulfillmentInternalController } from '../../../order-service/src/orders/orders-fulfillment.internal.controller.js';
import { OrderQueryService } from '../../../order-service/src/orders/services/order-query.service.js';
import { ShipmentDispatchService } from '../../../fulfillment-service/src/shipments/shipment-dispatch.service.js';
import { ShipmentQueryService } from '../../../fulfillment-service/src/shipments/shipment-query.service.js';
import { PrismaService as InventoryPrisma } from '../../../inventory-service/src/database/prisma.service.js';
import { ReservationService } from '../../../inventory-service/src/inventory/services/reservation.service.js';
import { ReservationsInternalController } from '../../../inventory-service/src/inventory/reservations.internal.controller.js';
import { InventoryClient } from '../../../order-service/src/orders/integrations/inventory.client.js';
import { MasterDataClient as OrderMasterClient } from '../../../order-service/src/orders/integrations/master-data.client.js';
import { OrderReferenceResolver } from '../../../order-service/src/orders/services/order-reference.resolver.js';
import { OrderNumberService } from '../../../order-service/src/orders/services/order-number.service.js';
import { OrderOutboxWriter } from '../../../order-service/src/orders/outbox/order-outbox.writer.js';
import { OrderCommandService } from '../../../order-service/src/orders/services/order-command.service.js';
import { ShipmentRecoveryService } from '../../../fulfillment-service/src/shipments/shipment-recovery.service.js';

export async function tripFixture(options: { optimizer?: boolean; dispatch?: boolean } = {}) {
  const base = process.env.TRIP_TEST_DATABASE_URL;
  if (!base || !new URL(base).pathname.startsWith('/logix_driver_test_trip_'))
    throw new Error('Trip tests require an owned, migrated isolated database');
  const driver = await driverFixture({ masterResources: true });
  const apps: INestApplication[] = [];
  const cleanups: Array<() => Promise<unknown>> = [() => driver.close()];
  const close = async () => {
    const failures: unknown[] = [];
    for (const app of apps.reverse()) {
      try {
        await app.close();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Trip fixture teardown failed');
  };
  try {
    const broker = await startIsolatedKafka();
    cleanups.push(() => broker.dispose());
    const admin = broker.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: [
          { topic: broker.topic, numPartitions: 1, replicationFactor: 1 },
        ],
        waitForLeaders: true,
      });
    } finally {
      await admin.disconnect();
    }
    const configure = async (app: INestApplication, port = 0) => {
      apps.push(app);
      app.setGlobalPrefix('api/v1');
      app.useGlobalFilters(new GlobalExceptionFilter());
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      );
      await app.listen(port, '127.0.0.1');
      return app.getUrl();
    };
    const warehouse = await driver.master.warehouse.create({
      data: {
        tenantId: driver.tenantId,
        code: `WH-${randomUUID()}`,
        name: 'Owned trip test depot',
        addressLine: '1 Test Street',
        province: 'Test Province',
        latitude: '10.123456',
        longitude: '106.123456',
        status: 'ACTIVE',
      },
    });
    let optimizerUrl = driver.masterUrl;
    const optimizerFault = { corruptHash: false, dropResponse: false, delayResponseMs: 0 };
    if (options.optimizer) {
      const root = fileURLToPath(new URL('../../../../', import.meta.url));
      const portServer = createServer();
      await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve));
      const address = portServer.address();
      if (!address || typeof address === 'string') throw new Error('Optimizer port allocation failed');
      const port = address.port;
      await new Promise<void>((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
      const python = process.env.ROUTE_OPTIMIZER_TEST_PYTHON;
      if (!python) throw new Error('ROUTE_OPTIMIZER_TEST_PYTHON must identify an installed optimizer Python environment');
      const child = spawn(python, ['-m', 'uvicorn', 'logix_route_optimizer.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'error'], {
        cwd: path.join(root, 'apps', 'route-optimizer-service'),
        env: {
          ...process.env, DATABASE_URL: base.replace('postgresql://', 'postgresql+asyncpg://'),
          INTERNAL_SERVICE_JWT_SECRET: driver.secret, OSRM_URL: 'http://127.0.0.1:1',
          OSRM_TIMEOUT_SECONDS: '0.2',
        }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostic = '';
      child.stderr.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
      cleanups.push(async () => {
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          child.kill();
          await exited;
        }
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Owned optimizer startup failed: ${diagnostic}`);
        try {
          const result = await fetch(`http://127.0.0.1:${port}/health/ready`);
          if (result.ok) { ready = true; break; }
        } catch { /* Startup readiness probe retries only while this owned process is alive. */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('Owned optimizer did not become ready');
      const optimizerProxy = createServer((incoming, outgoing) => {
        const upstream = httpRequest(new URL(incoming.url ?? '/', `http://127.0.0.1:${port}`), { method: incoming.method, headers: incoming.headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            if (optimizerFault.dropResponse && response.statusCode === 200) {
              optimizerFault.dropResponse = false;
              outgoing.destroy();
              return;
            }
            let body = Buffer.concat(chunks).toString();
            if (optimizerFault.corruptHash && response.statusCode === 200) {
              const payload: unknown = JSON.parse(body);
              if (payload && typeof payload === 'object') body = JSON.stringify({ ...payload, input_hash: 'f'.repeat(64) });
            }
            setTimeout(() => {
              outgoing.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' });
              outgoing.end(body);
            }, optimizerFault.delayResponseMs);
          });
        });
        upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
        incoming.pipe(upstream);
      });
      await new Promise<void>((resolve) => optimizerProxy.listen(0, '127.0.0.1', resolve));
      const proxyAddress = optimizerProxy.address();
      if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Optimizer proxy has no address');
      optimizerUrl = `http://127.0.0.1:${proxyAddress.port}`;
      cleanups.push(() => new Promise<void>((resolve, reject) => optimizerProxy.close((error) => error ? reject(error) : resolve())));
    }
    const internalToken = () =>
      signInternalServiceToken({
        secret: driver.secret,
        service: ServiceId.TRANSPORT_SERVICE,
        audience: ServiceId.FULFILLMENT_SERVICE,
        tenantId: driver.tenantId,
        ttlSeconds: 60,
      });
    const fault = { dropClaimResponse: false, dropReleaseResponse: false, dropBatchResponse: false, dropOrderBatchResponse: false };
    const proxy = (target: string) =>
      createServer((incoming, outgoing) => {
        const upstream = httpRequest(
          new URL(incoming.url ?? '/', target),
          {
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            if (
              ((fault.dropClaimResponse &&
                incoming.url === '/api/v1/internal/shipments/claim') ||
                (fault.dropReleaseResponse &&
                  incoming.url === '/api/v1/internal/shipments/release') ||
                (fault.dropBatchResponse && incoming.url === '/api/v1/internal/shipments/dispatch-batch') ||
                (fault.dropOrderBatchResponse && incoming.url === '/internal/orders/authorize-dispatch-batch')) &&
              (response.statusCode === 200 || response.statusCode === 201)
            ) {
              fault.dropClaimResponse = false;
              fault.dropReleaseResponse = false;
              fault.dropBatchResponse = false;
              fault.dropOrderBatchResponse = false;
              response.resume();
              response.once('end', () => outgoing.destroy());
            } else {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(outgoing);
            }
          },
        );
        upstream.on('error', (error) => {
          outgoing.writeHead(502, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: error.message }));
        });
        incoming.pipe(upstream);
      });
    const fulfillment = new FulfillmentPrisma(
      new ConfigService({ DATABASE_URL: base }),
    );
    await fulfillment.$connect();
    cleanups.push(() => fulfillment.$disconnect());
    const orders = new OrderPrisma(new ConfigService({ DATABASE_URL: base }));
    await orders.$connect();
    cleanups.push(() => orders.$disconnect());
    let orderBatch = new OrderDispatchBatchService(orders);
    const startOrders = async (port = 0) => {
    orderBatch = new OrderDispatchBatchService(orders);
    const orderModule = await Test.createTestingModule({
      controllers: [OrdersDispatchInternalController, OrdersFulfillmentInternalController],
      providers: [
        { provide: OrderDispatchService, useValue: new OrderDispatchService(orders) },
        { provide: OrderDispatchBatchService, useValue: orderBatch },
        { provide: OrderQueryService, useValue: new OrderQueryService(orders) },
        InternalServiceGuard,
        { provide: INTERNAL_SERVICE_AUTH_OPTIONS, useValue: { secret: driver.secret, serviceName: ServiceId.ORDER_SERVICE } },
      ],
    }).compile();
    const orderApp = orderModule.createNestApplication();
    apps.push(orderApp);
    orderApp.useGlobalFilters(new GlobalExceptionFilter());
    await orderApp.listen(port, '127.0.0.1');
    return { app: orderApp, url: await orderApp.getUrl() };
    };
    let orderRuntime = await startOrders();
    const orderProxy = proxy(orderRuntime.url);
    await new Promise<void>((resolve) => orderProxy.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => orderProxy.close((error) => error ? reject(error) : resolve())));
    const orderAddress = orderProxy.address();
    if (!orderAddress || typeof orderAddress === 'string') throw new Error('Owned Order proxy has no address');
    const orderUrl = `http://127.0.0.1:${orderAddress.port}`;
    const orderClient = new OrderClient(new ConfigService({ ORDER_SERVICE_URL: orderUrl, INTERNAL_SERVICE_JWT_SECRET: driver.secret }));
    let batchDispatch = new ShipmentDispatchBatchService(fulfillment, orderClient);
    const directDispatch = new ShipmentDispatchService(fulfillment, orderClient, new ShipmentQueryService(fulfillment));
    let inventory: InventoryPrisma | undefined;
    let orderCommands: OrderCommandService | undefined;
    if (options.dispatch) {
      inventory = new InventoryPrisma(new ConfigService({ DATABASE_URL: base }));
      await inventory.$connect();
      cleanups.push(() => inventory!.$disconnect());
      const module = await Test.createTestingModule({
        controllers: [ReservationsInternalController],
        providers: [
          { provide: ReservationService, useValue: new ReservationService(inventory) },
          InternalServiceGuard,
          { provide: INTERNAL_SERVICE_AUTH_OPTIONS, useValue: { secret: driver.secret, serviceName: ServiceId.INVENTORY_SERVICE } },
        ],
      }).compile();
      const inventoryUrl = await configure(module.createNestApplication());
      const inventoryClient = new InventoryClient(new ConfigService({
        INVENTORY_SERVICE_URL: `${inventoryUrl}/api/v1`, INTERNAL_SERVICE_JWT_SECRET: driver.secret,
      }));
      orderCommands = new OrderCommandService(orders,
        new OrderReferenceResolver(new OrderMasterClient(new ConfigService({ MASTER_DATA_SERVICE_URL: driver.masterUrl })),
          new ConfigService({ ORDER_MAX_LINES: 100 })),
        new OrderNumberService(), new OrderOutboxWriter(), inventoryClient);
    }
    const startFulfillment = async (port = 0) => {
    batchDispatch = new ShipmentDispatchBatchService(fulfillment, orderClient);
    const fulfillmentModule = await Test.createTestingModule({
      controllers: [InternalShipmentTripController],
      providers: [
        { provide: ShipmentDispatchBatchService, useValue: batchDispatch },
        {
          provide: ShipmentTripClaimService,
          useValue: new ShipmentTripClaimService(fulfillment),
        },
        {
          provide: ShipmentPoolService,
          useValue: new ShipmentPoolService(fulfillment),
        },
        InternalServiceGuard,
        {
          provide: INTERNAL_SERVICE_AUTH_OPTIONS,
          useValue: {
            secret: driver.secret,
            serviceName: ServiceId.FULFILLMENT_SERVICE,
          },
        },
      ],
    }).compile();
    const app = fulfillmentModule.createNestApplication();
    return { app, url: await configure(app, port) };
    };
    let fulfillmentRuntime = await startFulfillment();
    const fulfillmentUrl = fulfillmentRuntime.url;
    const fulfillmentProxy = proxy(fulfillmentUrl);
    await new Promise<void>((resolve) =>
      fulfillmentProxy.listen(0, '127.0.0.1', resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          fulfillmentProxy.close((error) =>
            error ? reject(error) : resolve(),
          ),
        ),
    );
    const proxyAddress = fulfillmentProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string')
      throw new Error('Fulfillment fault proxy has no TCP address');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      SERVICE_NAME: ServiceId.TRANSPORT_SERVICE,
      PORT: '3006',
      DATABASE_URL: `${base}?schema=transport`,
      JWT_SECRET: driver.secret,
      INTERNAL_SERVICE_JWT_SECRET: driver.secret,
      MASTER_DATA_SERVICE_URL: driver.masterUrl,
      FULFILLMENT_SERVICE_URL: `http://127.0.0.1:${proxyAddress.port}`,
      ROUTE_OPTIMIZER_SERVICE_URL: optimizerUrl,
      ROUTE_OPTIMIZER_TIMEOUT_MS: '30000',
      KAFKA_BROKERS: broker.brokers.join(','),
      KAFKA_CLIENT_ID: broker.groupId,
      KAFKA_GROUP_ID: broker.groupId,
      KAFKA_FULFILLMENT_TOPIC: broker.topic,
      KAFKA_TRANSPORT_TOPIC: broker.topic,
      OUTBOX_INTERVAL_MS: '100',
      OUTBOX_BATCH_SIZE: '10',
      OUTBOX_RETRY_BASE_MS: '100',
      OUTBOX_RETRY_MAX_MS: '1000',
      OUTBOX_TRANSACTION_TIMEOUT_MS: '30000',
      RECOVERY_INTERVAL_MS: '60000',
    });
    const { AppModule: TransportModule } =
      await import('../../src/app.module.js');
    const startTransport = async (port = 0) => {
      const module = await Test.createTestingModule({
        imports: [TransportModule],
      }).compile();
      const app = module.createNestApplication();
      const url = await configure(app, port);
      return { app, url };
    };
    let transport = await startTransport();
    const transportPort = Number(new URL(transport.url).port);
    const { AppModule: GatewayModule } =
      await import('../../../api-gateway/src/app.module.js');
    const gateway = await Test.createTestingModule({ imports: [GatewayModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          MASTER_DATA_SERVICE_URL: driver.masterUrl,
          IDENTITY_SERVICE_URL: driver.identityUrl,
          ORDER_SERVICE_URL: orderUrl,
          FULFILLMENT_SERVICE_URL: fulfillmentUrl,
          TRANSPORT_SERVICE_URL: transport.url,
        }),
      )
      .compile();
    const gatewayApp = gateway.createNestApplication();
    apps.push(gatewayApp);
    await gatewayApp.listen(0, '127.0.0.1');
    const url = await gatewayApp.getUrl();

    const seed = async (
      options: {
        warehouseId?: string;
        addressId?: string;
        weight?: string;
        volume?: string;
        coordinates?: boolean;
      } = {},
    ) => {
      const id = randomUUID(),
        orderId = randomUUID();
      const addressId = options.addressId ?? randomUUID();
      const shipment = await fulfillment.shipment.create({
        data: {
          id,
          tenantId: driver.tenantId,
          shipmentNumber: `QA-${id}`,
          orderId,
          warehouseId: options.warehouseId ?? warehouse.id,
          deliveryAddressId: addressId,
          customerSnapshot: {
            customerId: randomUUID(),
            code: 'QA-C',
            name: 'QA customer',
          },
          deliveryAddressSnapshot: {
            addressId,
            addressVersion: 1,
            addressType: 'SHIPPING',
            label: null,
            recipientName: 'QA recipient',
            phone: null,
            addressLine: 'QA address',
            ward: null,
            district: null,
            province: 'QA province',
            postalCode: null,
            deliveryNote: null,
            ...(options.coordinates === false
              ? {}
              : { latitude: '10.234567', longitude: '106.234567' }),
          },
          warehouseSnapshot: {
            warehouseId: options.warehouseId ?? warehouse.id,
            code: 'QA-W',
            name: 'QA warehouse',
          },
          orderNumber: `QA-${orderId}`,
          confirmedOrderVersion: 2n,
          status: 'READY_TO_SHIP',
          totalWeight: options.weight ?? '1.125',
          totalVolume: options.volume ?? '0.011250',
          reservationGroupId: randomUUID(),
          version: 3n,
          items: {
            create: [
              {
                tenantId: driver.tenantId,
                orderLineId: randomUUID(),
                productId: randomUUID(),
                skuSnapshot: 'QA-TRIP-CLAIM',
                productNameSnapshot: 'QA product',
                unitSnapshot: 'PCS',
                quantity: '1.125',
                weight: options.weight ?? '1.125',
                volume: options.volume ?? '0.011250',
              },
            ],
          },
        },
      });
      await orders.salesOrder.create({
        data: {
          id: orderId,
          tenantId: driver.tenantId,
          orderNumber: shipment.orderNumber,
          customerId: randomUUID(),
          deliveryAddressId: addressId,
          warehouseId: shipment.warehouseId,
          customerSnapshot: { name: 'QA customer' },
          deliveryAddressSnapshot: { addressId, addressLine: 'QA address' },
          warehouseSnapshot: { warehouseId: shipment.warehouseId },
          currency: 'VND',
          status: 'CONFIRMED',
          orderSource: 'MANUAL',
          totalQuantity: '1.125',
          totalWeight: shipment.totalWeight,
          totalVolume: shipment.totalVolume,
          reservationGroupId: shipment.reservationGroupId,
          version: 2n,
        },
      });
      return shipment;
    };
    cleanups.push(async () => {
      const where = {
        tenantId: { in: [driver.tenantId, driver.otherTenantId] },
      };
      await driver.transport.$transaction(async (tx) => {
        await tx.deliveryTrip.updateMany({
          where,
          data: { approvedRoutePlanId: null },
        });
        await tx.routePlanStop.deleteMany({ where });
        await tx.deliveryAttempt.deleteMany({ where });
        await tx.tripDispatch.deleteMany({ where });
        await tx.routePlan.deleteMany({ where });
        await tx.tripStop.deleteMany({ where });
        await tx.tripShipment.deleteMany({ where });
        await tx.tripOperation.deleteMany({ where });
        await tx.deliveryTrip.deleteMany({ where });
        await tx.inboxEvent.deleteMany({ where });
        await tx.outboxEvent.deleteMany({ where });
      });
      await fulfillment.shipmentDispatchIntent.deleteMany({ where });
      await fulfillment.shipmentDispatchBatch.deleteMany({ where });
      await fulfillment.shipmentStatusHistory.deleteMany({ where });
      await fulfillment.outboxEvent.deleteMany({ where });
      await fulfillment.shipmentTripReceipt.deleteMany({ where });
      await fulfillment.shipmentItem.deleteMany({ where });
      await fulfillment.shipment.deleteMany({ where });
      await orders.orderStatusHistory.deleteMany({ where });
      await orders.outboxEvent.deleteMany({ where });
      await orders.salesOrder.deleteMany({ where });
      await orders.orderDispatchBatch.deleteMany({ where });
    });
    return {
      url,
      driver,
      broker,
      warehouse,
      fulfillment,
      fulfillmentUrl,
      orders,
      inventory,
      orderCommands,
      get orderBatch() { return orderBatch; },
      orderClient,
      orderUrl,
      get batchDispatch() { return batchDispatch; },
      directDispatch,
      transportService: <T>(token: import('@nestjs/common').Type<T>) => transport.app.get(token),
      internalToken,
      fault,
      optimizerUrl,
      optimizerFault,
      relay: () => transport.app.get(OutboxRelay),
      seed,
      close,
      async restartTransport() {
        apps.splice(apps.indexOf(transport.app), 1);
        await transport.app.close();
        transport = await startTransport(transportPort);
      },
      async restartFulfillment() {
        apps.splice(apps.indexOf(fulfillmentRuntime.app), 1);
        await fulfillmentRuntime.app.close();
        fulfillmentRuntime = await startFulfillment(Number(new URL(fulfillmentUrl).port));
      },
      async restartOrders() {
        apps.splice(apps.indexOf(orderRuntime.app), 1);
        await orderRuntime.app.close();
        orderRuntime = await startOrders(Number(new URL(orderRuntime.url).port));
      },
      recoverFulfillment() {
        return new ShipmentRecoveryService(fulfillment, directDispatch, new ConfigService({
          OUTBOX_BATCH_SIZE: 100, OUTBOX_RETRY_BASE_MS: 100, OUTBOX_RETRY_MAX_MS: 1000,
        }), batchDispatch).recover();
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Trip fixture startup and cleanup failed',
      );
    }
    throw error;
  }
}
