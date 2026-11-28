import {
  Logger,
} from '@nestjs/common';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { accessTokenUser, type AuthenticatedUser, type JwtPayload } from '@logix/auth';
import { verify } from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';

const NOTIFICATIONS_NAMESPACE = '/notifications';
const NOTIFICATIONS_PATH = '/ws/notifications';

@WebSocketGateway({
  namespace: NOTIFICATIONS_NAMESPACE,
  path: NOTIFICATIONS_PATH,
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly config: ConfigService) {}

  handleConnection(@ConnectedSocket() client: Socket): void {
    try {
      const user = this.authenticate(client);
      client.data.user = user;
      void client.join(this.room(user.tenantId, user.id));
    } catch (error) {
      this.logger.warn({
        message:
          error instanceof Error ? error.message : 'WebSocket authentication failed',
      });
      client.disconnect(true);
    }
  }

  handleDisconnect(@ConnectedSocket() client: Socket): void {
    delete client.data.user;
  }

  emitNotification(
    tenantId: string,
    userId: string,
    payload: Record<string, unknown>,
  ): void {
    this.server.to(this.room(tenantId, userId)).emit('notification.created', payload);
  }

  emitUnreadCount(tenantId: string, userId: string, count: number): void {
    this.server
      .to(this.room(tenantId, userId))
      .emit('notification.unread-count', { count });
  }

  private authenticate(client: Socket): AuthenticatedUser {
    const token = this.tokenFrom(client);
    const payload = verify(
      token,
      this.config.getOrThrow<string>('JWT_SECRET'),
      { algorithms: ['HS256'] },
    );

    if (typeof payload === 'string') {
      throw new Error('WebSocket token payload is invalid');
    }

    return accessTokenUser(payload as JwtPayload);
  }

  private tokenFrom(client: Socket): string {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) return authToken;

    const authorization = client.handshake.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim();
    }

    throw new Error('WebSocket access token is required');
  }

  private room(tenantId: string, userId: string): string {
    return `tenant:${tenantId}:user:${userId}`;
  }
}
