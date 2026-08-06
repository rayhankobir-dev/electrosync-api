export interface JwtPayload {
  sub: string;
  email: string;
  type: 'access';
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
}

export interface IssuedToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export const CREDENTIAL_PROVIDER = 'credential';
