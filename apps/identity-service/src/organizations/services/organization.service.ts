import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateOrganizationDto } from '../dto/create-organization.dto.js';
import { UpdateOrganizationDto } from '../dto/update-organization.dto.js';

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) { }

  async getTenants(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', deletedAt: null },
      include: {
        userTenants: {
          where: {
            status: 'ACTIVE',
            deletedAt: null,
            tenant: {
              status: 'ACTIVE',
              deletedAt: null,
            },
          },
          include: { tenant: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Người dùng không hợp lệ hoặc đã bị khóa');
    }

    return user.userTenants.map((ut) => ({
      id: ut.tenant.id,
      code: ut.tenant.code,
      name: ut.tenant.name,
      logoUrl: ut.tenant.logoUrl,
      role: ut.role,
      isDefault: ut.isDefault,
    }));
  }

  async createOrganization(userId: string, dto: CreateOrganizationDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', deletedAt: null },
    });

    if (!user) {
      throw new UnauthorizedException('Người dùng không hợp lệ hoặc đã bị khóa');
    }

    const tenantCode = dto.code?.trim() || `tenant-${crypto.randomBytes(6).toString('hex')}`;
    const tenantName = dto.name.trim();

    // Nếu chọn làm mặc định, hủy default của các tenant khác
    if (dto.setAsDefault) {
      await this.prisma.userTenant.updateMany({
        where: { userId },
        data: { isDefault: false },
      });
    }

    const newTenant = await this.prisma.tenant.create({
      data: {
        code: tenantCode,
        name: tenantName,
        status: 'ACTIVE',
        settings: {},
      },
    });

    const userTenant = await this.prisma.userTenant.create({
      data: {
        userId,
        tenantId: newTenant.id,
        role: 'OWNER',
        isDefault: Boolean(dto.setAsDefault),
        status: 'ACTIVE',
      },
    });

    return {
      id: newTenant.id,
      code: newTenant.code,
      name: newTenant.name,
      role: userTenant.role,
      isDefault: userTenant.isDefault,
      message: 'Khởi tạo tổ chức mới thành công',
    };
  }

  async getOrganization(userId: string, tenantId: string) {
    const userTenant = await this.prisma.userTenant.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
        tenant: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
      include: {
        tenant: true,
      },
    });

    if (!userTenant || !userTenant.tenant || userTenant.tenant.deletedAt !== null || userTenant.tenant.status !== 'ACTIVE') {
      throw new NotFoundException('Không tìm thấy tổ chức hoặc bạn không có quyền truy cập');
    }

    return {
      id: userTenant.tenant.id,
      code: userTenant.tenant.code,
      name: userTenant.tenant.name,
      logoUrl: userTenant.tenant.logoUrl,
      status: userTenant.tenant.status,
      settings: userTenant.tenant.settings,
      role: userTenant.role,
      isDefault: userTenant.isDefault,
      createdAt: userTenant.tenant.createdAt,
      updatedAt: userTenant.tenant.updatedAt,
    };
  }

  async updateOrganization(userId: string, tenantId: string, dto: UpdateOrganizationDto) {
    const userTenant = await this.prisma.userTenant.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
        tenant: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
      include: {
        tenant: true,
      },
    });

    if (!userTenant || !userTenant.tenant || userTenant.tenant.deletedAt !== null || userTenant.tenant.status !== 'ACTIVE') {
      throw new NotFoundException('Không tìm thấy tổ chức hoặc bạn không có quyền truy cập');
    }

    if (userTenant.role !== 'OWNER' && userTenant.role !== 'ADMIN') {
      throw new ForbiddenException('Chỉ Quản trị viên hoặc Chủ sở hữu mới có quyền cập nhật thông tin tổ chức');
    }

    const updatedTenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl ? dto.logoUrl.trim() : null }),
      },
    });

    return {
      id: updatedTenant.id,
      code: updatedTenant.code,
      name: updatedTenant.name,
      logoUrl: updatedTenant.logoUrl,
      role: userTenant.role,
      isDefault: userTenant.isDefault,
      message: 'Cập nhật thông tin tổ chức thành công',
    };
  }

  async setDefaultTenant(userId: string, tenantId: string) {
    const targetUserTenant = await this.prisma.userTenant.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
        tenant: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });

    if (!targetUserTenant) {
      throw new NotFoundException('Không tìm thấy tổ chức hoặc bạn không thuộc về tổ chức này');
    }

    await this.prisma.$transaction([
      this.prisma.userTenant.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.userTenant.update({
        where: { id: targetUserTenant.id },
        data: { isDefault: true },
      }),
    ]);

    return {
      tenantId,
      isDefault: true,
      message: 'Đặt tổ chức mặc định thành công',
    };
  }
}
