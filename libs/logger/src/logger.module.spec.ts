import { Writable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogixLoggerModule } from './logger.module.js';

afterEach(() => vi.restoreAllMocks());

async function serializeRequest(nodeEnv: string) {
  const registration = vi
    .spyOn(PinoLoggerModule, 'forRootAsync')
    .mockReturnValue({ module: PinoLoggerModule });
  LogixLoggerModule.forRoot({ serviceName: 'logger-test' });
  const factory = registration.mock.calls[0]?.[0].useFactory;
  if (!factory) throw new Error('Logger configuration factory is missing');
  const { pinoHttp } = await factory(new ConfigService({ NODE_ENV: nodeEnv }));
  if (!pinoHttp || Array.isArray(pinoHttp) || !('redact' in pinoHttp)) {
    throw new Error('Expected one HTTP logger configuration');
  }
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const logger = pino({ redact: pinoHttp.redact }, destination);
  logger.info({
    req: {
      method: 'POST',
      headers: {
        authorization: 'Bearer qa-access-token',
        cookie: 'qa-session-cookie',
        'x-internal-service-token': 'qa-internal-token',
        'x-correlation-id': 'qa-correlation',
      },
      body: {
        password: 'qa-password',
        token: 'qa-token',
        secret: 'qa-secret',
        apiKey: 'qa-api-key',
        appSecret: 'qa-app-secret',
      },
    },
  });
  const entry: unknown = JSON.parse(output);
  return { output, entry };
}

describe('LogixLoggerModule credential redaction', () => {
  it.each(['development', 'production'])(
    'redacts internal service credentials in %s',
    async (nodeEnv) => {
      const { output, entry } = await serializeRequest(nodeEnv);
      expect(entry).toMatchObject({
        req: {
          method: 'POST',
          headers: {
            'x-internal-service-token': '[REDACTED]',
            'x-correlation-id': 'qa-correlation',
          },
        },
      });
      expect(output).not.toContain('qa-internal-token');
    },
  );

  it('preserves existing access-token, cookie and body-secret redaction', async () => {
    const { entry } = await serializeRequest('production');
    expect(entry).toMatchObject({
      req: {
        headers: { authorization: '[REDACTED]', cookie: '[REDACTED]' },
        body: {
          password: '[REDACTED]',
          token: '[REDACTED]',
          secret: '[REDACTED]',
          apiKey: '[REDACTED]',
          appSecret: '[REDACTED]',
        },
      },
    });
  });
});
