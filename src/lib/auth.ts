import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { Rol } from '../types/index.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('Falta SESSION_SECRET en las variables de entorno');
  }
  return secret;
})();

const JWT_EXPIRES_IN = '7d';

export interface TokenPayload {
  sub: string;
  role: Rol;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
