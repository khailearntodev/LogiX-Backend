import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  AUDIT_PERMISSIONS,
  CurrentUser,
  JwtAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedUser,
} from '@logix/auth';
import { AuditLogsService } from './audit-logs.service.js';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto.js';

/**
 * Immutable, strictly read-only Audit Trail Query API (BR-AUD-002, FR-AUD-001, NFR-AUD-001).
 * No POST/PUT/PATCH/DELETE endpoints are exposed by design.
 */
@Controller('audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(AUDIT_PERMISSIONS.LOG_READ)
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  listAuditLogs(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryAuditLogsDto,
  ) {
    return this.auditLogsService.listAuditLogs(user.tenantId, query);
  }

  @Get('correlations/:correlationId')
  getCorrelationChain(
    @CurrentUser() user: AuthenticatedUser,
    @Param('correlationId') correlationId: string,
  ) {
    return this.auditLogsService.getCorrelationChain(
      user.tenantId,
      correlationId,
    );
  }

  @Get(':id')
  getAuditLogById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.auditLogsService.getAuditLogById(user.tenantId, id);
  }
}
