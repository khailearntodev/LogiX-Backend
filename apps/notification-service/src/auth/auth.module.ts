import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtAuthGuard, PermissionsGuard } from '@logix/auth';
import { JwtStrategy } from './jwt.strategy.js';

@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [JwtStrategy, JwtAuthGuard, PermissionsGuard],
  exports: [PassportModule, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}
