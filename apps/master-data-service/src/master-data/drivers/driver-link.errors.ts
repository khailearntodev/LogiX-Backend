import { DomainError, ErrorCode } from '@logix/errors';

export class DriverLinkLockedError extends DomainError {
  readonly code = ErrorCode.DRIVER_LINK_LOCKED;
  readonly httpStatus = 409;

  constructor(driverId: string) {
    super(
      'Không thể đổi người dùng: tài xế đã được tham chiếu trong chuyến giao',
      {
        driverId,
        reason: 'USED',
      },
    );
  }
}

export class DriverLinkUnchangedError extends DomainError {
  readonly code = ErrorCode.DRIVER_LINK_UNCHANGED;
  readonly httpStatus = 409;

  constructor(driverId: string) {
    super('Người dùng mới trùng với liên kết hiện tại', { driverId });
  }
}
