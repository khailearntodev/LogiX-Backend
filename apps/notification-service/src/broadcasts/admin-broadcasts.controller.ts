import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  CurrentUser,
  JwtAuthGuard,
  NOTIFICATION_BROADCAST_PERMISSIONS,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedUser,
} from '@logix/auth';
import { ValidationError } from '@logix/errors';
import { isUUID } from 'class-validator';
import { DEFAULT_MAX_BROADCAST_RECIPIENTS } from '../notifications/notification.constants.js';
import { BroadcastCommandService } from './broadcast-command.service.js';
import { BroadcastQueryService } from './broadcast-query.service.js';
import {
  BroadcastIdempotencyConflictError,
  type BroadcastAudience,
} from './broadcast.types.js';
import { CreateBroadcastDto } from './dto/create-broadcast.dto.js';
import { ListBroadcastsQueryDto } from './dto/list-broadcasts.dto.js';

@Controller('notifications/admin/broadcasts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminBroadcastsController {
  private readonly maxRecipients: number;

  constructor(
    private readonly commands: BroadcastCommandService,
    private readonly queries: BroadcastQueryService,
    config: ConfigService,
  ) {
    this.maxRecipients =
      config.get<number>('MAX_BROADCAST_RECIPIENTS') ??
      DEFAULT_MAX_BROADCAST_RECIPIENTS;
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(NOTIFICATION_BROADCAST_PERMISSIONS.SEND)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Body() dto: CreateBroadcastDto,
  ): Promise<{ id: string; status: string }> {
    if (!idempotencyKey || !isUUID(idempotencyKey)) {
      throw new ValidationError(
        'Header Idempotency-Key phải là UUID hợp lệ',
      );
    }

    const audience = this.validateAudience(dto.audience);
    const correlationId =
      typeof correlationHeader === 'string' && isUUID(correlationHeader)
        ? correlationHeader
        : randomUUID();

    try {
      const result = await this.commands.enqueue({
        tenantId: user.tenantId,
        actorId: user.id,
        idempotencyKey,
        correlationId,
        title: dto.title,
        body: dto.body,
        severity: dto.severity,
        audience,
        link: dto.link ?? null,
      });

      return { id: result.id, status: result.status };
    } catch (error) {
      if (error instanceof BroadcastIdempotencyConflictError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Get()
  @RequirePermissions(NOTIFICATION_BROADCAST_PERMISSIONS.READ)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListBroadcastsQueryDto,
  ) {
    return this.queries.list(user.tenantId, query);
  }

  @Get(':id')
  @RequirePermissions(NOTIFICATION_BROADCAST_PERMISSIONS.READ)
  getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () => new ValidationError('Mã broadcast không hợp lệ'),
      }),
    )
    broadcastId: string,
  ) {
    return this.queries.getById(user.tenantId, broadcastId);
  }

  private validateAudience(
    audience: CreateBroadcastDto['audience'],
  ): BroadcastAudience {
    if (audience.kind === 'ROLES') {
      if (!audience.roleIds || audience.roleIds.length === 0) {
        throw new UnprocessableEntityException(
          'Đối tượng nhận thông báo không được rỗng',
        );
      }
      return { kind: 'ROLES', roleIds: audience.roleIds };
    }

    if (audience.kind === 'USERS') {
      if (!audience.userIds || audience.userIds.length === 0) {
        throw new UnprocessableEntityException(
          'Đối tượng nhận thông báo không được rỗng',
        );
      }
      const uniqueUserIds = new Set(audience.userIds);
      if (uniqueUserIds.size > this.maxRecipients) {
        throw new UnprocessableEntityException(
          `Số lượng người nhận vượt quá giới hạn ${this.maxRecipients}`,
        );
      }
      return { kind: 'USERS', userIds: audience.userIds };
    }

    return { kind: 'ALL' };
  }
}
