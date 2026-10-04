import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service.js';
import { TokenService } from '../../auth/services/token.service.js';
import { MailService } from '../../mail/services/mail.service.js';
import { CreateInvitationDto } from '../dto/create-invitation.dto.js';
import { AcceptInvitationDto } from '../../auth/dto/accept-invitation.dto.js';

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TokenService))
    private readonly tokenService: TokenService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Tạo lời mời tham gia tổ chức kèm danh sách vai trò (roleIds) được chọn trước
   */
  async createInvitation(
    tenantId: string,
    inviterId: string,
    isSuperAdmin: boolean,
    inviterRole: string | undefined,
    dto: CreateInvitationDto,
  ) {
    const email = dto.email.trim().toLowerCase();

    // 1. Kiểm tra email chưa là thành viên đang hoạt động trong tổ chức
    const existingMembership = await this.prisma.userTenant.findFirst({
      where: {
        tenantId,
        status: 'ACTIVE',
        deletedAt: null,
        user: { email, status: 'ACTIVE', deletedAt: null },
      },
    });

    if (existingMembership) {
      throw new ConflictException('Người dùng này đã là thành viên đang hoạt động trong tổ chức');
    }

    // 2. Kiểm tra danh sách vai trò hợp lệ trong tenant
    const validRoles = await this.prisma.role.findMany({
      where: {
        id: { in: dto.roleIds },
        tenantId,
        deletedAt: null,
      },
    });

    if (validRoles.length !== dto.roleIds.length) {
      throw new BadRequestException('Một hoặc nhiều vai trò không tồn tại trong tổ chức này');
    }

    // 3. Ràng buộc bảo mật 1: TUYỆT ĐỐI CHẶN mời làm SUPER_ADMIN
    if (validRoles.some((r) => r.code === 'SUPER_ADMIN')) {
      throw new BadRequestException('Tuyệt đối không thể mời thành viên với vai trò SUPER_ADMIN');
    }

    // 4. Ràng buộc bảo mật 2: Phân cấp quyền khi mời làm OWNER
    const hasOwnerRole = validRoles.some((r) => r.code === 'OWNER');
    if (hasOwnerRole) {
      if (!isSuperAdmin && inviterRole !== 'OWNER') {
        throw new ForbiddenException(
          'Chỉ Chủ sở hữu (OWNER) hoặc Super Admin mới có quyền chỉ định vai trò Chủ sở hữu cho thành viên mới',
        );
      }
    }

    // 5. Tự động thu hồi (REVOKED) các lời mời PENDING cũ gửi đến email này trong tenant
    await this.prisma.tenantInvitation.updateMany({
      where: { tenantId, email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });

    // 6. Sinh token ngẫu nhiên bảo mật 32 bytes hex và thời hạn 7 ngày
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await this.prisma.tenantInvitation.create({
      data: {
        tenantId,
        email,
        roleIds: validRoles.map((r) => r.id),
        inviterId,
        token,
        status: 'PENDING',
        expiresAt,
      },
      include: {
        tenant: { select: { id: true, name: true, code: true } },
        inviter: { select: { id: true, displayName: true, email: true } },
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3009';
    const inviteLink = `${frontendUrl}/invite?token=${token}`;

    // 7. Gửi email mời thành viên qua Gmail SMTP
    await this.mailService.sendInvitationEmail({
      toEmail: invitation.email,
      inviterName: invitation.inviter?.displayName || invitation.inviter?.email || 'Quản trị viên',
      tenantName: invitation.tenant?.name || 'Tổ chức LogiX',
      roles: validRoles.map((r) => ({ name: r.name, code: r.code })),
      inviteLink,
      expiresAt,
    });

    return {
      id: invitation.id,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      roles: validRoles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
      inviteLink,
      token,
      message: 'Tạo lời mời tham gia tổ chức thành công',
    };
  }

  /**
   * Lấy danh sách các lời mời của tổ chức
   */
  async getInvitations(tenantId: string) {
    const invitations = await this.prisma.tenantInvitation.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: { not: 'ACCEPTED' },
      },
      include: {
        inviter: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const allRoleIds = Array.from(new Set(invitations.flatMap((i) => i.roleIds)));
    const roles = await this.prisma.role.findMany({
      where: { id: { in: allRoleIds }, tenantId },
      select: { id: true, code: true, name: true, isSystem: true },
    });

    const rolesMap = new Map(roles.map((r) => [r.id, r]));

    const now = new Date();

    return invitations.map((inv) => {
      let currentStatus = inv.status;
      if (currentStatus === 'PENDING' && inv.expiresAt < now) {
        currentStatus = 'EXPIRED';
      }

      return {
        id: inv.id,
        email: inv.email,
        status: currentStatus,
        expiresAt: inv.expiresAt,
        acceptedAt: inv.acceptedAt,
        createdAt: inv.createdAt,
        inviter: inv.inviter,
        roles: inv.roleIds.map((rid) => rolesMap.get(rid)).filter(Boolean),
      };
    });
  }

  /**
   * Thu hồi lời mời chưa sử dụng
   */
  async revokeInvitation(tenantId: string, invitationId: string) {
    const invitation = await this.prisma.tenantInvitation.findFirst({
      where: { id: invitationId, tenantId, deletedAt: null },
    });

    if (!invitation) {
      throw new NotFoundException('Không tìm thấy lời mời trong tổ chức này');
    }

    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Chỉ có thể thu hồi lời mời đang ở trạng thái chờ (PENDING)');
    }

    await this.prisma.tenantInvitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });

    return { message: 'Đã thu hồi lời mời thành công' };
  }

  /**
   * Gửi lại lời mời (Gia hạn thời hạn, sinh token mới và chuyển về PENDING)
   */
  async resendInvitation(tenantId: string, invitationId: string) {
    const invitation = await this.prisma.tenantInvitation.findFirst({
      where: { id: invitationId, tenantId, deletedAt: null },
      include: {
        tenant: { select: { id: true, name: true, code: true } },
        inviter: { select: { id: true, displayName: true, email: true } },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Không tìm thấy lời mời trong tổ chức này');
    }

    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestException('Lời mời đã được chấp nhận, không thể gửi lại');
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const updated = await this.prisma.tenantInvitation.update({
      where: { id: invitationId },
      data: {
        token: newToken,
        expiresAt: newExpiresAt,
        status: 'PENDING',
      },
    });

    const roles = await this.prisma.role.findMany({
      where: { id: { in: invitation.roleIds || [] }, tenantId },
      select: { id: true, code: true, name: true },
    });

    const safeRoles = roles || [];
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3009';
    const inviteLink = `${frontendUrl}/invite?token=${newToken}`;

    // Gửi email cập nhật qua Gmail SMTP
    await this.mailService.sendInvitationEmail({
      toEmail: updated.email,
      inviterName: invitation.inviter?.displayName || invitation.inviter?.email || 'Quản trị viên',
      tenantName: invitation.tenant?.name || 'Tổ chức LogiX',
      roles: safeRoles.map((r) => ({ name: r.name, code: r.code })),
      inviteLink,
      expiresAt: newExpiresAt,
    });

    return {
      id: updated.id,
      email: updated.email,
      token: newToken,
      inviteLink,
      expiresAt: newExpiresAt,
      message: 'Đã gửi lại lời mời thành công',
    };
  }

  /**
   * Xóa lời mời khỏi danh sách (Soft-delete)
   */
  async deleteInvitation(tenantId: string, invitationId: string) {
    const invitation = await this.prisma.tenantInvitation.findFirst({
      where: { id: invitationId, tenantId, deletedAt: null },
    });

    if (!invitation) {
      throw new NotFoundException('Không tìm thấy lời mời trong tổ chức này');
    }

    await this.prisma.tenantInvitation.update({
      where: { id: invitationId },
      data: { deletedAt: new Date() },
    });

    return { message: 'Đã xóa lời mời thành công' };
  }

  /**
   * Xem thông tin chi tiết lời mời từ token (Public preview endpoint)
   */
  async getInvitationByToken(token: string) {
    const invitation = await this.prisma.tenantInvitation.findFirst({
      where: { token, deletedAt: null },
      include: {
        tenant: { select: { id: true, name: true, code: true, logoUrl: true } },
        inviter: { select: { id: true, displayName: true, email: true } },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Lời mời không tồn tại hoặc đã bị xóa');
    }

    if (invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
      if (invitation.status === 'PENDING' && invitation.expiresAt < new Date()) {
        await this.prisma.tenantInvitation.update({
          where: { id: invitation.id },
          data: { status: 'EXPIRED' },
        });
      }
      throw new BadRequestException('Lời mời đã hết hạn, đã bị thu hồi hoặc đã được chấp nhận trước đó');
    }

    const roles = await this.prisma.role.findMany({
      where: { id: { in: invitation.roleIds }, tenantId: invitation.tenantId },
      select: { id: true, code: true, name: true, description: true, isSystem: true },
    });

    const existingUser = await this.prisma.user.findFirst({
      where: { email: invitation.email, status: 'ACTIVE', deletedAt: null },
      select: { id: true, email: true, displayName: true },
    });

    const userExists = Boolean(existingUser);

    return {
      id: invitation.id,
      valid: true,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      tenant: invitation.tenant,
      inviter: invitation.inviter,
      roles,
      userExists,
      requiresRegistration: !userExists,
    };
  }

  /**
   * Chấp nhận lời mời và tự động gán đúng các vai trò đã được chọn trước
   */
  async acceptInvitation(
    token: string,
    dto: AcceptInvitationDto,
    meta?: { userAgent?: string; ipAddress?: string },
  ) {
    const preview = await this.getInvitationByToken(token);

    const invitation = await this.prisma.tenantInvitation.findUnique({
      where: { id: preview.id },
    });

    if (!invitation || invitation.status !== 'PENDING') {
      throw new BadRequestException('Lời mời không còn hiệu lực');
    }

    // 1. Kiểm tra tài khoản người dùng
    let user = await this.prisma.user.findFirst({
      where: { email: invitation.email, deletedAt: null },
    });

    if (!user) {
      if (!dto.password || dto.password.length < 8) {
        throw new BadRequestException('Vui lòng tạo mật khẩu có ít nhất 8 ký tự để hoàn tất đăng ký');
      }

      const passwordHash = await bcrypt.hash(dto.password, 10);
      const displayName = dto.displayName?.trim() || invitation.email.split('@')[0] || 'User';

      user = await this.prisma.user.create({
        data: {
          email: invitation.email,
          passwordHash,
          displayName,
          status: 'ACTIVE',
        },
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException('Tài khoản của bạn đã bị khóa hoặc ngừng hoạt động');
    }

    // 2. Chạy transaction gán thành viên và các roles
    const { membership, validRoles } = await this.prisma.$transaction(async (tx) => {
      // a. Kiểm tra thành viên đã active trong tenant chưa
      const existingMembership = await tx.userTenant.findFirst({
        where: { userId: user.id, tenantId: invitation.tenantId, deletedAt: null },
      });

      if (existingMembership && existingMembership.status === 'ACTIVE') {
        throw new ConflictException('Bạn đã là thành viên của tổ chức này rồi');
      }

      // b. Lấy danh sách roles từ invitation
      const validRoles = await tx.role.findMany({
        where: { id: { in: invitation.roleIds }, tenantId: invitation.tenantId, deletedAt: null },
      });

      // c. Xác định primaryRole: OWNER > ADMIN > Custom > MEMBER
      let primaryRole = 'MEMBER';
      if (validRoles.some((r) => r.code === 'OWNER')) {
        primaryRole = 'OWNER';
      } else if (validRoles.some((r) => r.code === 'ADMIN')) {
        primaryRole = 'ADMIN';
      } else if (validRoles.length > 0) {
        primaryRole = validRoles[0].code;
      }

      // d. Kiểm tra số tenant để đặt isDefault
      const userTenantsCount = await tx.userTenant.count({
        where: { userId: user.id, deletedAt: null },
      });
      const isDefault = userTenantsCount === 0;

      // e. Tạo hoặc kích hoạt lại UserTenant
      let membership = existingMembership;
      if (existingMembership) {
        membership = await tx.userTenant.update({
          where: { id: existingMembership.id },
          data: { role: primaryRole, status: 'ACTIVE', deletedAt: null },
        });
      } else {
        membership = await tx.userTenant.create({
          data: {
            userId: user.id,
            tenantId: invitation.tenantId,
            role: primaryRole,
            isDefault,
            status: 'ACTIVE',
          },
        });
      }

      // f. Gán tất cả vai trò vào bảng user_roles
      for (const r of validRoles) {
        await tx.userRole.upsert({
          where: {
            tenantId_userId_roleId: {
              tenantId: invitation.tenantId,
              userId: user.id,
              roleId: r.id,
            },
          },
          update: { deletedAt: null },
          create: {
            tenantId: invitation.tenantId,
            userId: user.id,
            roleId: r.id,
            grantedBy: invitation.inviterId,
          },
        });
      }

      // g. Cập nhật lời mời thành ACCEPTED và xóa bản ghi lời mời (soft-delete)
      await tx.tenantInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date(), deletedAt: new Date() },
      });

      return { membership, validRoles };
    });

    let permissions: string[] = [];
    if (user.isSuperAdmin || membership.role === 'OWNER') {
      permissions = ['*'];
    } else {
      const assignedRoleIds = validRoles.map((r) => r.id);
      const rolePerms = await this.prisma.rolePermission.findMany({
        where: { roleId: { in: assignedRoleIds }, deletedAt: null },
        include: { permission: true },
      });
      const permSet = new Set<string>();
      for (const rp of rolePerms) {
        if (rp.permission && !rp.permission.deletedAt) {
          permSet.add(rp.permission.code);
        }
      }
      permissions = Array.from(permSet);
    }

    const payload = {
      sub: user.id,
      email: user.email,
      tenantId: invitation.tenantId,
      role: membership.role,
      isSuperAdmin: Boolean(user.isSuperAdmin),
      permissions,
    };

    const accessToken = this.tokenService.generateAccessToken(payload);
    const refreshToken = this.tokenService.generateRefreshToken(payload);

    await this.tokenService.createSession({
      userId: user.id,
      tenantId: invitation.tenantId,
      refreshToken,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        phoneNumber: user.phoneNumber,
        avatarUrl: user.avatarUrl,
        isSuperAdmin: Boolean(user.isSuperAdmin),
      },
      activeTenant: {
        id: preview.tenant.id,
        code: preview.tenant.code,
        name: preview.tenant.name,
        logoUrl: preview.tenant.logoUrl,
        role: membership.role,
      },
      assignedRoles: validRoles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
      message: 'Chấp nhận lời mời và gia nhập tổ chức thành công',
    };
  }
}
