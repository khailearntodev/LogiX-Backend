import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
      .send({ email: 'test@example.com', password: 'password123' })
      .expect((res) => {
        // Should be proxied or reach error filter without hanging on JSON body
        if (res.status !== 201 && res.status !== 400 && res.status !== 409 && res.status !== 500 && res.status !== 502) {
          throw new Error(`Expected valid HTTP status, got ${res.status}`);
        }
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
