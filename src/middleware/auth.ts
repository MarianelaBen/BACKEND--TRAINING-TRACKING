import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../lib/auth.js';
import type { Rol } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: Rol };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Falta el token de autenticación' });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.auth = { userId: payload.sub, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// El rol se valida siempre en el backend: cada endpoint que lo necesite
// tiene que declarar qué roles puede aceptar.
export function requireRole(...roles: Rol[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Falta el token de autenticación' });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'No tenés permiso para esto' });
      return;
    }
    next();
  };
}
