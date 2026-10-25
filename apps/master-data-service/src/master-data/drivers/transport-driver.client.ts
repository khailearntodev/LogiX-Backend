import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_SERVICE_TOKEN_HEADER,
  signInternalServiceToken,
} from '@logix/auth';
import { ServiceId } from '@logix/common';
import { z } from 'zod';

const TIMEOUT_MS = 5000;
const TOKEN_TTL_SECONDS = 60;
const usageSchema = z.object({
  driverId: z.string().uuid(),
  tenantId: z.string().uuid(),
  used: z.boolean(),
});

@Injectable()
export class TransportDriverClient {
  private readonly url: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.url = config
      .getOrThrow<string>('TRANSPORT_SERVICE_URL')
      .replace(/\/+$/, '');
    this.secret = config.getOrThrow<string>('INTERNAL_SERVICE_JWT_SECRET');
  }

  async used(tenantId: string, driverId: string): Promise<boolean> {
    const token = signInternalServiceToken({
      secret: this.secret,
      service: ServiceId.MASTER_DATA_SERVICE,
      audience: ServiceId.TRANSPORT_SERVICE,
      tenantId,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
    let response: Response;
    try {
      response = await fetch(
        `${this.url}/api/v1/internal/drivers/${driverId}/usage`,
        {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: token },
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Không thể xác minh lịch sử sử dụng tài xế',
      );
    }
    if (!response.ok)
      throw new BadGatewayException(
        'Không thể xác minh lịch sử sử dụng tài xế',
      );
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new BadGatewayException('Phản hồi lịch sử tài xế không hợp lệ');
    }
    const parsed = usageSchema.safeParse(json);
    if (
      !parsed.success ||
      parsed.data.driverId !== driverId ||
      parsed.data.tenantId !== tenantId
    )
      throw new BadGatewayException(
        'Phản hồi lịch sử tài xế không khớp yêu cầu',
      );
    return parsed.data.used;
  }
}
