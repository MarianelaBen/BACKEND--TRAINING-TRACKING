import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { countUnread, fetchThreadAndMarkRead, sendMessage } from '../lib/messages.js';

export const coachRouter = Router();

coachRouter.use(requireAuth, requireRole('COACH'));

const MAX_MENSAJE = 2000;

// El rol se valida siempre en el backend, y acá además el permiso sobre el
// recurso concreto: un coach sólo puede ver/mandar mensajes de sus propios
// alumnos (StudentProfile.coachId === su propio userId).
async function resolveOwnedStudent(req: Request<{ studentId: string }>, res: Response): Promise<{ id: string } | null> {
  const student = await prisma.studentProfile.findUnique({
    where: { id: req.params.studentId },
    select: { id: true, coachId: true },
  });
  if (!student) {
    res.status(404).json({ error: 'Alumno no encontrado' });
    return null;
  }
  if (student.coachId !== req.auth!.userId) {
    res.status(403).json({ error: 'No tenés permiso sobre este alumno' });
    return null;
  }
  return student;
}

coachRouter.get('/students/:studentId/messages', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const messages = await fetchThreadAndMarkRead(student.id, req.auth!.userId);
  res.json(messages);
});

coachRouter.get('/students/:studentId/messages/unread-count', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const count = await countUnread(student.id, req.auth!.userId);
  res.json({ count });
});

coachRouter.post('/students/:studentId/messages', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const { body } = req.body ?? {};
  if (typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'body es obligatorio' });
    return;
  }
  if (body.length > MAX_MENSAJE) {
    res.status(400).json({ error: `El mensaje es demasiado largo (máximo ${MAX_MENSAJE} caracteres)` });
    return;
  }

  const message = await sendMessage(student.id, req.auth!.userId, body.trim());
  res.status(201).json(message);
});
