import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class DriverUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async usage(tenantId: string, driverId: string) {
    // Never filter status/deletedAt: drafts, cancellations and history all count.
    const reference = await this.prisma.deliveryTrip.findFirst({
      where: { tenantId, driverId },
      select: { id: true },
    });
    return { tenantId, driverId, used: reference !== null };
  }
}
