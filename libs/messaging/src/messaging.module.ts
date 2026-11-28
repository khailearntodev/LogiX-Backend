import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel } from 'kafkajs';
import { KafkaProducerService } from './kafka-producer.service.js';

export interface MessagingModuleOptions {
  /**
   * When true, registers the KafkaProducerService for publishing events.
   * @default true
   */
  enableProducer?: boolean;
}

/**
 * MessagingModule — Domain event messaging for LogiX services.
 *
 * Wraps kafkajs with NestJS lifecycle management and environment-driven
 * configuration.
 *
 * @example
 * // In a service's AppModule:
 * @Module({
 *   imports: [
 *     MessagingModule.forRoot(),
 *   ],
 * })
 * export class AppModule {}
 *
 * @see docs/architecture/event-architecture.md
 */
@Module({})
export class MessagingModule {
  static forRoot(options: MessagingModuleOptions = {}): DynamicModule {
    const enableProducer = options.enableProducer ?? true;

    const kafkaProvider = {
      provide: Kafka,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const brokersValue = config.getOrThrow<string | string[]>('KAFKA_BROKERS');
        const brokers = Array.isArray(brokersValue)
          ? brokersValue
          : brokersValue.split(',').map((broker) => broker.trim());
        if (brokers.length === 0 || brokers.some((broker) => !broker)) {
          throw new Error('KAFKA_BROKERS must contain at least one broker');
        }
        const clientId = config.getOrThrow<string>('KAFKA_CLIENT_ID');
        const connectionTimeout = config.get<number>('KAFKA_CONNECTION_TIMEOUT_MS') ?? 3000;
        // Keep shared client requestTimeout >= consumer JoinGroup/Fetch wait (default 25s);
        // producer send budget is enforced per-call in KafkaProducerService.
        const requestTimeout = config.get<number>('KAFKA_REQUEST_TIMEOUT_MS') ?? 25000;

        return new Kafka({
          clientId,
          brokers,
          logLevel: logLevel.WARN,
          connectionTimeout,
          requestTimeout,
          retry: {
            initialRetryTime: 200,
            maxRetryTime: 1000,
            retries: 3,
          },
        });
      },
    };

    const providers: Provider[] = [kafkaProvider];
    const exports: Array<typeof Kafka | typeof KafkaProducerService> = [Kafka];

    if (enableProducer) {
      providers.push({
        provide: KafkaProducerService,
        inject: [Kafka, ConfigService],
        useFactory: (kafka: Kafka, config: ConfigService) =>
          new KafkaProducerService(kafka, {
            maxRetries: config.get<number>('KAFKA_PRODUCER_MAX_RETRIES') ?? 1,
            sendTimeoutMs: config.get<number>('KAFKA_PRODUCER_SEND_TIMEOUT_MS') ?? 3000,
          }),
      });
      exports.push(KafkaProducerService);
    }

    return {
      module: MessagingModule,
      global: true,
      providers,
      exports,
    };
  }
}
