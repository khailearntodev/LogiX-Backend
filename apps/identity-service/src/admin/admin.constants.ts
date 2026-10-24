export const ADMIN_DEFAULT_PAGE = 1;
export const ADMIN_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_MAX_PAGE_SIZE = 100;
export const ADMIN_MAX_SEARCH_LENGTH = 200;
// Prisma's skip argument must fit a signed 32-bit integer.
export const ADMIN_MAX_OFFSET = 2_147_483_647;
export const ADMIN_ACTIVE_MEMBERSHIP_STATUS = 'ACTIVE';

export enum AdminOrganizationStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DISABLED = 'DISABLED',
}

export enum AdminUserStatus {
  ACTIVE = 'ACTIVE',
  LOCKED = 'LOCKED',
  DISABLED = 'DISABLED',
}
