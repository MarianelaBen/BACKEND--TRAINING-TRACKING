import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { countUnread, fetchThreadAndMarkRead, sendMessage } from '../lib/messages.js';
import { addDays, mondayOf, parseDateParam, toDateString, todayInGymTZ } from '../lib/dates.js';
import type { RoutineBlockCreate } from '../lib/routines.js';
import { routineWithBlocksInclude, toRutina, toRutinaResumen, validateBlocksInput } from '../lib/routines.js';
import { computeAdherence } from '../lib/adherence.js';
import type {
  AlumnoFicha,
  AlumnoResumen,
  Asignacion,
  DiaAsignacionCoach,
  Marca,
  RutinaListado,
  TipoRutina,
} from '../types/index.js';

export const coachRouter = Router();

coachRouter.use(requireAuth, requireRole('COACH'));

const MAX_MENSAJE = 2000;
const TIPOS_RUTINA: TipoRutina[] = ['FUERZA', 'METABOLICO', 'MOVILIDAD'];
const MAX_ADHERENCE_DAYS = 180;

// El rol se valida siempre en el backend, y acá además el permiso sobre el
// recurso concreto: un coach sólo puede ver/tocar sus propios alumnos
// (StudentProfile.coachId === su propio userId).
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

// Mismo patrón que resolveOwnedStudent, pero recibe el id explícito (además
// de /coach/routines/:routineId, se usa al asignar una rutina por su id desde
// el body de POST /coach/students/:studentId/assignments).
async function resolveOwnedRoutine(
  req: Request,
  res: Response,
  routineId: string,
): Promise<{ id: string; name: string; type: string } | null> {
  const routine = await prisma.routine.findUnique({
    where: { id: routineId },
    select: { id: true, coachId: true, name: true, type: true },
  });
  if (!routine) {
    res.status(404).json({ error: 'Rutina no encontrada' });
    return null;
  }
  if (routine.coachId !== req.auth!.userId) {
    res.status(403).json({ error: 'No tenés permiso sobre esta rutina' });
    return null;
  }
  return routine;
}

// El ownership del alumno ya lo garantizó resolveOwnedStudent; acá sólo hace
// falta confirmar que la marca sea de ese alumno.
async function resolveOwnedRecord(res: Response, studentId: string, recordId: string): Promise<{ id: string } | null> {
  const record = await prisma.personalRecord.findUnique({ where: { id: recordId }, select: { id: true, studentId: true } });
  if (!record || record.studentId !== studentId) {
    res.status(404).json({ error: 'Marca no encontrada' });
    return null;
  }
  return record;
}

function toMarca(record: { id: string; studentId: string; exerciseName: string; value: string; note: string | null; updatedAt: Date }): Marca {
  return {
    id: record.id,
    studentId: record.studentId,
    exerciseName: record.exerciseName,
    value: record.value,
    note: record.note,
    updatedAt: record.updatedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// ALUMNOS
// ─────────────────────────────────────────────────────────────

coachRouter.get('/students', async (req, res) => {
  const students = await prisma.studentProfile.findMany({
    where: { coachId: req.auth!.userId },
    include: { user: { select: { name: true, initials: true } } },
    orderBy: { user: { name: 'asc' } },
  });

  const body: AlumnoResumen[] = await Promise.all(
    students.map(async (s) => ({
      id: s.id,
      userId: s.userId,
      name: s.user.name,
      initials: s.user.initials,
      plan: s.plan,
      planActive: s.planActive,
      nextPayment: s.nextPayment ? s.nextPayment.toISOString() : null,
      unreadCount: await countUnread(s.id, req.auth!.userId),
    })),
  );
  res.json(body);
});

coachRouter.get('/students/:studentId', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const profile = await prisma.studentProfile.findUnique({
    where: { id: student.id },
    include: {
      user: { select: { name: true, email: true, initials: true } },
      records: { orderBy: { updatedAt: 'desc' } },
    },
  });

  const body: AlumnoFicha = {
    id: profile!.id,
    userId: profile!.userId,
    name: profile!.user.name,
    email: profile!.user.email,
    initials: profile!.user.initials,
    plan: profile!.plan,
    planStartDate: profile!.planStartDate ? profile!.planStartDate.toISOString() : null,
    planActive: profile!.planActive,
    nextPayment: profile!.nextPayment ? profile!.nextPayment.toISOString() : null,
    records: profile!.records.map(toMarca),
  };
  res.json(body);
});

// Marcas: las carga el coach a mano (no se recalculan solas a partir de las
// sesiones). Una por exerciseName por alumno: POST no pisa una existente
// (409, usá PATCH), así "marca" es siempre el valor vigente de ese ejercicio,
// no un historial de intentos.
coachRouter.post('/students/:studentId/records', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const { exerciseName, value, note } = req.body ?? {};
  if (typeof exerciseName !== 'string' || exerciseName.trim().length === 0) {
    res.status(400).json({ error: 'exerciseName es obligatorio' });
    return;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    res.status(400).json({ error: 'value es obligatorio' });
    return;
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    res.status(400).json({ error: 'note inválido' });
    return;
  }

  const existing = await prisma.personalRecord.findFirst({
    where: { studentId: student.id, exerciseName: exerciseName.trim() },
  });
  if (existing) {
    res.status(409).json({ error: 'Ya existe una marca para ese ejercicio, usá PATCH para actualizarla' });
    return;
  }

  const record = await prisma.personalRecord.create({
    data: { studentId: student.id, exerciseName: exerciseName.trim(), value: value.trim(), note: note ?? null },
  });
  res.status(201).json(toMarca(record));
});

coachRouter.patch('/students/:studentId/records/:recordId', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;
  const record = await resolveOwnedRecord(res, student.id, req.params.recordId);
  if (!record) return;

  const { value, note } = req.body ?? {};
  const data: { value?: string; note?: string | null } = {};

  if (value !== undefined) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      res.status(400).json({ error: 'value inválido' });
      return;
    }
    data.value = value.trim();
  }
  if (note !== undefined) {
    if (note !== null && typeof note !== 'string') {
      res.status(400).json({ error: 'note inválido' });
      return;
    }
    data.note = note;
  }
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Mandá al menos value o note para actualizar' });
    return;
  }

  const updated = await prisma.personalRecord.update({ where: { id: record.id }, data });
  res.json(toMarca(updated));
});

coachRouter.delete('/students/:studentId/records/:recordId', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;
  const record = await resolveOwnedRecord(res, student.id, req.params.recordId);
  if (!record) return;

  await prisma.personalRecord.delete({ where: { id: record.id } });
  res.status(204).end();
});

// Adherencia = % de días asignados en el rango que el alumno completó.
// Default: últimos 28 días hasta hoy. El cómputo puro vive en lib/adherence.ts
// y reusa la misma noción de "día completo" que GET /student/week.
coachRouter.get('/students/:studentId/adherence', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const rawStart = req.query.start;
  const rawEnd = req.query.end;

  let end: string;
  if (typeof rawEnd === 'string') {
    if (!parseDateParam(rawEnd)) {
      res.status(400).json({ error: 'end tiene que tener el formato YYYY-MM-DD' });
      return;
    }
    end = rawEnd;
  } else {
    end = todayInGymTZ();
  }

  let start: string;
  if (typeof rawStart === 'string') {
    if (!parseDateParam(rawStart)) {
      res.status(400).json({ error: 'start tiene que tener el formato YYYY-MM-DD' });
      return;
    }
    start = rawStart;
  } else {
    start = addDays(end, -27);
  }

  if (start > end) {
    res.status(400).json({ error: 'start tiene que ser anterior o igual a end' });
    return;
  }
  const spanDays = (new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) / 86_400_000;
  if (spanDays > MAX_ADHERENCE_DAYS) {
    res.status(400).json({ error: `El rango no puede superar los ${MAX_ADHERENCE_DAYS} días` });
    return;
  }

  const assignments = await prisma.assignment.findMany({
    where: {
      studentId: student.id,
      date: { gte: new Date(`${start}T00:00:00.000Z`), lte: new Date(`${end}T00:00:00.000Z`) },
    },
    include: {
      routine: { include: routineWithBlocksInclude },
      session: { include: { setLogs: true } },
    },
    orderBy: { date: 'asc' },
  });

  res.json(computeAdherence(assignments, start, end));
});

// ─────────────────────────────────────────────────────────────
// RUTINAS (biblioteca del coach)
// ─────────────────────────────────────────────────────────────

coachRouter.get('/routines', async (req, res) => {
  const routines = await prisma.routine.findMany({
    where: { coachId: req.auth!.userId },
    orderBy: { createdAt: 'desc' },
  });
  const body: RutinaListado[] = routines.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type as TipoRutina,
    createdAt: r.createdAt.toISOString(),
  }));
  res.json(body);
});

coachRouter.get('/routines/:routineId', async (req, res) => {
  const owned = await resolveOwnedRoutine(req, res, req.params.routineId);
  if (!owned) return;

  const routine = await prisma.routine.findUnique({
    where: { id: owned.id },
    include: routineWithBlocksInclude,
  });
  res.json(toRutina(routine!));
});

// Crea la rutina con bloques y ejercicios anidados en un solo create (igual
// que prisma/seed.ts). orderIndex se asigna por posición en el array, no lo
// manda el cliente.
coachRouter.post('/routines', async (req, res) => {
  const { name, type, blocks } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name es obligatorio' });
    return;
  }
  if (typeof type !== 'string' || !TIPOS_RUTINA.includes(type as TipoRutina)) {
    res.status(400).json({ error: `type tiene que ser uno de: ${TIPOS_RUTINA.join(', ')}` });
    return;
  }
  const validated = validateBlocksInput(blocks);
  if ('error' in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const routine = await prisma.routine.create({
    data: { coachId: req.auth!.userId, name: name.trim(), type: type as TipoRutina, blocks: { create: validated.blocks } },
    include: routineWithBlocksInclude,
  });

  res.status(201).json(toRutina(routine));
});

// name/type se pueden editar siempre. blocks (reemplazo completo de la
// estructura) sólo si la rutina todavía no tiene ninguna asignación ni
// sesión — mismo guard que el DELETE de más abajo; si ya está en uso, hay
// que crear una rutina nueva en vez de editar la vieja.
coachRouter.patch('/routines/:routineId', async (req, res) => {
  const owned = await resolveOwnedRoutine(req, res, req.params.routineId);
  if (!owned) return;

  const { name, type, blocks } = req.body ?? {};
  const data: { name?: string; type?: TipoRutina } = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name inválido' });
      return;
    }
    data.name = name.trim();
  }
  if (type !== undefined) {
    if (typeof type !== 'string' || !TIPOS_RUTINA.includes(type as TipoRutina)) {
      res.status(400).json({ error: `type tiene que ser uno de: ${TIPOS_RUTINA.join(', ')}` });
      return;
    }
    data.type = type as TipoRutina;
  }

  let blocksData: RoutineBlockCreate[] | undefined;
  if (blocks !== undefined) {
    const [assignmentCount, sessionCount] = await Promise.all([
      prisma.assignment.count({ where: { routineId: owned.id } }),
      prisma.session.count({ where: { routineId: owned.id } }),
    ]);
    if (assignmentCount > 0 || sessionCount > 0) {
      res.status(409).json({ error: 'No se puede editar la estructura: la rutina ya tiene asignaciones o sesiones asociadas. Creá una rutina nueva.' });
      return;
    }
    const validated = validateBlocksInput(blocks);
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    blocksData = validated.blocks;
  }

  if (Object.keys(data).length === 0 && !blocksData) {
    res.status(400).json({ error: 'Mandá al menos name, type o blocks para actualizar' });
    return;
  }

  let routine;
  if (blocksData) {
    const [, updated] = await prisma.$transaction([
      prisma.block.deleteMany({ where: { routineId: owned.id } }),
      prisma.routine.update({ where: { id: owned.id }, data: { ...data, blocks: { create: blocksData } }, include: routineWithBlocksInclude }),
    ]);
    routine = updated;
  } else {
    routine = await prisma.routine.update({ where: { id: owned.id }, data, include: routineWithBlocksInclude });
  }
  res.json(toRutina(routine));
});

// Sólo si la rutina no tiene asignaciones ni sesiones asociadas: chequeo
// explícito antes de borrar, en vez de dejar que reviente el FK constraint.
coachRouter.delete('/routines/:routineId', async (req, res) => {
  const owned = await resolveOwnedRoutine(req, res, req.params.routineId);
  if (!owned) return;

  const [assignmentCount, sessionCount] = await Promise.all([
    prisma.assignment.count({ where: { routineId: owned.id } }),
    prisma.session.count({ where: { routineId: owned.id } }),
  ]);
  if (assignmentCount > 0 || sessionCount > 0) {
    res.status(409).json({ error: 'No se puede borrar: la rutina tiene asignaciones o sesiones asociadas' });
    return;
  }

  await prisma.routine.delete({ where: { id: owned.id } });
  res.status(204).end();
});

// ─────────────────────────────────────────────────────────────
// ASIGNACIÓN (rutina a alumno por día)
// ─────────────────────────────────────────────────────────────

coachRouter.post('/students/:studentId/assignments', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const { routineId, date: rawDate } = req.body ?? {};
  if (typeof routineId !== 'string' || routineId.trim().length === 0) {
    res.status(400).json({ error: 'routineId es obligatorio' });
    return;
  }
  if (typeof rawDate !== 'string') {
    res.status(400).json({ error: 'date es obligatorio' });
    return;
  }
  const date = parseDateParam(rawDate);
  if (!date) {
    res.status(400).json({ error: 'date tiene que tener el formato YYYY-MM-DD' });
    return;
  }

  const routine = await resolveOwnedRoutine(req, res, routineId);
  if (!routine) return;

  const existing = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId: student.id, date } },
    include: { session: { select: { id: true } } },
  });
  if (existing?.session) {
    res.status(409).json({ error: 'Ese día ya tiene una sesión con series marcadas, no se puede reasignar' });
    return;
  }

  const assignment = await prisma.assignment.upsert({
    where: { studentId_date: { studentId: student.id, date } },
    create: { studentId: student.id, routineId: routine.id, date },
    update: { routineId: routine.id },
  });

  const body: Asignacion = {
    id: assignment.id,
    studentId: assignment.studentId,
    routineId: assignment.routineId,
    date: toDateString(assignment.date),
    routine: toRutinaResumen(routine),
  };
  res.status(existing ? 200 : 201).json(body);
});

coachRouter.delete('/students/:studentId/assignments/:date', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const date = parseDateParam(req.params.date);
  if (!date) {
    res.status(400).json({ error: 'date tiene que tener el formato YYYY-MM-DD' });
    return;
  }

  const assignment = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId: student.id, date } },
    include: { session: { select: { id: true } } },
  });
  if (!assignment) {
    res.status(404).json({ error: 'No hay una asignación ese día' });
    return;
  }
  if (assignment.session) {
    res.status(409).json({ error: 'Ese día ya tiene una sesión con series marcadas, no se puede desasignar' });
    return;
  }

  await prisma.assignment.delete({ where: { id: assignment.id } });
  res.status(204).end();
});

// Vista semanal de lo planificado (no calcula completitud — para eso está
// /adherence). Mismo patrón que GET /student/week: 7 días desde el lunes de
// "start" (o el lunes de esta semana si no se manda), con normalización
// silenciosa de start no-lunes.
coachRouter.get('/students/:studentId/assignments', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const rawStart = req.query.start;
  let start: string;
  if (typeof rawStart === 'string') {
    if (!parseDateParam(rawStart)) {
      res.status(400).json({ error: 'start tiene que tener el formato YYYY-MM-DD' });
      return;
    }
    start = mondayOf(rawStart);
    if (start !== rawStart) {
      console.warn(`[/coach/students/:studentId/assignments] start=${rawStart} no era lunes, se normalizó a ${start}`);
    }
  } else {
    start = mondayOf(todayInGymTZ());
  }
  const end = addDays(start, 6);

  const assignments = await prisma.assignment.findMany({
    where: { studentId: student.id, date: { gte: new Date(`${start}T00:00:00.000Z`), lte: new Date(`${end}T00:00:00.000Z`) } },
    include: { routine: { select: { id: true, name: true, type: true } } },
  });
  const porFecha = new Map(assignments.map((a) => [toDateString(a.date), a]));

  const days: DiaAsignacionCoach[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const assignment = porFecha.get(date);
    days.push({
      date,
      esDescanso: !assignment,
      routine: assignment ? toRutinaResumen(assignment.routine) : null,
    });
  }
  res.json(days);
});

// ─────────────────────────────────────────────────────────────
// MENSAJES (chat con un alumno)
// ─────────────────────────────────────────────────────────────

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
