import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@logix/logger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use Pino as the application-wide logger
  app.useLogger(app.get(Logger));

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Enable graceful shutdown hooks (important for K8s SIGTERM)
  app.enableShutdownHooks();

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}
await bootstrap();
