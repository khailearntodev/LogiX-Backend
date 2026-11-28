import { ExtractJwt, type JwtFromRequestFunction } from 'passport-jwt';

const ACCESS_TOKEN_COOKIE = 'accessToken';

export const extractAccessToken: JwtFromRequestFunction =
  ExtractJwt.fromExtractors([
    ExtractJwt.fromAuthHeaderAsBearerToken(),
    (request: { cookies?: Record<string, string> }) =>
      request?.cookies?.[ACCESS_TOKEN_COOKIE] ?? null,
  ]);
