import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let upstream: Server;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, path: req.url }));
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected isolated Gateway upstream');
    const target = `http://127.0.0.1:${address.port}`;
    for (const name of [
      'IDENTITY_SERVICE_URL',
      'MASTER_DATA_SERVICE_URL',
      'ORDER_SERVICE_URL',
      'FULFILLMENT_SERVICE_URL',
      'TRANSPORT_SERVICE_URL',
    ])
      vi.stubEnv(name, target);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SERVICE_NAME', 'api-gateway-test');
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/api/v1/auth/register (POST with body) - proxies request without hanging', () => {
    return request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `${randomUUID()}@example.test`, password: randomUUID() })
      .expect(201)
      .expect({ accepted: true, path: '/api/v1/auth/register' });
  });

  afterAll(async () => {
    await app?.close();
    if (upstream?.listening) {
      const closed = once(upstream, 'close');
      upstream.close();
      upstream.closeAllConnections();
      await closed;
    }
    vi.unstubAllEnvs();
  });
});
