import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_DEFAULT_LIMIT,
  AUDIT_DEFAULT_PAGE,
  AUDIT_MAX_LIMIT,
  AUDIT_OUTCOMES,
  type AuditActorTypeFilter,
  type AuditOutcomeFilter,
} from '../audit-logs.constants.js';

export class QueryAuditLogsDto {
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsIn(AUDIT_ACTOR_TYPES)
  actorType?: AuditActorTypeFilter;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsIn(AUDIT_OUTCOMES)
  outcome?: AuditOutcomeFilter;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceService?: string;

  @IsOptional()
  @IsUUID()
  correlationId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = AUDIT_DEFAULT_PAGE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_LIMIT)
  limit?: number = AUDIT_DEFAULT_LIMIT;
}
