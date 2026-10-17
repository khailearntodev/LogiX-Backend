import { NestFactory } from '@nestjs/core';
import { Logger } from '@logix/logger';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use Pino as the application-wide logger
  app.useLogger(app.get(Logger));

  // Enable graceful shutdown hooks (important for K8s SIGTERM)
  app.enableShutdownHooks();

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}
await bootstrap();
