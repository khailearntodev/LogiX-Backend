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
        const brokersRaw = config.get<string>('KAFKA_BROKERS');
        const brokers = brokersRaw
          ? brokersRaw.split(',')
          : ['localhost:9092'];
        const clientId =
          config.get<string>('KAFKA_CLIENT_ID') ??
          config.get<string>('SERVICE_NAME') ??
          'logix-service';

        return new Kafka({
          clientId,
          brokers,
          logLevel: logLevel.WARN,
          retry: {
            initialRetryTime: 300,
            retries: 5,
          },
        });
      },
    };

    const providers: Provider[] = [kafkaProvider];
    const exports: any[] = [Kafka];

    if (enableProducer) {
      providers.push({
        provide: KafkaProducerService,
        inject: [Kafka],
        useFactory: (kafka: Kafka) => new KafkaProducerService(kafka),
      });
      exports.push(KafkaProducerService as any);
    }

    return {
      module: MessagingModule,
      global: true,
      providers,
      exports,
    };
  }
}
