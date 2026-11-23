import { Module } from '@nestjs/common';
import { MessagingModule } from '@logix/messaging';

/**
 * Kafka wiring boundary for the first implementation slice.
 * Consumers are registered after event builders and the transactional handler
 * are implemented, so this scaffold does not acknowledge or retry messages.
 */
@Module({
  imports: [MessagingModule.forRoot({ enableProducer: false })],
})
export class EventsModule {}
