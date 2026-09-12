import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

export interface LogixLoggerModuleOptions {
  /** Service name to include in every log line. */
  serviceName: string;
}

/**
 * LogixLoggerModule — Structured logging for all LogiX services.
 *
 * Features:
 * - JSON structured output in production, pretty-print in development
 * - Auto-injects serviceName into every log line
 * - HTTP request/response logging with latency
 * - Redacts sensitive fields (password, token, secret, authorization)
 * - Correlation ID propagation via X-Correlation-ID header
 *
 * @see docs/architecture/runtime-architecture.md §6 (Observability)
 */
@Module({})
export class LogixLoggerModule {
  static forRoot(options: LogixLoggerModuleOptions): DynamicModule {
    return {
      module: LogixLoggerModule,
      imports: [
        PinoLoggerModule.forRootAsync({
          imports: [],
          providers: [],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            const nodeEnv =
              config.get<string>('NODE_ENV') ?? 'development';
            const isProduction = nodeEnv === 'production';

            return {
              pinoHttp: {
                // Structured JSON in production, pretty-print in development
                transport: isProduction
                  ? undefined
                  : {
                      target: 'pino-pretty',
                      options: {
                        colorize: true,
                        singleLine: false,
                        translateTime: 'SYS:HH:MM:ss.l',
                        ignore: 'pid,hostname',
                      },
                    },

                level: isProduction ? 'info' : 'debug',

                // Redact sensitive fields from logs
                // @see docs/architecture/runtime-architecture.md §5
                redact: {
                  paths: [
                    'req.headers.authorization',
                    'req.headers.cookie',
                    'req.body.password',
                    'req.body.token',
                    'req.body.secret',
                    'req.body.apiKey',
                    'req.body.appSecret',
                  ],
                  censor: '[REDACTED]',
                },

                // Base context attached to every log line
                base: {
                  service: options.serviceName,
                },

                // Auto-generate request ID from X-Correlation-ID header
                genReqId: (req: any) => {
                  const correlationId = req.headers?.['x-correlation-id'];
                  if (typeof correlationId === 'string' && correlationId) {
                    return correlationId;
                  }
                  // Generate a new one if not provided
                  return crypto.randomUUID();
                },

                // Customize serialized request log
                customProps: (req: any) => ({
                  correlationId: req.id != null ? String(req.id) : undefined,
                  tenantId: req.headers?.['x-tenant-id'] ?? undefined,
                }),

                // Suppress logging for health check endpoints
                autoLogging: {
                  ignore: (req: any) =>
                    req.url === '/health' || req.url === '/ready',
                },
              },
            };
          },
        }),
      ],
      exports: [PinoLoggerModule],
    };
  }
}
