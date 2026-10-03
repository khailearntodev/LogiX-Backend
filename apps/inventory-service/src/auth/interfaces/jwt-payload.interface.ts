export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

/** Actor resolved from the token only — inventory-service never reads the identity database. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  tenantId: string;
  role?: string;
}
