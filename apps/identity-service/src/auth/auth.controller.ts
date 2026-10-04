import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  UseGuards,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './services/auth.service.js';
import { TokenService } from './services/token.service.js';
import { RolesService } from '../iam/services/roles.service.js';
import { InvitationsService } from '../iam/services/invitations.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { SwitchTenantDto } from './dto/switch-tenant.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { AuthenticatedUser } from './interfaces/jwt-payload.interface.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly rolesService: RolesService,
    private readonly invitationsService: InvitationsService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const meta = {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.socket.remoteAddress,
    };

    const result = await this.authService.login(dto, meta);

    // Set RefreshToken in HttpOnly Cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return {
      accessToken: result.accessToken,
      user: result.user,
      activeTenant: result.activeTenant,
      tenants: result.tenants,
    };
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Get('invitations/:token')
  async getInvitationByToken(@Param('token') token: string) {
    return this.invitationsService.getInvitationByToken(token);
  }

  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const meta = {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.socket.remoteAddress,
    };

    const result = await this.invitationsService.acceptInvitation(token, dto, meta);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return result;
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.refreshToken || dto.refreshToken;

    if (!refreshToken) {
      throw new UnauthorizedException('Không tìm thấy Refresh Token');
    }

    const result = await this.tokenService.refreshTokens(refreshToken);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const profile = await this.authService.getProfile(result.user.id, result.user.tenantId);

    return {
      accessToken: result.accessToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.displayName,
        phoneNumber: result.user.phoneNumber,
        avatarUrl: result.user.avatarUrl,
      },
      activeTenant: profile.activeTenant,
      tenants: profile.tenants,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.refreshToken || dto.refreshToken;

    if (refreshToken) {
      await this.tokenService.revokeSessionByToken(refreshToken);
    }

    res.clearCookie('refreshToken', { path: '/api/v1/auth' });

    return { message: 'Đăng xuất thành công' };
  }

  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async switchTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SwitchTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const meta = {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.socket.remoteAddress,
    };

    const result = await this.authService.switchTenant(user.id, dto, meta);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return {
      accessToken: result.accessToken,
      activeTenant: result.activeTenant,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.id, user.tenantId);
  }

  @Get('me/permissions')
  @UseGuards(JwtAuthGuard)
  async getEffectivePermissions(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('x-tenant-id') headerTenantId?: string,
  ) {
    const tenantId = user.isSuperAdmin && headerTenantId ? headerTenantId : user.tenantId;
    return this.rolesService.getEffectivePermissions(user.id, tenantId);
  }


  @Post('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.id, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async deleteAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.deleteAccount(user.id);
    res.clearCookie('refreshToken', { path: '/api/v1/auth' });
    return result;
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const currentRefreshToken = req.cookies?.refreshToken;
    return this.authService.changePassword(user.id, dto, currentRefreshToken);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async getActiveSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const currentRefreshToken = req.cookies?.refreshToken;
    return this.tokenService.getActiveSessions(user.id, currentRefreshToken);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    return this.tokenService.revokeSession(user.id, sessionId);
  }

  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
  ) {
    const currentRefreshToken = req.cookies?.refreshToken || dto.refreshToken;
    return this.tokenService.revokeOtherSessions(user.id, currentRefreshToken);
  }
}
