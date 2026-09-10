// Forma del include de Prisma para traer una rutina con sus bloques y
// ejercicios ordenados, y el mapeo a los tipos de la API. Compartido entre
// student.routes.ts (vista del día) y coach.routes.ts (biblioteca de rutinas).

import type { Bloque, Ejercicio, Rutina, RutinaResumen, TipoRutina } from '../types/index.js';

export const routineWithBlocksInclude = {
  blocks: {
    orderBy: { orderIndex: 'asc' as const },
    include: {
      exercises: { orderBy: { orderIndex: 'asc' as const } },
    },
  },
};

interface ExerciseRow {
  id: string;
  blockId: string;
  name: string;
  type: string | null;
  sets: number;
  reps: string | null;
  durationSeconds: number | null;
  load: string | null;
  restSeconds: number;
  orderIndex: number;
}

interface BlockRow {
  id: string;
  routineId: string;
  letter: string;
  name: string;
  mode: string | null;
  estMinutes: number;
  note: string | null;
  orderIndex: number;
  exercises: ExerciseRow[];
}

interface RoutineRow {
  id: string;
  coachId: string;
  name: string;
  type: string;
  createdAt: Date;
  blocks: BlockRow[];
}

export function toRutina(routine: RoutineRow): Rutina {
  const blocks: Bloque[] = routine.blocks.map((block) => {
    const exercises: Ejercicio[] = block.exercises.map((exercise) => ({
      id: exercise.id,
      blockId: exercise.blockId,
      name: exercise.name,
      type: exercise.type as TipoRutina | null,
      sets: exercise.sets,
      reps: exercise.reps,
      durationSeconds: exercise.durationSeconds,
      load: exercise.load,
      restSeconds: exercise.restSeconds,
      orderIndex: exercise.orderIndex,
    }));
    return {
      id: block.id,
      routineId: block.routineId,
      letter: block.letter,
      name: block.name,
      mode: block.mode,
      estMinutes: block.estMinutes,
      note: block.note,
      orderIndex: block.orderIndex,
      exercises,
    };
  });

  return {
    id: routine.id,
    coachId: routine.coachId,
    name: routine.name,
    type: routine.type as TipoRutina,
    createdAt: routine.createdAt.toISOString(),
    blocks,
  };
}

export function toRutinaResumen(routine: { id: string; name: string; type: string }): RutinaResumen {
  return { id: routine.id, name: routine.name, type: routine.type as TipoRutina };
}

export interface RoutineExerciseCreate {
  name: string;
  type: TipoRutina | null;
  sets: number;
  reps: string | null;
  durationSeconds: number | null;
  load: string | null;
  restSeconds: number;
  orderIndex: number;
}

const TIPOS_EJERCICIO: TipoRutina[] = ['FUERZA', 'METABOLICO', 'MOVILIDAD'];

// Una hora por serie ya es un dedazo, no un ejercicio.
const MAX_DURATION_SECONDS = 3600;

export interface Medida {
  reps: string | null;
  durationSeconds: number | null;
}

// La regla "repeticiones o tiempo, nunca las dos" en un solo lugar: la usan
// tanto los ejercicios de una rutina como los overrides por asignación. Los
// dos vacíos es válido (rutina genérica, valor sin definir todavía); la base
// lo garantiza además con un CHECK en cada tabla.
export function validateMedida(input: {
  reps?: unknown;
  durationSeconds?: unknown;
}): { error: string } | Medida {
  const tieneReps = input.reps !== undefined && input.reps !== null;
  const tieneDuracion = input.durationSeconds !== undefined && input.durationSeconds !== null;

  if (tieneReps && (typeof input.reps !== 'string' || input.reps.trim().length === 0)) {
    return { error: '.reps inválido' };
  }
  if (
    tieneReps &&
    ((input.reps as string).trim().startsWith('-') ||
      /^0(?:\D|$)/.test((input.reps as string).trim()) ||
      (/^\d+$/.test((input.reps as string).trim()) && Number((input.reps as string).trim()) <= 0))
  ) {
    return { error: '.reps tiene que ser mayor a cero' };
  }
  if (
    tieneDuracion &&
    (!Number.isInteger(input.durationSeconds) ||
      (input.durationSeconds as number) <= 0 ||
      (input.durationSeconds as number) > MAX_DURATION_SECONDS)
  ) {
    return { error: `.durationSeconds tiene que ser un entero entre 1 y ${MAX_DURATION_SECONDS}` };
  }
  if (tieneReps && tieneDuracion) {
    return { error: ': un ejercicio se mide por repeticiones o por tiempo, no por las dos' };
  }

  return {
    reps: tieneReps ? (input.reps as string) : null,
    durationSeconds: tieneDuracion ? (input.durationSeconds as number) : null,
  };
}

export function validateCarga(input: unknown): { error: string } | { load: string | null } {
  if (input === undefined || input === null) return { load: null };
  if (typeof input !== 'string') return { error: '.load inválido' };
  const texto = input.trim();
  if (texto.length === 0 || texto.toLowerCase() === 'sin carga') return { load: texto || null };
  if (/^-/.test(texto)) return { error: '.load tiene que ser mayor a cero' };
  const match = texto.match(/^(\d+(?:[.,]\d+)?)\s*(?:kg)?$/i);
  if (match) {
    const kg = Number(match[1]!.replace(',', '.'));
    if (kg < 0.5 || kg > 500) return { error: '.load tiene que estar entre 0,5 y 500 kg' };
  }
  return { load: texto };
}

export interface RoutineBlockCreate {
  letter: string;
  name: string;
  mode: string | null;
  estMinutes: number;
  note: string | null;
  orderIndex: number;
  exercises: { create: RoutineExerciseCreate[] };
}

// Valida el body de bloques/ejercicios anidados que mandan POST /coach/routines
// y PATCH /coach/routines/:id (al reemplazar la estructura). orderIndex se
// asigna por posición en el array, no lo manda el cliente.
export function validateBlocksInput(blocks: unknown): { error: string } | { blocks: RoutineBlockCreate[] } {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { error: 'blocks tiene que ser un array con al menos un bloque' };
  }
  // req.body es `any`, así que la forma real de cada elemento es desconocida
  // hasta que se valida campo por campo más abajo.
  const blocksInput = blocks as any[];

  const blocksData: RoutineBlockCreate[] = [];

  for (let i = 0; i < blocksInput.length; i++) {
    const block = blocksInput[i];
    if (typeof block?.letter !== 'string' || block.letter.trim().length === 0) {
      return { error: `blocks[${i}].letter es obligatorio` };
    }
    if (typeof block?.name !== 'string' || block.name.trim().length === 0) {
      return { error: `blocks[${i}].name es obligatorio` };
    }
    if (block.mode !== undefined && block.mode !== null && typeof block.mode !== 'string') {
      return { error: `blocks[${i}].mode inválido` };
    }
    if (block.estMinutes !== undefined && (!Number.isInteger(block.estMinutes) || block.estMinutes < 0)) {
      return { error: `blocks[${i}].estMinutes tiene que ser un entero no negativo` };
    }
    if (block.note !== undefined && block.note !== null && typeof block.note !== 'string') {
      return { error: `blocks[${i}].note inválido` };
    }
    if (!Array.isArray(block.exercises) || block.exercises.length === 0) {
      return { error: `blocks[${i}].exercises tiene que ser un array con al menos un ejercicio` };
    }

    const exercisesData: RoutineExerciseCreate[] = [];
    for (let j = 0; j < block.exercises.length; j++) {
      const exercise = block.exercises[j];
      if (typeof exercise?.name !== 'string' || exercise.name.trim().length === 0) {
        return { error: `blocks[${i}].exercises[${j}].name es obligatorio` };
      }
      if (
        exercise.type !== undefined &&
        exercise.type !== null &&
        (typeof exercise.type !== 'string' || !TIPOS_EJERCICIO.includes(exercise.type as TipoRutina))
      ) {
        return { error: `blocks[${i}].exercises[${j}].type tiene que ser uno de: ${TIPOS_EJERCICIO.join(', ')}` };
      }
      if (!Number.isInteger(exercise.sets) || exercise.sets <= 0) {
        return { error: `blocks[${i}].exercises[${j}].sets tiene que ser un entero positivo` };
      }
      // Repeticiones O tiempo, nunca las dos — pero pueden faltar las dos: eso
      // es una rutina genérica, que se completa al asignarla (AssignmentExercise).
      const medida = validateMedida(exercise);
      if ('error' in medida) {
        return { error: `blocks[${i}].exercises[${j}]${medida.error}` };
      }
      const carga = validateCarga(exercise.load);
      if ('error' in carga) {
        return { error: `blocks[${i}].exercises[${j}]${carga.error}` };
      }
      if (exercise.restSeconds !== undefined && (!Number.isInteger(exercise.restSeconds) || exercise.restSeconds < 0)) {
        return { error: `blocks[${i}].exercises[${j}].restSeconds tiene que ser un entero no negativo` };
      }
      exercisesData.push({
        name: exercise.name,
        type: (exercise.type ?? null) as TipoRutina | null,
        sets: exercise.sets,
        reps: medida.reps,
        durationSeconds: medida.durationSeconds,
        load: carga.load,
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

  return { blocks: blocksData };
}
