import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { countUnread, fetchThreadAndMarkRead, sendMessage } from '../lib/messages.js';
import { addDays, mondayOf, parseDateParam, toDateString, todayInGymTZ } from '../lib/dates.js';
import { routineWithBlocksInclude, toRutina, toRutinaResumen } from '../lib/routines.js';
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
  if (!Array.isArray(blocks) || blocks.length === 0) {
    res.status(400).json({ error: 'blocks tiene que ser un array con al menos un bloque' });
    return;
  }

  const blocksData: Array<{
    letter: string;
    name: string;
    mode: string | null;
    estMinutes: number;
    note: string | null;
    orderIndex: number;
    exercises: {
      create: Array<{ name: string; sets: number; reps: string; load: string | null; restSeconds: number; orderIndex: number }>;
    };
  }> = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (typeof block?.letter !== 'string' || block.letter.trim().length === 0) {
      res.status(400).json({ error: `blocks[${i}].letter es obligatorio` });
      return;
    }
    if (typeof block?.name !== 'string' || block.name.trim().length === 0) {
      res.status(400).json({ error: `blocks[${i}].name es obligatorio` });
      return;
    }
    if (block.mode !== undefined && block.mode !== null && typeof block.mode !== 'string') {
      res.status(400).json({ error: `blocks[${i}].mode inválido` });
      return;
    }
    if (block.estMinutes !== undefined && (!Number.isInteger(block.estMinutes) || block.estMinutes < 0)) {
      res.status(400).json({ error: `blocks[${i}].estMinutes tiene que ser un entero no negativo` });
      return;
    }
    if (block.note !== undefined && block.note !== null && typeof block.note !== 'string') {
      res.status(400).json({ error: `blocks[${i}].note inválido` });
      return;
    }
    if (!Array.isArray(block.exercises) || block.exercises.length === 0) {
      res.status(400).json({ error: `blocks[${i}].exercises tiene que ser un array con al menos un ejercicio` });
      return;
    }

    const exercisesData: Array<{ name: string; sets: number; reps: string; load: string | null; restSeconds: number; orderIndex: number }> = [];
    for (let j = 0; j < block.exercises.length; j++) {
      const exercise = block.exercises[j];
      if (typeof exercise?.name !== 'string' || exercise.name.trim().length === 0) {
        res.status(400).json({ error: `blocks[${i}].exercises[${j}].name es obligatorio` });
        return;
      }
      if (!Number.isInteger(exercise.sets) || exercise.sets <= 0) {
        res.status(400).json({ error: `blocks[${i}].exercises[${j}].sets tiene que ser un entero positivo` });
        return;
      }
      if (typeof exercise.reps !== 'string' || exercise.reps.trim().length === 0) {
        res.status(400).json({ error: `blocks[${i}].exercises[${j}].reps es obligatorio` });
        return;
      }
      if (exercise.load !== undefined && exercise.load !== null && typeof exercise.load !== 'string') {
        res.status(400).json({ error: `blocks[${i}].exercises[${j}].load inválido` });
        return;
      }
      if (exercise.restSeconds !== undefined && (!Number.isInteger(exercise.restSeconds) || exercise.restSeconds < 0)) {
        res.status(400).json({ error: `blocks[${i}].exercises[${j}].restSeconds tiene que ser un entero no negativo` });
        return;
      }
      exercisesData.push({
        name: exercise.name,
        sets: exercise.sets,
        reps: exercise.reps,
        load: exercise.load ?? null,
        restSeconds: exercise.restSeconds ?? 0,
        orderIndex: j,
      });
    }

    blocksData.push({
      letter: block.letter,
      name: block.name,
      mode: block.mode ?? null,
      estMinutes: block.estMinutes ?? 0,
      note: block.note ?? null,
      orderIndex: i,
      exercises: { create: exercisesData },
    });
  }

  const routine = await prisma.routine.create({
    data: { coachId: req.auth!.userId, name: name.trim(), type: type as TipoRutina, blocks: { create: blocksData } },
    include: routineWithBlocksInclude,
  });

  res.status(201).json(toRutina(routine));
});

// Sólo metadata (name/type). Editar bloques/ejercicios de una rutina existente
// (agregar, borrar, reordenar) queda fuera de esta etapa: toca sesiones/SetLog
// históricos y merece su propio diseño.
coachRouter.patch('/routines/:routineId', async (req, res) => {
  const owned = await resolveOwnedRoutine(req, res, req.params.routineId);
  if (!owned) return;

  const { name, type } = req.body ?? {};
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
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Mandá al menos name o type para actualizar' });
    return;
  }

  const routine = await prisma.routine.update({ where: { id: owned.id }, data, include: routineWithBlocksInclude });
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
