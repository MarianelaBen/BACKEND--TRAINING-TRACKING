import { Router } from 'express';
import type { Sensacion } from '../types/index.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { addDays, mondayOf, parseDateParam, toDateString, todayInGymTZ } from '../lib/dates.js';
import { computeBloquesDia, computeEmpezado, summarizeBloques } from '../lib/progress.js';
import type { OverrideInput } from '../lib/progress.js';
import { countUnread, fetchThreadAndMarkRead, sendMessage } from '../lib/messages.js';
import { routineWithBlocksInclude, toRutinaResumen } from '../lib/routines.js';
import { fetchUltimaCargaPorNombre } from '../lib/exercises.js';
import { toMarca } from '../lib/marcas.js';
import { computeAdherence } from '../lib/adherence.js';
import type { AssignmentForAdherence } from '../lib/adherence.js';
import type { AlumnoFicha, DiaDetalle, DiaSemana, EstadoSesion, SemanaAlumno, TipoRutina } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      studentProfileId?: string;
    }
  }
}

export const studentRouter = Router();

// GET /week y GET /days/:date son de sólo lectura: "completado" siempre se
// recalcula desde SetLog, nunca desde los campos cacheados
// Session.blocksDone/blocksTotal/status (esos los escribe el PUT de marcar
// series, más abajo, y son sólo una caché para lecturas agregadas futuras
// del lado coach — nunca la fuente de verdad).
const rutinaConBloques = routineWithBlocksInclude;

// Los valores personalizados del día (peso, repeticiones o tiempo que Chino le
// puso a ESTE alumno para ESTA fecha) pisan a los de la rutina. La resolución
// vive en computeBloquesDia; acá sólo se arma el índice por ejercicio.
function indexarOverrides(
  overrides: { exerciseId: string; reps: string | null; durationSeconds: number | null; load: string | null }[],
): Map<string, OverrideInput> {
  return new Map(
    overrides.map((o) => [o.exerciseId, { reps: o.reps, durationSeconds: o.durationSeconds, load: o.load }]),
  );
}

studentRouter.use(requireAuth, requireRole('STUDENT'), async (req, res, next) => {
  const profile = await prisma.studentProfile.findUnique({
    where: { userId: req.auth!.userId },
    select: { id: true },
  });
  if (!profile) {
    res.status(404).json({ error: 'Perfil de alumno no encontrado' });
    return;
  }
  req.studentProfileId = profile.id;
  next();
});

// Espejo de GET /coach/students/:studentId (misma forma, AlumnoFicha):
// plan, suscripción y marcas propias. El alumno sólo puede ver las suyas,
// así que no hace falta resolver ownership como del lado coach.
studentRouter.get('/me', async (req, res) => {
  const profile = await prisma.studentProfile.findUnique({
    where: { id: req.studentProfileId! },
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

const MAX_ADHERENCE_DAYS = 180;

// Espejo de GET /coach/students/:studentId/adherence: mismo parseo de
// start/end (default = últimos 28 días) y mismo computeAdherence, pero sin
// resolver ownership -- el alumno sólo puede ver la suya.
studentRouter.get('/adherence', async (req, res) => {
  const studentId = req.studentProfileId!;
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

  const rows = await prisma.assignment.findMany({
    where: {
      studentId,
      date: { gte: new Date(`${start}T00:00:00.000Z`), lte: new Date(`${end}T00:00:00.000Z`) },
    },
    select: {
      date: true,
      routine: {
        select: { name: true, type: true, _count: { select: { blocks: true } } },
      },
      session: {
        select: { blocksDone: true, blocksTotal: true, status: true, durationMinutes: true, sensation: true },
      },
    },
    orderBy: { date: 'asc' },
  });

  const assignments: AssignmentForAdherence[] = rows.map((r) => ({
    date: r.date,
    routine: { name: r.routine.name, type: r.routine.type as TipoRutina, blocksTotal: r.routine._count.blocks },
    session: r.session
      ? {
          blocksDone: r.session.blocksDone,
          blocksTotal: r.session.blocksTotal,
          status: r.session.status as EstadoSesion,
          durationMinutes: r.session.durationMinutes,
          sensation: r.session.sensation as Sensacion | null,
        }
      : null,
  }));

  res.json(computeAdherence(assignments, start, end));
});

studentRouter.get('/week', async (req, res) => {
  const studentId = req.studentProfileId!;
  const rawStart = req.query.start;

  let start: string;
  if (typeof rawStart === 'string') {
    const parsed = parseDateParam(rawStart);
    if (!parsed) {
      res.status(400).json({ error: 'start tiene que tener el formato YYYY-MM-DD' });
      return;
    }
    start = mondayOf(rawStart);
    if (start !== rawStart) {
      console.warn(`[/student/week] start=${rawStart} no era lunes, se normalizó a ${start}`);
    }
  } else {
    start = mondayOf(todayInGymTZ());
  }
  const end = addDays(start, 6);

  const assignments = await prisma.assignment.findMany({
    where: {
      studentId,
      date: { gte: new Date(`${start}T00:00:00.000Z`), lte: new Date(`${end}T00:00:00.000Z`) },
    },
    include: {
      routine: { include: rutinaConBloques },
      session: { include: { setLogs: true } },
    },
  });

  const porFecha = new Map(assignments.map((a) => [toDateString(a.date), a]));

  const days: DiaSemana[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const assignment = porFecha.get(date);
    if (!assignment) {
      days.push({ date, esDescanso: true, completo: false, rutina: null });
      continue;
    }
    const bloques = computeBloquesDia(assignment.routine, assignment.session);
    days.push({
      date,
      esDescanso: false,
      completo: summarizeBloques(bloques).completo,
      rutina: toRutinaResumen(assignment.routine),
    });
  }

  const body: SemanaAlumno = { start, end, days };
  res.json(body);
});

studentRouter.get('/days/:date', async (req, res) => {
  const studentId = req.studentProfileId!;
  const date = parseDateParam(req.params.date);
  if (!date) {
    res.status(400).json({ error: 'date tiene que tener el formato YYYY-MM-DD' });
    return;
  }
  const dateStr = toDateString(date);
  const esHoy = dateStr === todayInGymTZ();

  const assignment = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId, date } },
    include: {
      routine: { include: rutinaConBloques },
      session: { include: { setLogs: true } },
      exerciseOverrides: true,
    },
  });

  if (!assignment) {
    const body: DiaDetalle = {
      date: dateStr,
      esDescanso: true,
      esHoy,
      empezado: false,
      rutina: null,
      bloques: [],
      bloquesCompletos: 0,
      bloquesTotal: 0,
      completo: false,
      durationMinutes: null,
      sensation: null,
    };
    res.json(body);
    return;
  }

  const nombres = assignment.routine.blocks.flatMap((b) => b.exercises.map((e) => e.name));
  const ultimaCarga = await fetchUltimaCargaPorNombre(studentId, date, nombres);

  const bloques = computeBloquesDia(
    assignment.routine,
    assignment.session,
    ultimaCarga,
    indexarOverrides(assignment.exerciseOverrides),
  );
  const { bloquesCompletos, bloquesTotal, completo } = summarizeBloques(bloques);

  const body: DiaDetalle = {
    date: dateStr,
    esDescanso: false,
    esHoy,
    empezado: computeEmpezado(assignment.session),
    rutina: { id: assignment.routine.id, name: assignment.routine.name, type: assignment.routine.type },
    bloques,
    bloquesCompletos,
    bloquesTotal,
    completo,
    durationMinutes: assignment.session?.durationMinutes ?? null,
    sensation: assignment.session?.sensation ?? null,
  };
  res.json(body);
});

const SENSACIONES: Sensacion[] = ['FACIL', 'JUSTA', 'AL_LIMITE', 'NO_PUDE'];

// Tope de repeticiones por serie: no hay ejercicio real de 3 dígitos, así que
// arriba de esto es un dedazo, no un dato.
const MAX_REPS_DONE = 100;

// Idempotente: el cliente manda el setNumber exacto (ya lo tiene, GET /days/:date
// expone cada slot numerado en setsEstado), así un reintento de red no duplica
// una marca. Por ahora sólo acepta completed:true — desmarcar no existe en el
// mock, aunque el diseño de PUT no lo descarta a futuro.
studentRouter.put('/days/:date/exercises/:exerciseId/sets/:setNumber', async (req, res) => {
  const studentId = req.studentProfileId!;

  const date = parseDateParam(req.params.date);
  if (!date) {
    res.status(400).json({ error: 'date tiene que tener el formato YYYY-MM-DD' });
    return;
  }

  if (!/^[1-9]\d*$/.test(req.params.setNumber)) {
    res.status(400).json({ error: 'setNumber tiene que ser un entero positivo' });
    return;
  }
  const setNumber = Number(req.params.setNumber);

  const { completed, loadUsed, repsDone, rpe } = req.body ?? {};
  if (completed !== true) {
    res.status(400).json({ error: 'Por ahora sólo se puede marcar una serie como completada (completed: true)' });
    return;
  }
  if (rpe !== undefined && (typeof rpe !== 'string' || !SENSACIONES.includes(rpe as Sensacion))) {
    res.status(400).json({ error: 'rpe inválido' });
    return;
  }
  if (loadUsed !== undefined && loadUsed !== null && typeof loadUsed !== 'string') {
    res.status(400).json({ error: 'loadUsed inválido' });
    return;
  }
  // Opcional, igual que loadUsed: si el alumno no lo anota, la serie se marca
  // lo mismo y repsDone queda null.
  if (repsDone !== undefined && repsDone !== null) {
    if (!Number.isInteger(repsDone) || repsDone < 0 || repsDone > MAX_REPS_DONE) {
      res.status(400).json({ error: `repsDone tiene que ser un entero entre 0 y ${MAX_REPS_DONE}` });
      return;
    }
  }

  const exerciseId = req.params.exerciseId;

  // Lectura previa, fuera de la transacción — todavía no muta nada.
  const assignment = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId, date } },
    include: { routine: { include: rutinaConBloques }, exerciseOverrides: true },
  });
  if (!assignment) {
    res.status(404).json({ error: 'No tenés una rutina asignada este día' });
    return;
  }
  const overrides = indexarOverrides(assignment.exerciseOverrides);

  const exercise = assignment.routine.blocks.flatMap((b) => b.exercises).find((e) => e.id === exerciseId);
  if (!exercise) {
    res.status(404).json({ error: 'Ese ejercicio no pertenece a la rutina de este día' });
    return;
  }
  if (setNumber > exercise.sets) {
    res.status(400).json({ error: `Esta rutina tiene ${exercise.sets} series para este ejercicio` });
    return;
  }

  const loadUsedFinal: string | null = loadUsed ?? null;
  const repsDoneFinal: number | null = repsDone ?? null;
  const rpeFinal: Sensacion | null = rpe ?? null;

  const nombres = assignment.routine.blocks.flatMap((b) => b.exercises.map((e) => e.name));
  const ultimaCarga = await fetchUltimaCargaPorNombre(studentId, date, nombres);

  const { bloques, bloquesCompletos, bloquesTotal, completo, durationMinutes, sensation } = await prisma.$transaction(async (tx) => {
    const session = await tx.session.upsert({
      where: { assignmentId: assignment.id },
      create: { studentId, routineId: assignment.routineId, assignmentId: assignment.id, date: assignment.date },
      update: {},
    });

    await tx.setLog.upsert({
      where: { sessionId_exerciseId_setNumber: { sessionId: session.id, exerciseId, setNumber } },
      create: { sessionId: session.id, exerciseId, setNumber, completed: true, loadUsed: loadUsedFinal, repsDone: repsDoneFinal, rpe: rpeFinal },
      update: { completed: true, loadUsed: loadUsedFinal, repsDone: repsDoneFinal, rpe: rpeFinal },
    });

    const setLogs = await tx.setLog.findMany({ where: { sessionId: session.id } });
    const bloques = computeBloquesDia(assignment.routine, { setLogs }, ultimaCarga, overrides);
    const resumen = summarizeBloques(bloques);

    await tx.session.update({
      where: { id: session.id },
      data: {
        blocksDone: resumen.bloquesCompletos,
        blocksTotal: resumen.bloquesTotal,
        status: resumen.completo ? 'COMPLETO' : 'A_MEDIAS',
      },
    });

    return { bloques, ...resumen, durationMinutes: session.durationMinutes, sensation: session.sensation };
  });

  const dateStr = toDateString(date);
  const body: DiaDetalle = {
    date: dateStr,
    esDescanso: false,
    esHoy: dateStr === todayInGymTZ(),
    empezado: true, // recién marcamos una serie, siempre true acá
    rutina: { id: assignment.routine.id, name: assignment.routine.name, type: assignment.routine.type },
    bloques,
    bloquesCompletos,
    bloquesTotal,
    completo,
    durationMinutes,
    sensation,
  };
  res.json(body);
});

// Cierra el entrenamiento del día con duración/sensación. No toca bloques ni
// status (eso lo calcula sólo el PUT de arriba, a partir de SetLog); requiere
// que ya exista una Session, es decir que el alumno haya marcado al menos una
// serie (mismo criterio que computeEmpezado).
studentRouter.put('/days/:date/finish', async (req, res) => {
  const studentId = req.studentProfileId!;

  const date = parseDateParam(req.params.date);
  if (!date) {
    res.status(400).json({ error: 'date tiene que tener el formato YYYY-MM-DD' });
    return;
  }

  const { durationMinutes, sensation } = req.body ?? {};
  const data: { durationMinutes?: number; sensation?: Sensacion } = {};

  if (durationMinutes !== undefined) {
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      res.status(400).json({ error: 'durationMinutes tiene que ser un entero positivo' });
      return;
    }
    data.durationMinutes = durationMinutes;
  }
  if (sensation !== undefined) {
    if (typeof sensation !== 'string' || !SENSACIONES.includes(sensation as Sensacion)) {
      res.status(400).json({ error: 'sensation inválida' });
      return;
    }
    data.sensation = sensation as Sensacion;
  }
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Mandá al menos durationMinutes o sensation' });
    return;
  }

  const assignment = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId, date } },
    include: {
      routine: { include: rutinaConBloques },
      session: { include: { setLogs: true } },
      exerciseOverrides: true,
    },
  });
  if (!assignment) {
    res.status(404).json({ error: 'No tenés una rutina asignada este día' });
    return;
  }
  if (!assignment.session) {
    res.status(404).json({ error: 'Todavía no marcaste ninguna serie este día' });
    return;
  }

  const session = await prisma.session.update({
    where: { id: assignment.session.id },
    data,
    include: { setLogs: true },
  });

  const nombres = assignment.routine.blocks.flatMap((b) => b.exercises.map((e) => e.name));
  const ultimaCarga = await fetchUltimaCargaPorNombre(studentId, date, nombres);

  const bloques = computeBloquesDia(
    assignment.routine,
    session,
    ultimaCarga,
    indexarOverrides(assignment.exerciseOverrides),
  );
  const { bloquesCompletos, bloquesTotal, completo } = summarizeBloques(bloques);
  const dateStr = toDateString(date);

  const body: DiaDetalle = {
    date: dateStr,
    esDescanso: false,
    esHoy: dateStr === todayInGymTZ(),
    empezado: true,
    rutina: { id: assignment.routine.id, name: assignment.routine.name, type: assignment.routine.type },
    bloques,
    bloquesCompletos,
    bloquesTotal,
    completo,
    durationMinutes: session.durationMinutes,
    sensation: session.sensation,
  };
  res.json(body);
});

const MAX_MENSAJE = 2000;

// Hilo único con el coach asignado. Abrir el hilo marca como leídos los
// mensajes del coach (efecto de "ya lo vi"); para el puntito de la tab bar
// sin gastar ese efecto está /messages/unread-count más abajo.
studentRouter.get('/messages', async (req, res) => {
  const messages = await fetchThreadAndMarkRead(req.studentProfileId!, req.auth!.userId);
  res.json(messages);
});

studentRouter.get('/messages/unread-count', async (req, res) => {
  const count = await countUnread(req.studentProfileId!, req.auth!.userId);
  res.json({ count });
});

studentRouter.post('/messages', async (req, res) => {
  const { body } = req.body ?? {};
  if (typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'body es obligatorio' });
    return;
  }
  if (body.length > MAX_MENSAJE) {
    res.status(400).json({ error: `El mensaje es demasiado largo (máximo ${MAX_MENSAJE} caracteres)` });
    return;
  }

  const profile = await prisma.studentProfile.findUnique({
    where: { id: req.studentProfileId! },
    select: { coachId: true },
  });
  if (!profile?.coachId) {
    res.status(409).json({ error: 'Todavía no tenés un coach asignado' });
    return;
  }

  const message = await sendMessage(req.studentProfileId!, req.auth!.userId, body.trim());
  res.status(201).json(message);
});
