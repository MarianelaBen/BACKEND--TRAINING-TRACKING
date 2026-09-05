import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword, signToken } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import type { Rol } from '../types/index.js';

export const authRouter = Router();

function toUsuario(user: { id: string; email: string; role: string; name: string; initials: string | null }) {
  return { id: user.id, email: user.email, role: user.role, name: user.name, initials: user.initials };
}

authRouter.post('/register', async (req, res) => {
  const { email, password, name, role } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
    res.status(400).json({ error: 'Faltan datos: email, password y name son obligatorios' });
    return;
  }
  if (role !== 'COACH' && role !== 'STUDENT') {
    res.status(400).json({ error: 'role tiene que ser COACH o STUDENT' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres' });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
    return;
  }

  // Sistema de un solo coach: un alumno nuevo no puede quedar sin nadie que
  // le asigne rutinas. Si en algún momento hay más de un coach, esto elige
  // el más antiguo -- determinístico, no al azar -- pero ese caso todavía
  // no tiene un criterio real de producto. Si no hay ningún coach (DB nueva,
  // antes del seed), el alumno queda sin asignar, igual que antes de este
  // cambio -- no bloquea el registro.
  let coachId: string | null = null;
  if (role === 'STUDENT') {
    const coach = await prisma.user.findFirst({
      where: { role: 'COACH' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    coachId = coach?.id ?? null;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role: role as Rol,
      ...(role === 'STUDENT' ? { studentProfile: { create: { coachId } } } : {}),
    },
  });

  const token = signToken({ sub: user.id, role: user.role as Rol });
  res.status(201).json({ token, user: toUsuario(user) });
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Faltan datos: email y password son obligatorios' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    res.status(401).json({ error: 'Email o contraseña incorrectos' });
    return;
  }

  const token = signToken({ sub: user.id, role: user.role as Rol });
  res.json({ token, user: toUsuario(user) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }
  res.json(toUsuario(user));
});
