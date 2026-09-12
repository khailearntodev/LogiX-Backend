export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

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
}
