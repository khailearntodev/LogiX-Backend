import { ExtractJwt, type JwtFromRequestFunction } from 'passport-jwt';

const ACCESS_TOKEN_COOKIE = 'accessToken';

/**
 * Single source of truth for where the access token is read from. Used by the
 * JWT strategy and when forwarding the caller's credentials to other services,
 * so the forwarded token is always the one that was authenticated.
 */
export const extractAccessToken: JwtFromRequestFunction =
  ExtractJwt.fromExtractors([
    ExtractJwt.fromAuthHeaderAsBearerToken(),
    (request: { cookies?: Record<string, string> }) =>
      request?.cookies?.[ACCESS_TOKEN_COOKIE] ?? null,
  ]);
