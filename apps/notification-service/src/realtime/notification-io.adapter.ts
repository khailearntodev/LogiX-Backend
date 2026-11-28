import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

export function parseWsCorsOrigins(raw?: string): string[] | false {
  if (!raw) return false;
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : false;
}

export class NotificationIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: string[] | false,
  ) {
    super(app);
  }

  override createIOServer(
    port: number | undefined,
    options?: ServerOptions,
  ): Server {
    const cors = this.corsOrigins
      ? { origin: this.corsOrigins, credentials: true }
      : { origin: false };

    return super.createIOServer(port, {
      ...options,
      cors,
    } as ServerOptions);
  }
}
