import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { CreateRoleDto } from '../dto/create-role.dto.js';
import { UpdateRoleDto } from '../dto/update-role.dto.js';

export const SYSTEM_ROLE_CODES = ['OWNER', 'ADMIN', 'MEMBER'];
export const BLACKLIST_ROLE_CODES = [...SYSTEM_ROLE_CODES, 'SUPER_ADMIN'];

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) { }

  /**
   * Tự động khởi tạo 3 vai trò hệ thống (OWNER, ADMIN, MEMBER)
   * và gán quyền mặc định cho từng vai trò khi tạo Tenant mới.
   */
  async initializeTenantRoles(tenantId: string, ownerUserId?: string) {
    const systemRoles = [
      {
        code: 'OWNER',
        name: 'Chủ sở hữu',
        description: 'Chủ sở hữu tổ chức, có toàn bộ quyền hạn cao nhất',
        isSystem: true,
      },
      {
        code: 'ADMIN',
        name: 'Quản trị viên',
        description: 'Quản trị viên tổ chức, có quyền quản lý thành viên và vận hành',
        isSystem: true,
      },
      {
        code: 'MEMBER',
        name: 'Thành viên',
        description: 'Thành viên cơ bản trong tổ chức, có quyền xem thông tin',
        isSystem: true,
      },
    ];

    const createdRoles: Record<string, { id: string; code: string }> = {};

    for (const roleDef of systemRoles) {
      let role = await this.prisma.role.findFirst({
        where: { tenantId, code: roleDef.code, deletedAt: null },
      });

      if (!role) {
        role = await this.prisma.role.create({
          data: {
            tenantId,
            code: roleDef.code,
            name: roleDef.name,
            description: roleDef.description,
            isSystem: true,
          },
        });
      }

      createdRoles[roleDef.code] = { id: role.id, code: role.code };
    }

    // Lấy toàn bộ danh mục quyền hệ thống
    const allPermissions = await this.prisma.permission.findMany({
      where: { deletedAt: null },
    });

    if (allPermissions.length > 0) {
      // 1. OWNER: Toàn bộ quyền
      const ownerPerms = allPermissions.map((p) => ({
        tenantId,
        roleId: createdRoles['OWNER'].id,
        permissionId: p.id,
      }));

      // 2. ADMIN: Quyền vận hành và quản lý
      const adminPerms = allPermissions.map((p) => ({
        tenantId,
        roleId: createdRoles['ADMIN'].id,
        permissionId: p.id,
      }));

      // 3. MEMBER: Chỉ các quyền xem (action === 'read')
      const memberPerms = allPermissions
        .filter((p) => p.action === 'read')
        .map((p) => ({
          tenantId,
          roleId: createdRoles['MEMBER'].id,
          permissionId: p.id,
        }));

      await this.prisma.rolePermission.createMany({
        data: [...ownerPerms, ...adminPerms, ...memberPerms],
        skipDuplicates: true,
      });
    }

    // Gán role OWNER cho user tạo tổ chức trong bảng UserRole
    if (ownerUserId && createdRoles['OWNER']) {
      await this.prisma.userRole.upsert({
        where: {
          tenantId_userId_roleId: {
            tenantId,
            userId: ownerUserId,
            roleId: createdRoles['OWNER'].id,
          },
        },
        update: {},
        create: {
          tenantId,
          userId: ownerUserId,
          roleId: createdRoles['OWNER'].id,
          grantedBy: ownerUserId,
        },
      });
    }

    return createdRoles;
  }

  /**
   * Lấy danh mục tất cả quyền có trong hệ thống (nhóm theo module, resource)
   */
  async getAllPermissions() {
    const permissions = await this.prisma.permission.findMany({
      where: { deletedAt: null },
      orderBy: [{ module: 'asc' }, { resource: 'asc' }, { action: 'asc' }],
    });

    return permissions.map((p) => ({
      id: p.id,
      module: p.module,
      resource: p.resource,
      action: p.action,
      code: p.code,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  /**
   * Lấy danh sách vai trò của tổ chức (OWNER, ADMIN, MEMBER + Custom Roles).
   * LỌC BỎ HOÀN TOÀN bất kỳ thông tin nào của SUPER_ADMIN.
   */
  async getRoles(tenantId: string) {
    const roles = await this.prisma.role.findMany({
      where: {
        tenantId,
        deletedAt: null,
        code: { not: 'SUPER_ADMIN' },
      },
      include: {
        _count: {
          select: {
            userRoles: { where: { deletedAt: null } },
            rolePermissions: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: [
        { isSystem: 'desc' },
        { createdAt: 'asc' },
      ],
    });

    // Custom sorting để 3 roles hệ thống luôn theo thứ tự: OWNER -> ADMIN -> MEMBER -> Custom
    const systemOrder: Record<string, number> = { OWNER: 1, ADMIN: 2, MEMBER: 3 };

    return roles
      .sort((a, b) => {
        const orderA = systemOrder[a.code] || 99;
        const orderB = systemOrder[b.code] || 99;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      })
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        memberCount: r._count.userRoles,
        permissionCount: r._count.rolePermissions,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  /**
   * Lấy chi tiết vai trò kèm danh sách quyền hạn đã cấp
   */
  async getRoleById(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: {
        id: roleId,
        tenantId,
        deletedAt: null,
      },
      include: {
        rolePermissions: {
          where: { deletedAt: null },
          include: { permission: true },
        },
        _count: {
          select: {
            userRoles: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Không tìm thấy vai trò trong tổ chức này');
    }

    return {
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      memberCount: role._count.userRoles,
      permissionIds: role.rolePermissions.map((rp) => rp.permissionId),
      permissions: role.rolePermissions.map((rp) => ({
        id: rp.permission.id,
        module: rp.permission.module,
        resource: rp.permission.resource,
        action: rp.permission.action,
        code: rp.permission.code,
        name: rp.permission.name,
        description: rp.permission.description,
      })),
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    };
  }

  /**
   * Tạo vai trò mới cho tổ chức (Custom Role)
   */
  async createRole(tenantId: string, dto: CreateRoleDto, creatorId?: string) {
    const code = dto.code.trim().toUpperCase();

    if (BLACKLIST_ROLE_CODES.includes(code)) {
      throw new BadRequestException('Mã vai trò này được bảo lưu cho hệ thống, vui lòng chọn mã khác');
    }

    const existingRole = await this.prisma.role.findFirst({
      where: { tenantId, code, deletedAt: null },
    });

    if (existingRole) {
      throw new ConflictException(`Mã vai trò "${code}" đã tồn tại trong tổ chức`);
    }

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId,
          code,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          isSystem: false,
        },
      });

      if (dto.permissionIds && dto.permissionIds.length > 0) {
        // Kiểm tra danh sách permissions tồn tại
        const validPerms = await tx.permission.findMany({
          where: { id: { in: dto.permissionIds }, deletedAt: null },
          select: { id: true },
        });

        if (validPerms.length > 0) {
          await tx.rolePermission.createMany({
            data: validPerms.map((p) => ({
              tenantId,
              roleId: role.id,
              permissionId: p.id,
              grantedBy: creatorId || null,
            })),
          });
        }
      }

      return {
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        message: 'Tạo vai trò mới thành công',
      };
    });
  }

  /**
   * Cập nhật thông tin vai trò (Không cho phép đổi code của System Roles)
   */
  async updateRole(tenantId: string, roleId: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId, deletedAt: null },
    });

    if (!role) {
      throw new NotFoundException('Không tìm thấy vai trò cần cập nhật');
    }

    const updated = await this.prisma.role.update({
      where: { id: roleId },
      data: {
        ...(dto.name && { name: dto.name.trim() }),
        ...(dto.description !== undefined && { description: dto.description?.trim() || null }),
      },
    });

    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      description: updated.description,
      isSystem: updated.isSystem,
      message: 'Cập nhật vai trò thành công',
    };
  }

  /**
   * Xóa vai trò tùy biến (Chặn xóa 3 System Roles và vai trò đang có thành viên)
   */
  async deleteRole(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId, deletedAt: null },
      include: {
        _count: {
          select: {
            userRoles: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Không tìm thấy vai trò cần xóa');
    }

    if (role.isSystem) {
      throw new BadRequestException('Không thể xóa 3 vai trò mặc định của hệ thống (OWNER, ADMIN, MEMBER)');
    }

    if (role._count.userRoles > 0) {
      throw new BadRequestException(
        `Vai trò này đang được gán cho ${role._count.userRoles} thành viên. Vui lòng chuyển vai trò của họ trước khi xóa.`,
      );
    }

    await this.prisma.role.update({
      where: { id: roleId },
      data: { deletedAt: new Date() },
    });

    return { message: `Đã xóa vai trò "${role.name}" thành công` };
  }

  /**
   * Cập nhật tập quyền cho vai trò (Ghi đè RolePermission)
   */
  async updateRolePermissions(
    tenantId: string,
    roleId: string,
    permissionIds: string[],
    updaterId?: string,
  ) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId, deletedAt: null },
    });

    if (!role) {
      throw new NotFoundException('Không tìm thấy vai trò cần phân quyền');
    }

    if (role.code === 'OWNER') {
      throw new ForbiddenException('Không thể thay đổi quyền hạn của Chủ sở hữu (OWNER luôn có toàn quyền)');
    }

    // Kiểm tra danh sách permissions hợp lệ
    const validPerms = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds }, deletedAt: null },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // Xóa toàn bộ RolePermission hiện tại của vai trò này
      await tx.rolePermission.deleteMany({
        where: { tenantId, roleId },
      });

      // Tạo các RolePermission mới
      if (validPerms.length > 0) {
        await tx.rolePermission.createMany({
          data: validPerms.map((p) => ({
            tenantId,
            roleId,
            permissionId: p.id,
            grantedBy: updaterId || null,
          })),
        });
      }
    });

    return {
      message: 'Cập nhật quyền hạn cho vai trò thành công',
      roleId,
      grantedCount: validPerms.length,
    };
  }

  /**
   * Gán danh sách vai trò cho một thành viên trong tổ chức
   */
  async assignMemberRoles(
    tenantId: string,
    targetUserId: string,
    roleIds: string[],
    assignerId?: string,
  ) {
    // 1. Kiểm tra thành viên thuộc tổ chức
    const membership = await this.prisma.userTenant.findFirst({
      where: { userId: targetUserId, tenantId, status: 'ACTIVE', deletedAt: null },
    });

    if (!membership) {
      throw new NotFoundException('Thành viên không thuộc về tổ chức này hoặc tài khoản đã bị khóa');
    }

    // Không thể thay đổi vai trò của OWNER
    if (membership.role === 'OWNER') {
      throw new ForbiddenException('Không thể thay đổi vai trò của Chủ sở hữu (OWNER)');
    }

    // Không thể tự thay đổi vai trò của chính mình
    if (targetUserId === assignerId) {
      throw new BadRequestException('Bạn không được phép tự thay đổi vai trò của chính mình');
    }

    // 2. Kiểm tra các vai trò hợp lệ trong tenant
    const validRoles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, tenantId, deletedAt: null },
    });

    if (validRoles.length !== roleIds.length) {
      throw new BadRequestException('Một hoặc nhiều vai trò không tồn tại trong tổ chức này');
    }

    // 3. Thực hiện thay thế các roles của thành viên
    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({
        where: { tenantId, userId: targetUserId },
      });

      if (validRoles.length > 0) {
        await tx.userRole.createMany({
          data: validRoles.map((r) => ({
            tenantId,
            userId: targetUserId,
            roleId: r.id,
            grantedBy: assignerId || null,
          })),
        });

        // Cập nhật lại primary role trên user_tenants (OWNER > ADMIN > Custom > MEMBER)
        let primaryRole = 'MEMBER';
        if (validRoles.some((r) => r.code === 'OWNER')) {
          primaryRole = 'OWNER';
        } else if (validRoles.some((r) => r.code === 'ADMIN')) {
          primaryRole = 'ADMIN';
        } else if (validRoles.length > 0) {
          primaryRole = validRoles[0].code;
        }

        await tx.userTenant.update({
          where: { id: membership.id },
          data: { role: primaryRole },
        });
      }
    });

    return {
      message: 'Gán vai trò cho thành viên thành công',
      assignedRoles: validRoles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
    };
  }

  /**
   * Lấy danh sách thành viên của tổ chức kèm danh sách các vai trò được gán
   */
  async getMembers(tenantId: string) {
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

    const userIds = memberships.map((m) => m.user.id);

    const userRoles = await this.prisma.userRole.findMany({
      where: {
        tenantId,
        userId: { in: userIds },
        deletedAt: null,
      },
      include: {
        role: {
          select: {
            id: true,
            code: true,
            name: true,
            isSystem: true,
          },
        },
      },
    });

    const userRolesMap = new Map<string, Array<{ id: string; code: string; name: string; isSystem: boolean }>>();
    for (const ur of userRoles) {
      if (!userRolesMap.has(ur.userId)) {
        userRolesMap.set(ur.userId, []);
      }
      userRolesMap.get(ur.userId)!.push(ur.role);
    }

    return memberships.map((m) => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      phoneNumber: m.user.phoneNumber,
      status: m.status,
      primaryRole: m.role,
      roles: userRolesMap.get(m.user.id) || [],
      joinedAt: m.createdAt,
    }));
  }

  /**
   * Tính toán danh mục quyền hiệu lực (Effective Permissions) của user tại tenant hiện tại
   */
  async getEffectivePermissions(userId: string, tenantId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', deletedAt: null },
    });

    if (!user) {
      throw new NotFoundException('Người dùng không tồn tại hoặc đã bị khóa');
    }

    // 1. Nếu là SUPER_ADMIN -> Toàn quyền toàn hệ thống
    if (user.isSuperAdmin) {
      return {
        isSuperAdmin: true,
        isOwner: true,
        isAdmin: true,
        roles: ['SUPER_ADMIN'],
        permissions: ['*'],
      };
    }

    // 2. Kiểm tra quan hệ thành viên trong tenant
    const membership = await this.prisma.userTenant.findFirst({
      where: { userId, tenantId, status: 'ACTIVE', deletedAt: null },
    });

    if (!membership) {
      throw new ForbiddenException('Bạn không thuộc về tổ chức này');
    }

    // 3. Nếu là OWNER của tổ chức -> Toàn quyền trong tổ chức
    if (membership.role === 'OWNER') {
      return {
        isSuperAdmin: false,
        isOwner: true,
        isAdmin: true,
        roles: ['OWNER'],
        permissions: ['*'],
      };
    }

    // 4. Lấy tất cả roles của user trong tenant kèm permissions
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        tenantId,
        deletedAt: null,
      },
      include: {
        role: {
          include: {
            rolePermissions: {
              where: { deletedAt: null },
              include: { permission: true },
            },
          },
        },
      },
    });

    const roleCodes = userRoles.map((ur) => ur.role.code);
    const isOwner = roleCodes.includes('OWNER') || membership.role === 'OWNER';
    const isAdmin = isOwner || roleCodes.includes('ADMIN') || membership.role === 'ADMIN';

    if (isOwner) {
      return {
        isSuperAdmin: false,
        isOwner: true,
        isAdmin: true,
        roles: roleCodes.length > 0 ? roleCodes : ['OWNER'],
        permissions: ['*'],
      };
    }

    // Gom tập quyền duy nhất
    const permissionsSet = new Set<string>();
    for (const ur of userRoles) {
      for (const rp of ur.role.rolePermissions) {
        if (rp.permission && !rp.permission.deletedAt) {
          permissionsSet.add(rp.permission.code);
        }
      }
    }

    return {
      isSuperAdmin: false,
      isOwner: false,
      isAdmin,
      roles: roleCodes.length > 0 ? roleCodes : [membership.role],
      permissions: Array.from(permissionsSet),
    };
  }
}
