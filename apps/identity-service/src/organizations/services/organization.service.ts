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
import { RolesService } from '../../iam/services/roles.service.js';

const LEGAL_PROFILE_FIELDS = [
  'legalName',
  'taxCode',
  'phone',
  'addressLine',
  'ward',
  'district',
  'province',
  'postalCode',
] as const;

type LegalProfileField = (typeof LEGAL_PROFILE_FIELDS)[number];
type LegalProfile = Record<LegalProfileField, string | null>;

/** Only fields present in the request are returned; blank strings clear the value. */
function pickLegalProfileChanges(dto: UpdateOrganizationDto): Partial<LegalProfile> {
  const changes: Partial<LegalProfile> = {};
  for (const field of LEGAL_PROFILE_FIELDS) {
    const value = dto[field];
    if (value !== undefined) {
      const trimmed = value?.trim();
      changes[field] = trimmed ? trimmed : null;
    }
  }
  return changes;
}

function toLegalProfileView(tenant: LegalProfile): LegalProfile {
  return {
    legalName: tenant.legalName,
    taxCode: tenant.taxCode,
    phone: tenant.phone,
    addressLine: tenant.addressLine,
    ward: tenant.ward,
    district: tenant.district,
    province: tenant.province,
    postalCode: tenant.postalCode,
  };
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rolesService: RolesService,
  ) { }

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

    // Tự động khởi tạo 3 vai trò hệ thống (OWNER, ADMIN, MEMBER) và gán role OWNER
    await this.rolesService.initializeTenantRoles(newTenant.id, userId);

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
      legalProfile: toLegalProfileView(userTenant.tenant),
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

    const legalChanges = pickLegalProfileChanges(dto);
    const mergedAddressLine =
      legalChanges.addressLine !== undefined ? legalChanges.addressLine : userTenant.tenant.addressLine;
    const mergedProvince =
      legalChanges.province !== undefined ? legalChanges.province : userTenant.tenant.province;
    // Mirrors ck_tenants_legal_address so the caller gets a 400 instead of a DB error.
    if (!mergedAddressLine !== !mergedProvince) {
      throw new BadRequestException(
        'Địa chỉ pháp lý phải có đồng thời địa chỉ chi tiết và tỉnh/thành phố',
      );
    }

    const updatedTenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl ? dto.logoUrl.trim() : null }),
        ...legalChanges,
      },
    });

    return {
      id: updatedTenant.id,
      code: updatedTenant.code,
      name: updatedTenant.name,
      logoUrl: updatedTenant.logoUrl,
      legalProfile: toLegalProfileView(updatedTenant),
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

    // Không cho phép tự thay đổi vai trò của chính mình
    if (targetMembership.userId === callerUserId) {
      throw new BadRequestException('Bạn không được phép tự thay đổi vai trò của chính mình');
    }

    // Không ai được phép thay đổi vai trò của Chủ sở hữu
    if (targetMembership.role === 'OWNER') {
      throw new ForbiddenException('Không thể thay đổi vai trò của Chủ sở hữu (OWNER)');
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

    // Không ai được phép khai trừ Chủ sở hữu
    if (targetMembership.role === 'OWNER') {
      throw new ForbiddenException('Không thể khai trừ Chủ sở hữu (OWNER) khỏi tổ chức');
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

  /**
   * Self-service leave. Business rules (in check order):
   * 1. Caller must hold an ACTIVE membership in an ACTIVE tenant.
   * 2. OWNER cannot leave — ownership must be transferred or the tenant deleted.
   * 3. Caller must belong to at least one other ACTIVE tenant (create/join one first).
   * 4. The default tenant cannot be left — set another tenant as default first.
   * Side effects run in one transaction: soft-delete membership + role grants
   * (restorable by a later invitation) and revoke sessions bound to the tenant.
   */
  async leaveOrganization(userId: string, tenantId: string) {
    const membership = await this.prisma.userTenant.findFirst({
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
      include: { tenant: { select: { name: true } } },
    });

    if (!membership) {
      throw new NotFoundException('Không tìm thấy tổ chức hoặc bạn không thuộc về tổ chức này');
    }

    if (membership.role === 'OWNER') {
      throw new ForbiddenException(
        'Chủ sở hữu (OWNER) không thể rời tổ chức. Hãy chuyển quyền sở hữu hoặc xóa tổ chức.',
      );
    }

    const otherActiveTenants = await this.prisma.userTenant.count({
      where: {
        userId,
        tenantId: { not: tenantId },
        status: 'ACTIVE',
        deletedAt: null,
        tenant: {
          status: 'ACTIVE',
          deletedAt: null,
        },
      },
    });

    if (otherActiveTenants === 0) {
      throw new BadRequestException(
        'Bạn không thể rời tổ chức duy nhất của mình. Hãy tạo hoặc tham gia một tổ chức khác trước.',
      );
    }

    if (membership.isDefault) {
      throw new BadRequestException(
        'Không thể rời tổ chức mặc định. Hãy đặt một tổ chức khác làm mặc định trước.',
      );
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.userTenant.update({
        where: { id: membership.id },
        data: {
          status: 'INACTIVE',
          deletedAt: now,
          isDefault: false,
        },
      }),
      this.prisma.userRole.updateMany({
        where: { tenantId, userId, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.session.updateMany({
        where: { tenantId, userId, revokedAt: null },
        data: {
          revokedAt: now,
          revokeReason: 'LEFT_TENANT',
        },
      }),
    ]);

    return {
      tenantId,
      message: `Bạn đã rời khỏi tổ chức ${membership.tenant.name} thành công`,
    };
  }

  async deleteOrganization(userId: string, tenantId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true, isSuperAdmin: true },
    });

    if (!user) {
      throw new NotFoundException('Không tìm thấy tài khoản người dùng');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
    });

    if (!tenant) {
      throw new NotFoundException('Không tìm thấy tổ chức hoặc tổ chức đã bị xóa');
    }

    const isSuperAdmin = user.isSuperAdmin === true;

    // Kiểm tra membership của người gọi trong tổ chức (nếu có)
    const callerMembership = await this.prisma.userTenant.findFirst({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
      },
    });

    const isOwner = callerMembership?.role === 'OWNER';

    // Ràng buộc thẩm quyền: Tuyệt đối chỉ SUPER_ADMIN hoặc OWNER mới được quyền xóa tổ chức
    if (!isSuperAdmin && !isOwner) {
      throw new ForbiddenException('Bạn không có quyền thực hiện thao tác này');
    }

    // Nghiệp vụ an toàn: Đối với OWNER, bắt buộc không còn thành viên nào khác trong tổ chức
    if (!isSuperAdmin) {
      const otherMembersCount = await this.prisma.userTenant.count({
        where: {
          tenantId,
          status: 'ACTIVE',
          deletedAt: null,
          userId: { not: userId },
          user: {
            status: 'ACTIVE',
            deletedAt: null,
          },
        },
      });

      if (otherMembersCount > 0) {
        throw new BadRequestException(
          'Không thể xóa tổ chức khi vẫn còn thành viên khác. Hãy khai trừ tất cả các thành viên ra khỏi tổ chức trước khi xóa.',
        );
      }
    }

    const timestamp = Date.now();
    const anonymizedCode = `deleted_${timestamp}_${tenant.code}`;

    // Tìm các tài khoản đang đặt tổ chức này làm mặc định để chuẩn bị chuyển giao
    const usersWithThisAsDefault = await this.prisma.userTenant.findMany({
      where: {
        tenantId,
        isDefault: true,
      },
      select: { userId: true },
    });

    // Thực hiện ngắt kết nối an toàn trong transaction
    await this.prisma.$transaction([
      // 1. Vô hiệu hóa tổ chức và ẩn danh hóa mã định danh để tránh conflict unique key
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          code: anonymizedCode,
          status: 'DISABLED',
          deletedAt: new Date(),
        },
      }),
      // 2. Vô hiệu hóa toàn bộ quyền hạn và liên kết thành viên trong tổ chức
      this.prisma.userTenant.updateMany({
        where: { tenantId, deletedAt: null },
        data: {
          status: 'INACTIVE',
          deletedAt: new Date(),
          isDefault: false,
        },
      }),
      // 3. Thu hồi toàn bộ các lời mời đang chờ gia nhập tổ chức
      this.prisma.tenantInvitation.updateMany({
        where: { tenantId, deletedAt: null },
        data: {
          status: 'REVOKED',
          deletedAt: new Date(),
        },
      }),
      // 4. Thu hồi toàn bộ các phiên đăng nhập (sessions) gắn với tổ chức
      this.prisma.session.updateMany({
        where: { tenantId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokeReason: 'TENANT_DELETED',
        },
      }),
    ]);

    // Di dời default organization cho các user bị ảnh hưởng sang tổ chức hoạt động khác
    for (const item of usersWithThisAsDefault) {
      const remainingUserTenant = await this.prisma.userTenant.findFirst({
        where: {
          userId: item.userId,
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

