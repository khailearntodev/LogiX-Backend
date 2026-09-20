import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateOrganizationDto } from '../dto/create-organization.dto.js';
import { UpdateOrganizationDto } from '../dto/update-organization.dto.js';
import { UpdateMemberRoleDto } from '../dto/update-member-role.dto.js';

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

  async getMembers(userId: string, tenantId: string) {
    const callerMembership = await this.prisma.userTenant.findFirst({
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

    if (!callerMembership) {
      throw new ForbiddenException('Bạn không có quyền xem danh sách thành viên của tổ chức này');
    }

    const memberships = await this.prisma.userTenant.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            phoneNumber: true,
            status: true,
            createdAt: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return memberships.map((m) => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      phoneNumber: m.user.phoneNumber,
      role: m.role,
      isDefault: m.isDefault,
      joinedAt: m.createdAt,
    }));
  }

  async updateMemberRole(
    callerUserId: string,
    tenantId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const caller = await this.prisma.userTenant.findFirst({
      where: {
        userId: callerUserId,
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

    if (!caller || (caller.role !== 'OWNER' && caller.role !== 'ADMIN')) {
      throw new ForbiddenException('Chỉ Chủ sở hữu hoặc Quản trị viên mới có quyền phân quyền thành viên');
    }

    const targetMembership = await this.prisma.userTenant.findFirst({
      where: {
        id: memberId,
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
      include: { user: true },
    });

    if (!targetMembership) {
      throw new NotFoundException('Không tìm thấy thành viên trong tổ chức');
    }

    // Nếu người thực hiện là ADMIN: không được thay đổi quyền của OWNER, không được nâng ai lên làm OWNER
    if (caller.role === 'ADMIN') {
      if (targetMembership.role === 'OWNER') {
        throw new ForbiddenException('Quản trị viên không thể thay đổi vai trò của Chủ sở hữu');
      }
      if (dto.role === 'OWNER') {
        throw new ForbiddenException('Chỉ Chủ sở hữu mới có quyền bổ nhiệm Chủ sở hữu khác');
      }
    }

    // Nếu hạ quyền của chính mình khi là OWNER duy nhất
    if (caller.role === 'OWNER' && targetMembership.userId === callerUserId && dto.role !== 'OWNER') {
      const ownerCount = await this.prisma.userTenant.count({
        where: {
          tenantId,
          role: 'OWNER',
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException('Tổ chức cần có ít nhất một Chủ sở hữu. Hãy bổ nhiệm Chủ sở hữu khác trước khi hạ vai trò.');
      }
    }

    const updated = await this.prisma.userTenant.update({
      where: { id: memberId },
      data: { role: dto.role },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    return {
      id: updated.id,
      userId: updated.userId,
      role: updated.role,
      displayName: updated.user.displayName,
      message: `Đã cập nhật vai trò của ${updated.user.displayName} thành ${dto.role}`,
    };
  }

  async removeMember(callerUserId: string, tenantId: string, memberId: string) {
    const caller = await this.prisma.userTenant.findFirst({
      where: {
        userId: callerUserId,
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

    if (!caller || (caller.role !== 'OWNER' && caller.role !== 'ADMIN')) {
      throw new ForbiddenException('Chỉ Chủ sở hữu hoặc Quản trị viên mới có quyền khai trừ thành viên');
    }

    const targetMembership = await this.prisma.userTenant.findFirst({
      where: {
        id: memberId,
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
      include: { user: true },
    });

    if (!targetMembership) {
      throw new NotFoundException('Không tìm thấy thành viên trong tổ chức');
    }

    // Không thể tự khai trừ chính mình
    if (targetMembership.userId === callerUserId) {
      throw new BadRequestException('Bạn không thể tự khai trừ chính mình khỏi tổ chức');
    }

    // Nếu người thực hiện là ADMIN: không được xóa ADMIN khác hoặc OWNER
    if (caller.role === 'ADMIN') {
      if (targetMembership.role === 'OWNER' || targetMembership.role === 'ADMIN') {
        throw new ForbiddenException('Quản trị viên không thể khai trừ Chủ sở hữu hoặc Quản trị viên khác');
      }
    }

    // Nếu người bị xóa là OWNER duy nhất
    if (targetMembership.role === 'OWNER') {
      const ownerCount = await this.prisma.userTenant.count({
        where: {
          tenantId,
          role: 'OWNER',
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      if (ownerCount <= 1) {
        throw new BadRequestException('Không thể khai trừ Chủ sở hữu duy nhất của tổ chức');
      }
    }

    // Thực hiện soft-delete thành viên khỏi tổ chức
    await this.prisma.userTenant.update({
      where: { id: memberId },
      data: {
        status: 'INACTIVE',
        deletedAt: new Date(),
      },
    });

    return {
      id: memberId,
      message: `Đã khai trừ ${targetMembership.user.displayName} khỏi tổ chức thành công`,
    };
  }

  async deleteOrganization(userId: string, tenantId: string) {
    const caller = await this.prisma.userTenant.findFirst({
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

    if (!caller || !caller.tenant) {
      throw new NotFoundException('Không tìm thấy tổ chức hoặc bạn không có quyền truy cập');
    }

    if (caller.role !== 'OWNER') {
      throw new ForbiddenException('Chỉ Chủ sở hữu mới có quyền xóa tổ chức');
    }

    // Nghiệp vụ: Chỉ được xóa tổ chức khi trong tổ chức KHÔNG CÒN AI KHÁC ngoài chính OWNER này
    const otherMembersCount = await this.prisma.userTenant.count({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        id: { not: caller.id },
        user: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });

    if (otherMembersCount > 0) {
      throw new BadRequestException(
        'Không thể xóa tổ chức khi vẫn còn thành viên khác (kể cả Chủ sở hữu khác). Hãy khai trừ hoặc chuyển tất cả các thành viên ra khỏi tổ chức trước khi xóa.',
      );
    }

    const timestamp = Date.now();
    const anonymizedCode = `deleted_${timestamp}_${caller.tenant.code}`;

    // Cắt đứt liên kết tổ chức với OWNER này, ẩn danh hóa code và thu hồi sessions của tổ chức
    await this.prisma.$transaction([
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          code: anonymizedCode,
          status: 'INACTIVE',
          deletedAt: new Date(),
        },
      }),
      this.prisma.userTenant.update({
        where: { id: caller.id },
        data: {
          status: 'INACTIVE',
          deletedAt: new Date(),
          isDefault: false,
        },
      }),
      this.prisma.session.updateMany({
        where: { tenantId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokeReason: 'TENANT_DELETED',
        },
      }),
    ]);

    // Nếu tổ chức vừa xóa là mặc định của user, chuyển default sang 1 tổ chức còn lại (nếu có)
    if (caller.isDefault) {
      const remainingUserTenant = await this.prisma.userTenant.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          deletedAt: null,
          tenantId: { not: tenantId },
          tenant: {
            status: 'ACTIVE',
            deletedAt: null,
          },
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (remainingUserTenant) {
        await this.prisma.userTenant.update({
          where: { id: remainingUserTenant.id },
          data: { isDefault: true },
        });
      }
    }

    return {
      message: 'Xóa tổ chức thành công. Bạn vẫn có thể hoạt động bình thường trong các tổ chức khác.',
    };
  }
}

