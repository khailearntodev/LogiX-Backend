export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role?: string;
  isSuperAdmin?: boolean;
  permissions?: string[];
  tokenVersion?: number;
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  tenantId: string;
  displayName?: string;
  phoneNumber?: string | null;
  avatarUrl?: string | null;
  tenantName?: string;
  tenantLogoUrl?: string | null;
  role?: string;
  status?: string;
  isSuperAdmin?: boolean;
  permissions?: string[];
  [key: string]: any;
}
