import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { Logger } from '@logix/logger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Use Pino as the application-wide logger
  app.useLogger(app.get(Logger));

  // CORS is handled by the API Gateway; this service is not exposed to browsers.
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'internal/(.*)', method: RequestMethod.ALL }],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Enable graceful shutdown hooks (important for K8s SIGTERM)
  app.enableShutdownHooks();

  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}
await bootstrap();