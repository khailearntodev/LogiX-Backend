import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service.js';
import { TokenService } from './token.service.js';
import { LoginDto } from '../dto/login.dto.js';
import { RegisterDto } from '../dto/register.dto.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import { SwitchTenantDto } from '../dto/switch-tenant.dto.js';
import { CreateOrganizationDto } from '../dto/create-organization.dto.js';
import { UpdateProfileDto } from '../dto/update-profile.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async login(dto: LoginDto, meta?: { userAgent?: string; ipAddress?: string }) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      include: {
        userTenants: {
          where: { status: 'ACTIVE', deletedAt: null },
          include: { tenant: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Tài khoản của bạn đã bị khóa hoặc ngừng hoạt động');
    }

    const isPasswordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordMatch) {
      throw new UnauthorizedException('Email hoặc mật khẩu không chính xác');
    }

    if (!user.userTenants || user.userTenants.length === 0) {
      throw new UnauthorizedException('Bạn chưa tham gia tổ chức nào hoặc tài khoản tại tổ chức đã bị ngưng hoạt động');
    }

    // Chọn active tenant:
    // 1. Nếu Client chỉ định tenantId
    // 2. Nếu không, chọn tenant có isDefault = true
    // 3. Nếu không có isDefault, chọn tenant vừa hoạt động gần đây nhất (đã sort theo updatedAt DESC)
    let selectedUserTenant = dto.tenantId
      ? user.userTenants.find((ut) => ut.tenantId === dto.tenantId)
      : undefined;

    if (dto.tenantId && !selectedUserTenant) {
      throw new UnauthorizedException('Bạn không có quyền truy cập vào tổ chức này');
    }

    if (!selectedUserTenant) {
      selectedUserTenant = user.userTenants.find((ut) => ut.isDefault) || user.userTenants[0];
    }

    // Cập nhật thời điểm đăng nhập & thời điểm tương tác gần nhất với tenant này
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
      this.prisma.userTenant.update({
        where: { id: selectedUserTenant.id },
        data: { updatedAt: new Date() },
      }),
    ]);

    const payload = {
      sub: user.id,
      email: user.email,
      tenantId: selectedUserTenant.tenantId,
    };

    const accessToken = this.tokenService.generateAccessToken(payload);
    const refreshToken = this.tokenService.generateRefreshToken(payload);

    await this.tokenService.createSession({
      userId: user.id,
      tenantId: selectedUserTenant.tenantId,
      refreshToken,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
    });

    const tenantsList = user.userTenants.map((ut) => ({
      id: ut.tenant.id,
      code: ut.tenant.code,
      name: ut.tenant.name,
      logoUrl: ut.tenant.logoUrl,
      role: ut.role,
      isDefault: ut.isDefault,
    }));

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        phoneNumber: user.phoneNumber,
        avatarUrl: user.avatarUrl,
      },
      activeTenant: {
        id: selectedUserTenant.tenant.id,
        code: selectedUserTenant.tenant.code,
        name: selectedUserTenant.tenant.name,
        logoUrl: selectedUserTenant.tenant.logoUrl,
        role: selectedUserTenant.role,
      },
      tenants: tenantsList,
    };
  }

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    const hasInvite = Boolean(dto.tenantId || dto.tenantCode);

    // Nếu người dùng ĐÃ TỒN TẠI tài khoản và KHÔNG CÓ link/mã mời
    if (existingUser && !hasInvite) {
      throw new ConflictException(
        'Tài khoản này đã tồn tại trên hệ thống. Vui lòng đăng nhập hoặc tạo tổ chức mới sau khi đăng nhập.',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const displayName = dto.displayName || dto.email.split('@')[0] || 'User';

    let user = existingUser;

    // Nếu người dùng cũ gia nhập qua link mời ➔ Xác thực mật khẩu
    if (user) {
      const isPasswordMatch = await bcrypt.compare(dto.password, user.passwordHash);
      if (!isPasswordMatch) {
        throw new UnauthorizedException('Email đã tồn tại. Mật khẩu không chính xác để gia nhập tổ chức.');
      }
    }

    let tenant = null;
    let isNewTenantCreated = false;

    if (dto.tenantId) {
      tenant = await this.prisma.tenant.findUnique({ where: { id: dto.tenantId } });
      if (!tenant) {
        throw new NotFoundException('Không tìm thấy tổ chức từ liên kết mời');
      }
    } else if (dto.tenantCode) {
      tenant = await this.prisma.tenant.findFirst({ where: { code: dto.tenantCode } });
      if (!tenant) {
        throw new NotFoundException('Không tìm thấy tổ chức từ liên kết mời');
      }
    } else {
      // Đăng ký LẦN ĐẦU không có link mời ➔ Tự động tạo Tenant mặc định đầu tiên
      const tenantName = dto.tenantName?.trim() || `${displayName}'s Organization`;
      const tenantCode = `tenant-${crypto.randomBytes(6).toString('hex')}`;

      tenant = await this.prisma.tenant.create({
        data: {
          code: tenantCode,
          name: tenantName,
          status: 'ACTIVE',
          settings: {},
        },
      });
      isNewTenantCreated = true;
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          displayName,
          phoneNumber: dto.phoneNumber || null,
          status: 'ACTIVE',
        },
      });
    }

    // Kiểm tra xem User đã ở trong Tenant này chưa
    const existingMembership = await this.prisma.userTenant.findFirst({
      where: { userId: user.id, tenantId: tenant.id },
    });

    if (existingMembership) {
      throw new ConflictException('Tài khoản của bạn đã là thành viên của tổ chức này rồi');
    }

    const userTenantsCount = await this.prisma.userTenant.count({
      where: { userId: user.id },
    });

    await this.prisma.userTenant.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        role: isNewTenantCreated ? 'OWNER' : 'MEMBER',
        isDefault: userTenantsCount === 0,
        status: 'ACTIVE',
      },
    });

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      tenant: {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
      },
      message: 'Đăng ký tài khoản thành công',
    };
  }

  async createOrganization(userId: string, dto: CreateOrganizationDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.status !== 'ACTIVE') {
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

  async switchTenant(userId: string, dto: SwitchTenantDto, meta?: { userAgent?: string; ipAddress?: string }) {
    const userTenant = await this.prisma.userTenant.findFirst({
      where: {
        userId,
        tenantId: dto.tenantId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      include: {
        user: true,
        tenant: true,
      },
    });

    if (!userTenant || !userTenant.user || userTenant.user.status !== 'ACTIVE' || !userTenant.tenant) {
      throw new UnauthorizedException('Bạn không có quyền chuyển sang tổ chức này');
    }

    // Cập nhật thời điểm vừa tương tác/làm việc tại Tenant này
    await this.prisma.userTenant.update({
      where: { id: userTenant.id },
      data: { updatedAt: new Date() },
    });

    const payload = {
      sub: userTenant.userId,
      email: userTenant.user.email,
      tenantId: userTenant.tenantId,
    };

    const accessToken = this.tokenService.generateAccessToken(payload);
    const refreshToken = this.tokenService.generateRefreshToken(payload);

    await this.tokenService.createSession({
      userId: userTenant.userId,
      tenantId: userTenant.tenantId,
      refreshToken,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      activeTenant: {
        id: userTenant.tenant.id,
        code: userTenant.tenant.code,
        name: userTenant.tenant.name,
        logoUrl: userTenant.tenant.logoUrl,
        role: userTenant.role,
      },
    };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      include: { userTenants: { where: { status: 'ACTIVE', deletedAt: null } } },
    });

    if (!user || !user.userTenants || user.userTenants.length === 0) {
      return {
        message: 'Nếu email tồn tại trên hệ thống, chúng tôi đã gửi liên kết khôi phục mật khẩu.',
      };
    }

    const primaryTenantId = user.userTenants[0].tenantId;

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 phút

    await this.prisma.passwordResetToken.create({
      data: {
        tenantId: primaryTenantId,
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    return {
      message: 'Hướng dẫn khôi phục mật khẩu đã được gửi đến email của bạn.',
      devToken: process.env.NODE_ENV !== 'production' ? rawToken : undefined,
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    if (!user) {
      throw new NotFoundException('Không tìm thấy tài khoản tương ứng');
    }

    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');
    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        tokenHash,
        isUsed: false,
      },
    });

    if (!resetToken || resetToken.expiresAt < new Date()) {
      throw new BadRequestException('Mã xác thực không hợp lệ hoặc đã hết hạn');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { isUsed: true, usedAt: new Date() },
      }),
    ]);

    return {
      message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập bằng mật khẩu mới.',
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Người dùng không hợp lệ hoặc đã bị khóa');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName && { displayName: dto.displayName.trim() }),
        ...(dto.phoneNumber !== undefined && { phoneNumber: dto.phoneNumber ? dto.phoneNumber.trim() : null }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl ? dto.avatarUrl.trim() : null }),
      },
    });

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      displayName: updatedUser.displayName,
      phoneNumber: updatedUser.phoneNumber,
      avatarUrl: updatedUser.avatarUrl,
      message: 'Cập nhật thông tin cá nhân thành công',
    };
  }

  async getProfile(userId: string, currentTenantId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userTenants: {
          where: { status: 'ACTIVE', deletedAt: null },
          include: { tenant: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Không tìm thấy thông tin người dùng');
    }

    const activeUserTenant = currentTenantId
      ? user.userTenants.find((ut) => ut.tenantId === currentTenantId) || user.userTenants[0]
      : user.userTenants[0];

    const tenantsList = user.userTenants.map((ut) => ({
      id: ut.tenant.id,
      code: ut.tenant.code,
      name: ut.tenant.name,
      logoUrl: ut.tenant.logoUrl,
      role: ut.role,
      isDefault: ut.isDefault,
    }));

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      phoneNumber: user.phoneNumber,
      avatarUrl: user.avatarUrl,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      activeTenant: activeUserTenant
        ? {
            id: activeUserTenant.tenant.id,
            code: activeUserTenant.tenant.code,
            name: activeUserTenant.tenant.name,
            logoUrl: activeUserTenant.tenant.logoUrl,
            role: activeUserTenant.role,
          }
        : null,
      tenants: tenantsList,
    };
  }
}
