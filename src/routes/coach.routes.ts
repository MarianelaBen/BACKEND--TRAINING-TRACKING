import type { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { countUnread, fetchThreadAndMarkRead, sendMessage } from '../lib/messages.js';
import { addDays, mondayOf, parseDateParam, toDateString, todayInGymTZ } from '../lib/dates.js';
import type { RoutineBlockCreate } from '../lib/routines.js';
import { routineWithBlocksInclude, toRutina, toRutinaResumen, validateBlocksInput, validateMedida } from '../lib/routines.js';
import { computeAdherence } from '../lib/adherence.js';
import { computeBloquesDia, summarizeBloques } from '../lib/progress.js';
import { planMergeSetLogs } from '../lib/reassign.js';
import type { AssignmentForAdherence } from '../lib/adherence.js';
import { toMarca } from '../lib/marcas.js';
import type {
  AlumnoFicha,
  AlumnoResumen,
  Asignacion,
  DiaAsignacionCoach,
  EstadoSesion,
  OverrideEjercicio,
  RutinaListado,
  Sensacion,
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

  const rows = await prisma.assignment.findMany({
    where: {
      studentId: student.id,
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
    const validated = validateBlocksInput(blocks);
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    blocksData = validated.blocks;

    const [assignmentCount, sessionCount] = await Promise.all([
      prisma.assignment.count({ where: { routineId: owned.id } }),
      prisma.session.count({ where: { routineId: owned.id } }),
    ]);
    if (assignmentCount > 0 || sessionCount > 0) {
      const current = await prisma.routine.findUnique({
        where: { id: owned.id },
        include: routineWithBlocksInclude,
      });
      const mismaEstructura =
        current !== null &&
        current.blocks.length === blocksData.length &&
        current.blocks.every((block, blockIndex) => {
          const nextBlock = blocksData![blockIndex];
          const nextExercises = nextBlock?.exercises.create ?? [];
          return (
            nextBlock !== undefined &&
            block.letter === nextBlock.letter &&
            block.name === nextBlock.name &&
            block.mode === nextBlock.mode &&
            block.estMinutes === nextBlock.estMinutes &&
            block.note === nextBlock.note &&
            block.exercises.length === nextExercises.length &&
            block.exercises.every((exercise, exerciseIndex) => {
              const nextExercise = nextExercises[exerciseIndex];
              return (
                nextExercise !== undefined &&
                exercise.name === nextExercise.name &&
                exercise.sets === nextExercise.sets &&
                exercise.reps === nextExercise.reps &&
                exercise.durationSeconds === nextExercise.durationSeconds &&
                exercise.restSeconds === nextExercise.restSeconds
              );
            })
          );
        });

      if (!mismaEstructura) {
        res.status(409).json({ error: 'No se puede editar la estructura: la rutina ya tiene asignaciones o sesiones asociadas. Sólo podés modificar las cargas y el tipo de trabajo.' });
        return;
      }

      // Carga y tipo de trabajo no cambian la estructura (no mueven series ni
      // ejercicios), así que se pueden editar aunque la rutina ya esté en uso:
      // el historial ya marcado sigue apuntando a los mismos Exercise.
      const editablesUpdates = current.blocks.flatMap((block, blockIndex) =>
        block.exercises.map((exercise, exerciseIndex) => {
          const siguiente = blocksData![blockIndex]!.exercises.create[exerciseIndex]!;
          return prisma.exercise.update({
            where: { id: exercise.id },
            data: { load: siguiente.load, type: siguiente.type },
          });
        }),
      );
      await prisma.$transaction([
        ...editablesUpdates,
        prisma.routine.update({ where: { id: owned.id }, data }),
      ]);
      const updated = await prisma.routine.findUnique({
        where: { id: owned.id },
        include: routineWithBlocksInclude,
      });
      res.json(toRutina(updated!));
      return;
    }
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

// Ids de los ejercicios de una rutina, para validar que un override apunte a
// un ejercicio que realmente está en la rutina que se asignó ese día.
async function ejerciciosDeLaRutina(routineId: string): Promise<Set<string>> {
  const exercises = await prisma.exercise.findMany({
    where: { block: { routineId } },
    select: { id: true },
  });
  return new Set(exercises.map((e) => e.id));
}

// Reemplaza los valores personalizados de una asignación. Si cambió la rutina
// hay que limpiarlos aunque no vengan nuevos: los viejos apuntan a los
// ejercicios de la rutina anterior, que ya no se muestran.
async function aplicarOverrides(
  tx: Prisma.TransactionClient,
  assignmentId: string,
  overrides: OverrideEjercicio[] | undefined,
  routineCambio: boolean,
): Promise<void> {
  if (overrides === undefined && !routineCambio) return;

  await tx.assignmentExercise.deleteMany({ where: { assignmentId } });
  if (overrides && overrides.length > 0) {
    await tx.assignmentExercise.createMany({ data: overrides.map((o) => ({ ...o, assignmentId })) });
  }
}

// Valida el array `overrides` que puede venir en POST .../assignments, para
// asignar y personalizar en una sola request.
function validateOverridesInput(
  raw: unknown,
  idsValidos: Set<string>,
): { error: string } | { overrides: OverrideEjercicio[] } {
  if (!Array.isArray(raw)) {
    return { error: 'overrides tiene que ser un array' };
  }
  const overrides: OverrideEjercicio[] = [];
  const vistos = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as { exerciseId?: unknown; load?: unknown; reps?: unknown; durationSeconds?: unknown };
    if (typeof item?.exerciseId !== 'string' || !idsValidos.has(item.exerciseId)) {
      return { error: `overrides[${i}].exerciseId no es un ejercicio de esta rutina` };
    }
    if (vistos.has(item.exerciseId)) {
      return { error: `overrides[${i}].exerciseId está repetido` };
    }
    vistos.add(item.exerciseId);

    if (item.load !== undefined && item.load !== null && typeof item.load !== 'string') {
      return { error: `overrides[${i}].load inválido` };
    }
    const medida = validateMedida(item);
    if ('error' in medida) {
      return { error: `overrides[${i}]${medida.error}` };
    }

    overrides.push({
      exerciseId: item.exerciseId,
      reps: medida.reps,
      durationSeconds: medida.durationSeconds,
      load: (item.load ?? null) as string | null,
    });
  }

  return { overrides };
}

coachRouter.post('/students/:studentId/assignments', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const { routineId, date: rawDate, overrides: rawOverrides } = req.body ?? {};
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

  // Personalizar los ejercicios en la misma request que asigna la rutina, así
  // el coach no tiene que hacer un PUT por ejercicio después.
  let overrides: OverrideEjercicio[] | undefined;
  if (rawOverrides !== undefined) {
    const validated = validateOverridesInput(rawOverrides, await ejerciciosDeLaRutina(routine.id));
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    overrides = validated.overrides;
  }

  const existing = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId: student.id, date } },
    include: { session: { select: { id: true } } },
  });

  // Camino simple: el día no tiene historial, se pisa la asignación y listo.
  if (!existing?.session) {
    const assignment = await prisma.$transaction(async (tx) => {
      const creada = await tx.assignment.upsert({
        where: { studentId_date: { studentId: student.id, date } },
        create: { studentId: student.id, routineId: routine.id, date },
        update: { routineId: routine.id },
      });
      await aplicarOverrides(tx, creada.id, overrides, existing !== null && existing.routineId !== routine.id);
      return creada;
    });

    const body: Asignacion = {
      id: assignment.id,
      studentId: assignment.studentId,
      routineId: assignment.routineId,
      date: toDateString(assignment.date),
      routine: toRutinaResumen(routine),
    };
    res.status(existing ? 200 : 201).json(body);
    return;
  }

  // El día ya tiene series marcadas. Antes esto era un 409; ahora se reasigna y
  // se hace el merge del historial: lo que el alumno ya hizo y sigue estando en
  // la rutina nueva queda marcado, el resto se pierde. El front avisa con una
  // alerta antes de llegar acá, y la respuesta dice qué pasó.
  const sessionId = existing.session.id;
  const destino = await prisma.routine.findUnique({
    where: { id: routine.id },
    include: routineWithBlocksInclude,
  });

  const previos = await prisma.setLog.findMany({
    where: { sessionId },
    include: { exercise: { select: { name: true } } },
    orderBy: { setNumber: 'asc' },
  });

  const { conservadas, borradas } = planMergeSetLogs(
    previos.map((log) => ({
      exerciseName: log.exercise.name,
      setNumber: log.setNumber,
      completed: log.completed,
      loadUsed: log.loadUsed,
      repsDone: log.repsDone,
      rpe: log.rpe,
    })),
    destino!,
  );

  // Se borra todo y se recrea lo que sobrevive: re-apuntar los SetLog de a uno
  // puede chocar contra el @@unique(sessionId, exerciseId, setNumber) a mitad
  // de camino. Los ids de SetLog cambian, pero no los usa nadie afuera.
  const resumen = summarizeBloques(computeBloquesDia(destino!, { setLogs: conservadas }));

  const assignment = await prisma.$transaction(async (tx) => {
    await tx.setLog.deleteMany({ where: { sessionId } });
    if (conservadas.length > 0) {
      await tx.setLog.createMany({ data: conservadas.map((s) => ({ ...s, sessionId })) });
    }
    // La Session también apunta a la rutina, y blocksDone/blocksTotal/status
    // quedan cacheados ahí: sin recalcularlos, la adherencia miente.
    await tx.session.update({
      where: { id: sessionId },
      data: {
        routineId: routine.id,
        blocksDone: resumen.bloquesCompletos,
        blocksTotal: resumen.bloquesTotal,
        status: conservadas.length === 0 ? 'SIN_HACER' : resumen.completo ? 'COMPLETO' : 'A_MEDIAS',
      },
    });
    const actualizada = await tx.assignment.update({ where: { id: existing.id }, data: { routineId: routine.id } });
    await aplicarOverrides(tx, actualizada.id, overrides, existing.routineId !== routine.id);
    return actualizada;
  });

  const body: Asignacion = {
    id: assignment.id,
    studentId: assignment.studentId,
    routineId: assignment.routineId,
    date: toDateString(assignment.date),
    routine: toRutinaResumen(routine),
    merge: { conservadas: conservadas.length, borradas },
  };
  res.json(body);
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

  // Desasignar un día ya entrenado se permite (antes era 409): borra la sesión
  // y con ella el historial de ese día. Los SetLog se van solos por el
  // onDelete: Cascade de Session. El front avisa antes de llegar acá.
  await prisma.$transaction(async (tx) => {
    if (assignment.session) {
      await tx.session.delete({ where: { id: assignment.session.id } });
    }
    await tx.assignment.delete({ where: { id: assignment.id } });
  });
  res.status(204).end();
});

// Personaliza UN ejercicio para ESTE alumno en ESTE día: el peso, y las
// repeticiones o el tiempo. Es lo que hace que una rutina genérica sirva para
// todos sin que cambiarle la carga a un alumno se la cambie a los demás.
//
// Es un PUT del override completo, no un PATCH: lo que no venga en el body
// queda en null y el ejercicio vuelve a mostrar el valor sugerido de la rutina.
coachRouter.put('/students/:studentId/assignments/:date/exercises/:exerciseId', async (req, res) => {
  const student = await resolveOwnedStudent(req, res);
  if (!student) return;

  const date = parseDateParam(req.params.date);
  if (!date) {
    res.status(400).json({ error: 'date tiene que tener el formato YYYY-MM-DD' });
    return;
  }

  const assignment = await prisma.assignment.findUnique({
    where: { studentId_date: { studentId: student.id, date } },
    select: { id: true, routineId: true },
  });
  if (!assignment) {
    res.status(404).json({ error: 'No hay una asignación ese día' });
    return;
  }

  const exerciseId = req.params.exerciseId;
  const idsValidos = await ejerciciosDeLaRutina(assignment.routineId);
  if (!idsValidos.has(exerciseId)) {
    res.status(404).json({ error: 'Ese ejercicio no pertenece a la rutina de ese día' });
    return;
  }

  const { load } = req.body ?? {};
  if (load !== undefined && load !== null && typeof load !== 'string') {
    res.status(400).json({ error: 'load inválido' });
    return;
  }
  const medida = validateMedida(req.body ?? {});
  if ('error' in medida) {
    res.status(400).json({ error: `El ejercicio${medida.error}` });
    return;
  }

  const data = {
    reps: medida.reps,
    durationSeconds: medida.durationSeconds,
    load: (load ?? null) as string | null,
  };
  const override = await prisma.assignmentExercise.upsert({
    where: { assignmentId_exerciseId: { assignmentId: assignment.id, exerciseId } },
    create: { assignmentId: assignment.id, exerciseId, ...data },
    update: data,
  });

  const body: OverrideEjercicio = {
    exerciseId: override.exerciseId,
    reps: override.reps,
    durationSeconds: override.durationSeconds,
    load: override.load,
  };
  res.json(body);
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
    include: {
      routine: { select: { id: true, name: true, type: true } },
      exerciseOverrides: true,
    },
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
      // Siempre array, nunca undefined: el front distingue "no hay nada
      // personalizado" de "este backend todavía no manda el campo".
      overrides:
        assignment?.exerciseOverrides.map((o) => ({
          exerciseId: o.exerciseId,
          reps: o.reps,
          durationSeconds: o.durationSeconds,
          load: o.load,
        })) ?? [],
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
