import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import request from 'supertest';
import { PrismaService as FulfillmentDatabase } from '../src/database/prisma.service.js';
import { PrismaService as OrderDatabase } from '../../order-service/dist/database/prisma.service.js';
import { PrismaService as InventoryDatabase } from '../../inventory-service/dist/database/prisma.service.js';

const START_TIMEOUT_MS = 90_000;
const CONVERGENCE_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const services = [
  'inventory-service',
  'order-service',
  'fulfillment-service',
  'api-gateway',
] as const;
type Service = (typeof services)[number];

export async function eventually<T>(
  description: string,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeout = CONVERGENCE_TIMEOUT_MS,
): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (accepts(last)) return last;
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  throw new Error(
    `Timed out: ${description}; last=${JSON.stringify(
      last,
      (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
    )}`,
  );
}

export class PickPackStack {
  readonly tag = `qa.pickpack.${randomUUID()}`;
  readonly tenantId = randomUUID();
  readonly actorId = randomUUID();
  readonly secret = randomBytes(48).toString('hex');
  readonly internalSecret = randomBytes(48).toString('hex');
  readonly root = resolve(process.cwd(), '..', '..');
  readonly container = this.tag.replaceAll('.', '-');
  readonly topics = ['orders', 'inventory', 'fulfillment'].map(
    (suffix) => `${this.tag}.${suffix}`,
  );
  readonly processes = new Map<Service, ChildProcess>();
  readonly environments = new Map<Service, NodeJS.ProcessEnv>();
  readonly urls = new Map<Service, string>();
  readonly groups: string[] = [];
  private containerOwned = false;
  private topicsOwned = false;
  private admin: ReturnType<Kafka['admin']> | undefined;
  private producer: ReturnType<Kafka['producer']> | undefined;
  private lastErrors = new Map<Service, string>();
  databaseUrl!: string;
  fulfillment!: FulfillmentDatabase;
  orders!: OrderDatabase;
  inventory!: InventoryDatabase;
  sql!: Pool;

  private command(
    program: string,
    args: string[],
    env = process.env,
    cwd = this.root,
  ) {
    const result = spawnSync(program, args, {
      cwd,
      env,
      encoding: 'utf8',
      shell: program === 'pnpm',
      timeout: 120_000,
    });
    if (result.error || result.status !== 0) {
      const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL redacted]')
        .replaceAll(this.secret, '[redacted]')
        .replaceAll(this.internalSecret, '[redacted]');
      throw new Error(
        `${program} ${args.join(' ').replace(/POSTGRES_PASSWORD=\S+/g, 'POSTGRES_PASSWORD=[redacted]')} failed; exit=${result.status}; ${result.error?.name ?? ''}\n${diagnostic.slice(-4000)}`,
      );
    }
    return result.stdout.trim();
  }

  private async freePort(host: string) {
    const server = createServer();
    server.listen(0, host);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Cannot allocate QA port');
    const port = address.port;
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    return port;
  }

  async start() {
    if (process.env.PICK_PACK_STACK_E2E !== '1')
      throw new Error('Explicit QA stack opt-in required');
    const host = process.env.PICK_PACK_TEST_HOST;
    const image = process.env.PICK_PACK_POSTGRES_IMAGE;
    if (host !== '127.0.0.1' || !image)
      throw new Error(
        'Require PICK_PACK_TEST_HOST=127.0.0.1 and PICK_PACK_POSTGRES_IMAGE (existing local image)',
      );
    this.command('docker', ['info', '--format', '{{.ServerVersion}}']);
    this.command('docker', ['image', 'inspect', image]);
    const password = randomBytes(32).toString('hex');
    this.command('docker', [
      'run',
      '--detach',
      '--name',
      this.container,
      '--label',
      `logix.qa.owner=${this.tag}`,
      '--env',
      'POSTGRES_USER=pickpack',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=pickpack',
      '--publish',
      `${host}::5432`,
      image,
    ]);
    this.containerOwned = true;
    process.stdout.write(`QA stack owned: ${this.tag}\n`);
    const binding = this.command('docker', [
      'port',
      this.container,
      '5432/tcp',
    ]);
    const port = Number(binding.split(':').at(-1));
    if (!Number.isInteger(port))
      throw new Error('Invalid isolated PostgreSQL port');
    this.databaseUrl = `postgresql://pickpack:${password}@${host}:${port}/pickpack`;
    this.sql = new Pool({
      connectionString: this.databaseUrl,
      connectionTimeoutMillis: 1000,
    });
    await eventually(
      'isolated PostgreSQL readiness',
      async () => {
        try {
          await this.sql.query('SELECT 1');
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'Connection terminated unexpectedly'
          )
            return false;
          if (
            error instanceof Error &&
            'code' in error &&
            ['ECONNREFUSED', '57P03', 'ECONNRESET'].includes(String(error.code))
          )
            return false;
          throw error;
        }
      },
      Boolean,
      START_TIMEOUT_MS,
    );

    for (const service of services) {
      const servicePort = await this.freePort(host);
      this.urls.set(service, `http://${host}:${servicePort}`);
    }
    const source = dotenv.parse(
      readFileSync(resolve(this.root, 'apps', 'fulfillment-service', '.env')),
    );
    if (!source.KAFKA_BROKERS) throw new Error('Local KAFKA_BROKERS required');
    const kafka = new Kafka({
      clientId: this.tag,
      brokers: source.KAFKA_BROKERS.split(',').map((broker) => broker.trim()),
      logLevel: logLevel.NOTHING,
    });
    this.admin = kafka.admin();
    await this.admin.connect();
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: this.topics.map((topic) => ({
        topic,
        numPartitions: 1,
        replicationFactor: 1,
      })),
    });
    this.topicsOwned = true;
    this.producer = kafka.producer();
    await this.producer.connect();
    for (const service of services) {
      const local = dotenv.parse(
        readFileSync(resolve(this.root, 'apps', service, '.env')),
      );
      const group = `${this.tag}.${service}`;
      this.groups.push(group);
      const environment = {
        ...process.env,
        ...local,
        NODE_ENV: 'test',
        PORT: new URL(this.url(service)).port,
        DATABASE_URL: `${this.databaseUrl}?schema=${
          service === 'order-service'
            ? 'orders'
            : service === 'inventory-service'
              ? 'inventory'
              : 'fulfillment'
        }`,
        JWT_SECRET: this.secret,
        INTERNAL_SERVICE_JWT_SECRET: this.internalSecret,
        KAFKA_BROKERS: source.KAFKA_BROKERS,
        KAFKA_CLIENT_ID: group,
        KAFKA_GROUP_ID: group,
        KAFKA_ORDER_TOPIC: this.topics[0],
        KAFKA_INVENTORY_TOPIC: this.topics[1],
        KAFKA_FULFILLMENT_TOPIC: this.topics[2],
        ORDER_SERVICE_URL: this.url('order-service'),
        INVENTORY_SERVICE_URL: this.url('inventory-service'),
        FULFILLMENT_SERVICE_URL: this.url('fulfillment-service'),
        OUTBOX_INTERVAL_MS: '100',
        OUTBOX_RETRY_BASE_MS: '100',
        OUTBOX_RETRY_MAX_MS: '1000',
        RESERVATION_RECONCILE_AGE_MS: '3600000',
        RESERVATION_RECONCILE_INTERVAL_MS: '3600000',
      };
      this.environments.set(service, environment);
      if (service !== 'api-gateway') {
        this.command(
          'pnpm',
          ['--filter', service, 'db:migrate:deploy'],
          environment,
        );
      }
    }
    const config = new ConfigService({ DATABASE_URL: this.databaseUrl });
    this.fulfillment = new FulfillmentDatabase(config);
    this.orders = new OrderDatabase(config);
    this.inventory = new InventoryDatabase(config);
    await Promise.all([
      this.fulfillment.$connect(),
      this.orders.$connect(),
      this.inventory.$connect(),
    ]);
    await Promise.all(services.map((service) => this.startService(service)));
    await this.http().get('/api/v1/shipments').expect(401);
    await this.http().get('/api/v1/orders').expect(401);
  }

  url(service: Service) {
    const url = this.urls.get(service);
    if (!url) throw new Error(`QA URL not allocated: ${service}`);
    return url;
  }

  async startService(service: Service) {
    if (this.processes.has(service))
      throw new Error(`QA process already owned: ${service}`);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "process.on('message', message => { if (message === 'shutdown') process.emit('SIGTERM'); }); await import('./dist/main.js');",
      ],
      {
        cwd: resolve(this.root, 'apps', service),
        env: this.environments.get(service),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    this.processes.set(service, child);
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (/EADDRINUSE|Error:|ERROR|error TS/.test(text))
          this.lastErrors.set(service, text.slice(-2000));
      });
    const route =
      service === 'order-service'
        ? '/api/v1/orders/health'
        : service === 'inventory-service'
          ? '/api/v1/inventory/balances'
          : service === 'api-gateway'
            ? '/api/v1'
            : '/api/v1';
    await eventually(
      `${service} HTTP readiness`,
      async () => {
        if (child.exitCode !== null) {
          const diagnostic = this.lastErrors
            .get(service)
            ?.replaceAll(this.secret, '[redacted]')
            .replaceAll(this.internalSecret, '[redacted]')
            .replaceAll(this.databaseUrl, '[redacted]');
          throw new Error(
            `${service} exited ${child.exitCode}: ${diagnostic ?? 'no error log'}`,
          );
        }
        try {
          const response = await fetch(this.url(service) + route, {
            signal: AbortSignal.timeout(1000),
          });
          return [200, 401, 404].includes(response.status);
        } catch (error) {
          if (
            error instanceof TypeError ||
            (error instanceof Error && error.name === 'TimeoutError')
          )
            return false;
          throw error;
        }
      },
      Boolean,
      START_TIMEOUT_MS,
    );
  }

  async stopService(service: Service) {
    const child = this.processes.get(service);
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (child.connected) child.send('shutdown');
      else child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`Graceful QA shutdown timed out: ${service}`));
            }, 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.processes.delete(service);
  }

  token(permissions: string[], tenantId: string = this.tenantId) {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      sub: this.actorId,
      tenantId,
      email: `${this.tag}@example.test`,
      permissions,
      iat: now,
      exp: now + 3600,
    })}`;
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  http() {
    return request(this.url('api-gateway'));
  }

  async seed(sku = 'QA-SKU', multipleLines = false) {
    const orderId = randomUUID(),
      lineId = randomUUID(),
      productId = randomUUID();
    const warehouseId = randomUUID(),
      customerId = randomUUID(),
      addressId = randomUUID();
    const secondLineId = randomUUID(),
      secondProductId = randomUUID();
    await this.inventory.inventoryBalance.create({
      data: {
        tenantId: this.tenantId,
        warehouseId,
        productId,
        onHandQuantity: '10.500',
        reservedQuantity: '0',
        lowStockThreshold: '0',
      },
    });
    if (multipleLines)
      await this.inventory.inventoryBalance.create({
        data: {
          tenantId: this.tenantId,
          warehouseId,
          productId: secondProductId,
          onHandQuantity: '10.500',
          reservedQuantity: '0',
          lowStockThreshold: '0',
        },
      });
    await this.orders.salesOrder.create({
      data: {
        id: orderId,
        tenantId: this.tenantId,
        orderNumber: `QA-${orderId}`,
        customerId,
        deliveryAddressId: addressId,
        warehouseId,
        customerSnapshot: { customerId, code: 'QA', name: 'QA customer' },
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
          latitude: null,
          longitude: null,
          deliveryNote: null,
        },
        warehouseSnapshot: { warehouseId, code: 'QA', name: 'QA warehouse' },
        currency: 'VND',
        status: 'DRAFT',
        orderSource: 'MANUAL',
        totalQuantity: multipleLines ? '2.250' : '1.125',
        totalWeight: multipleLines ? '2.250' : '1.125',
        totalVolume: multipleLines ? '0.022500' : '0.011250',
        lines: {
          create: [
            {
              id: lineId,
              tenantId: this.tenantId,
              lineNumber: 1,
              productId,
              skuSnapshot: sku,
              productNameSnapshot: 'QA product',
              unitSnapshot: 'PCS',
              quantity: '1.125',
              unitWeight: '1',
              unitVolume: '0.01',
            },
            ...(multipleLines
              ? [
                  {
                    id: secondLineId,
                    tenantId: this.tenantId,
                    lineNumber: 2,
                    productId: secondProductId,
                    skuSnapshot: 'QA-SECOND-SKU',
                    productNameSnapshot: 'QA second product',
                    unitSnapshot: 'BOX',
                    quantity: '1.125',
                    unitWeight: '1',
                    unitVolume: '0.01',
                  },
                ]
              : []),
          ],
        },
      },
    });
    await this.http()
      .post(`/api/v1/orders/${orderId}/confirm`)
      .set(
        'Authorization',
        `Bearer ${this.token(['order:sales-order:approve'])}`,
      )
      .send({ version: 1 })
      .expect(200);
    const shipment = await eventually(
      'OrderConfirmed creates one Shipment',
      () =>
        this.fulfillment.shipment.findUnique({
          where: { tenantId_orderId: { tenantId: this.tenantId, orderId } },
        }),
      (row) => row?.status === 'PENDING_PICK',
    );
    if (!shipment) throw new Error('Shipment missing after convergence');
    await eventually(
      'Inventory acknowledges OrderConfirmed',
      () => this.inventory.reservationGroup.findFirst({ where: { orderId } }),
      (group) =>
        group?.acknowledgedAt !== null && group?.acknowledgedAt !== undefined,
    );
    return {
      orderId,
      lineId,
      productId,
      secondLineId,
      secondProductId,
      warehouseId,
      shipmentId: shipment.id,
    };
  }

  async publish(topic: number, event: object) {
    if (!this.producer || !('aggregateId' in event))
      throw new Error('QA producer/envelope required');
    await this.producer.send({
      topic: this.topics[topic],
      messages: [
        {
          key: String(event.aggregateId),
          value: JSON.stringify(event),
        },
      ],
    });
  }

  async close() {
    const errors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const service of [...services].reverse())
      await cleanup(() => this.stopService(service));
    await cleanup(async () => this.producer?.disconnect());
    await cleanup(async () => this.fulfillment?.$disconnect());
    await cleanup(async () => this.orders?.$disconnect());
    await cleanup(async () => this.inventory?.$disconnect());
    await cleanup(async () => this.sql?.end());
    if (this.admin) {
      if (this.topicsOwned) {
        await cleanup(async () => {
          const listed = await this.admin!.listGroups();
          const owned = listed.groups
            .map((g) => g.groupId)
            .filter((g) => g.startsWith(`${this.tag}.`));
          if (owned.length) {
            const deleted = await this.admin!.deleteGroups(owned);
            if (deleted.some((result) => result.errorCode !== 0))
              throw new Error('QA consumer groups not fully deleted');
            const remaining = (await this.admin!.listGroups()).groups.filter(
              (group) => group.groupId.startsWith(`${this.tag}.`),
            );
            if (remaining.length)
              throw new Error('QA consumer groups remain after deletion');
          }
        });
        await cleanup(async () => {
          await this.admin!.deleteTopics({ topics: this.topics });
          await eventually(
            'QA topics deleted',
            () => this.admin!.listTopics(),
            (topics) => this.topics.every((topic) => !topics.includes(topic)),
          );
        });
      }
      await cleanup(() => this.admin!.disconnect());
    }
    if (this.containerOwned)
      await cleanup(async () => {
        this.command('docker', ['rm', '--force', this.container]);
        const names = this.command('docker', [
          'ps',
          '--all',
          '--format',
          '{{.Names}}',
        ]);
        if (names.split(/\r?\n/).includes(this.container))
          throw new Error('QA container remains');
      });
    if (errors.length)
      throw new AggregateError(errors, 'QA stack cleanup failed');
  }
}
