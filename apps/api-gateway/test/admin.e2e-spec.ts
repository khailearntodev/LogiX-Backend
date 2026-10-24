import 'reflect-metadata';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

describe('Admin Gateway HTTP proxy (isolated upstream fixture, not Identity/PostgreSQL)', () => {
  let app: INestApplication;
  let server: Server;
  let upstream: Server;
  let status = 200;
  let received: { url?: string; headers: IncomingHttpHeaders; body: string }[];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            status === 200
              ? { items: [], page: 2, pageSize: 10, total: 0 }
              : {
                  statusCode: status,
                  error: `UPSTREAM_${status}`,
                  message: 'Fixture response',
                },
          ),
        );
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected isolated TCP upstream');
    const target = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('SERVICE_NAME', 'api-gateway-admin-test');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('IDENTITY_SERVICE_URL', target);
    vi.stubEnv('ORDER_SERVICE_URL', target);
    vi.stubEnv('FULFILLMENT_SERVICE_URL', target);
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer();
  });

  beforeEach(() => {
    received = [];
    status = 200;
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

  it.each(['organizations', 'users'])(
    'forwards %s path, query and credentials without rewriting scope',
    async (resource) => {
      const credential = randomBytes(24).toString('hex');
      const result = await request(server)
        .get(
          `/api/v1/admin/${resource}?page=2&pageSize=10&q=AcMe&status=ACTIVE`,
        )
        .set('Authorization', `Bearer ${credential}`)
        .set('Cookie', `accessToken=${credential}`)
        .set('x-tenant-id', 'conflicting-context')
        .set('x-correlation-id', 'admin-proxy-test')
        .expect(200);
      expect(result.body).toEqual({
        items: [],
        page: 2,
        pageSize: 10,
        total: 0,
      });
      expect(received).toHaveLength(1);
      expect(received[0].url).toBe(
        `/api/v1/admin/${resource}?page=2&pageSize=10&q=AcMe&status=ACTIVE`,
      );
      expect(received[0].headers).toMatchObject({
        authorization: `Bearer ${credential}`,
        cookie: `accessToken=${credential}`,
        'x-tenant-id': 'conflicting-context',
        'x-correlation-id': 'admin-proxy-test',
      });
    },
  );

  it.each([400, 401, 403, 500])(
    'preserves upstream %i instead of success-shaped fallback',
    async (code) => {
      status = code;
      const response = await request(server)
        .get('/api/v1/admin/users')
        .expect(code);
      expect(response.body).toEqual({
        statusCode: code,
        error: `UPSTREAM_${code}`,
        message: 'Fixture response',
      });
    },
  );

  it('preserves the parsed JSON body on existing auth POST routes', async () => {
    const body = { intent: 'proxy-regression-fixture' };
    await request(server).post('/api/v1/auth/login').send(body).expect(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(JSON.stringify(body));
    expect(received[0].headers['content-type']).toContain('application/json');
  });

  it.each([
    '/api/v1/admin',
    '/api/v1/admin/users/nested',
    '/api/v1/auth',
    '/api/v1/iam/roles',
  ])('registers the base and subpath Identity route %s', async (path) => {
    await request(server).get(path).expect(200);
    expect(received[0].url).toBe(path);
  });

  it.each([
    '/api/v1/administrator',
    '/api/v1/admin-other',
    '/api/v1/authentic',
    '/api/v1/iam-other',
  ])('does not forward unrelated prefix %s', async (path) => {
    await request(server).get(path).expect(404);
    expect(received).toHaveLength(0);
  });

  it('returns 502 without credentials/stack/internal target when the upstream is unavailable', async () => {
    const closed = once(upstream, 'close');
    upstream.close();
    upstream.closeAllConnections();
    await closed;
    const response = await request(server)
      .get('/api/v1/admin/users')
      .expect(502);
    expect(response.body).toMatchObject({
      statusCode: 502,
      error: 'Bad Gateway',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /stack|ECONNREFUSED|127\.0\.0\.1|Bearer|accessToken/,
    );
  });
});
