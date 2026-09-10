// Lógica de chat compartida entre student.routes.ts y coach.routes.ts.
// Un hilo por alumno (Message.studentId), sin sub-threads. senderId es
// siempre un User.id (coach o alumno) — "es del otro lado" se resuelve
// comparando contra el userId de quien pregunta, sin necesidad de resolver
// el User.id del alumno por separado.

import { prisma } from './prisma.js';
import type { Mensaje } from '../types/index.js';

interface MessageRow {
  id: string;
  studentId: string;
  senderId: string;
  body: string;
  sentAt: Date;
  readAt: Date | null;
}

function toMensaje(m: MessageRow, wasUnread = false): Mensaje {
  return {
    id: m.id,
    studentId: m.studentId,
    senderId: m.senderId,
    body: m.body,
    sentAt: m.sentAt.toISOString(),
    readAt: m.readAt ? m.readAt.toISOString() : null,
    wasUnread,
  };
}

// Marca como leídos los mensajes del otro lado (efecto de abrir el hilo) y
// devuelve el hilo completo ya actualizado.
export async function fetchThreadAndMarkRead(studentId: string, viewerUserId: string): Promise<Mensaje[]> {
  const messages = await prisma.message.findMany({
    where: { studentId },
    orderBy: { sentAt: 'asc' },
  });
  const unreadIds = messages
    .filter((message) => message.senderId !== viewerUserId && message.readAt === null)
    .map((message) => message.id);
  const leidoEn = new Date();
  if (unreadIds.length > 0) {
    await prisma.message.updateMany({
      where: { id: { in: unreadIds } },
      data: { readAt: leidoEn },
    });
  }
  const unread = new Set(unreadIds);
  return messages.map((message) =>
    toMensaje(
      unread.has(message.id) ? { ...message, readAt: leidoEn } : message,
      unread.has(message.id),
    ),
  );
}

// "Peek" sin marcar nada leído — para el puntito de la tab bar.
export async function countUnread(studentId: string, viewerUserId: string): Promise<number> {
  return prisma.message.count({
    where: { studentId, senderId: { not: viewerUserId }, readAt: null },
  });
}

export async function sendMessage(studentId: string, senderId: string, body: string): Promise<Mensaje> {
  const message = await prisma.message.create({ data: { studentId, senderId, body } });
  return toMensaje(message);
}
