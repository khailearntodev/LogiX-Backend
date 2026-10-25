import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { z } from 'zod';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto.js';

const IDENTITY_TIMEOUT_MS = 5000;
const INTERNAL_TOKEN_TTL_SECONDS = 60;
const userSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  email: z.string().email(),
  status: z.string().min(1),
});
const userListSchema = z.object({
  items: z.array(userSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type DriverUser = z.infer<typeof userSchema>;

@Injectable()
export class IdentityDriverClient {
  private readonly url: string;
  private readonly secret: string;
  constructor(config: ConfigService) {
    this.url = config
      .getOrThrow<string>('IDENTITY_SERVICE_URL')
      .replace(/\/+$/, '');
    this.secret = config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
  }

  async eligible(tenantId: string, id: string) {
    const user = await this.request(
      tenantId,
      `/internal/driver-users/${id}/eligibility`,
      userSchema,
    );
    if (user.id !== id || user.status !== 'ACTIVE')
      throw new BadGatewayException('Danh tính người dùng không khớp yêu cầu');
    return user;
  }

  list(tenantId: string, query: PaginationQueryDto) {
    const params = new URLSearchParams();
    if (query.q !== undefined) params.set('q', query.q);
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined)
      params.set('pageSize', String(query.pageSize));
    return this.request(
      tenantId,
      `/internal/driver-users?${params}`,
      userListSchema,
    );
  }

  async resolve(tenantId: string, userIds: string[]) {
    if (userIds.length === 0) return [];
    const response = await this.request(
      tenantId,
      '/internal/driver-users/resolve',
      z.object({ items: z.array(userSchema) }),
      { userIds },
    );
    const expected = new Set(userIds);
    if (
      response.items.length !== expected.size ||
      response.items.some((user) => !expected.has(user.id)) ||
      new Set(response.items.map((user) => user.id)).size !== expected.size
    )
      throw new BadGatewayException(
        'Phản hồi danh tính người dùng không khớp yêu cầu',
      );
    return response.items;
  }

  private async request<T>(
    tenantId: string,
    path: string,
    schema: z.ZodType<T>,
    body?: { userIds: string[] },
  ): Promise<T> {
    const token = signInternalServiceToken({
      secret: this.secret,
      service: ServiceId.MASTER_DATA_SERVICE,
      audience: ServiceId.IDENTITY_SERVICE,
      tenantId,
      ttlSeconds: INTERNAL_TOKEN_TTL_SECONDS,
    });
    let response: Response;
    try {
      response = await fetch(`${this.url}/api/v1${path}`, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_TOKEN_HEADER]: token,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Dịch vụ danh tính hiện không phản hồi',
      );
    }
    if (response.status === 404)
      throw new NotFoundException(
        'Không tìm thấy thành viên phù hợp trong tổ chức',
      );
    if (!response.ok)
      throw new BadGatewayException('Không thể xác minh danh tính người dùng');
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new BadGatewayException('Phản hồi dịch vụ danh tính không hợp lệ');
    }
    const result = schema.safeParse(json);
    if (!result.success)
      throw new BadGatewayException('Phản hồi dịch vụ danh tính không hợp lệ');
    return result.data;
  }
}
