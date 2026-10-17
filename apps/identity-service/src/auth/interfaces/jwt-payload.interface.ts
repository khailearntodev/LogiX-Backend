export type { JwtPayload } from '@logix/auth';

export interface AuthenticatedUser {
  id: string;
  email: string;
  tenantId: string;
  displayName: string;
  phoneNumber?: string | null;
  avatarUrl?: string | null;
  tenantName?: string;
  tenantLogoUrl?: string | null;
  role?: string;
  status: string;
  isSuperAdmin?: boolean;
  permissions?: string[];
}