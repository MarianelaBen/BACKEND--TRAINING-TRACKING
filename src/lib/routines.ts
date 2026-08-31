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
  sets: number;
  reps: string;
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
      sets: exercise.sets,
      reps: exercise.reps,
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
  sets: number;
  reps: string;
  load: string | null;
  restSeconds: number;
  orderIndex: number;
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
      if (!Number.isInteger(exercise.sets) || exercise.sets <= 0) {
        return { error: `blocks[${i}].exercises[${j}].sets tiene que ser un entero positivo` };
      }
      if (typeof exercise.reps !== 'string' || exercise.reps.trim().length === 0) {
        return { error: `blocks[${i}].exercises[${j}].reps es obligatorio` };
      }
      if (exercise.load !== undefined && exercise.load !== null && typeof exercise.load !== 'string') {
        return { error: `blocks[${i}].exercises[${j}].load inválido` };
      }
      if (exercise.restSeconds !== undefined && (!Number.isInteger(exercise.restSeconds) || exercise.restSeconds < 0)) {
        return { error: `blocks[${i}].exercises[${j}].restSeconds tiene que ser un entero no negativo` };
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

  return { blocks: blocksData };
}
