import { NestFactory } from '@nestjs/core';
import { Logger } from '@logix/logger';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use Pino as the application-wide logger
  app.useLogger(app.get(Logger));

  // Enable graceful shutdown hooks (important for K8s SIGTERM)
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT ?? 3006;
  await app.listen(port);
}
await bootstrap();
