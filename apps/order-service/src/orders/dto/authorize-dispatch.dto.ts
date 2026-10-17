import { IsInt, IsUUID, Max, Min } from 'class-validator';
import type { AuthorizeOrderDispatchRequest } from '@logix/messaging';

export class AuthorizeDispatchDto implements AuthorizeOrderDispatchRequest {
  @IsUUID()
  requestId!: string;

  @IsUUID()
  shipmentId!: string;

  @IsUUID()
  reservationGroupId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  orderVersion!: number;

  @IsUUID()
  actorId!: string;
}
