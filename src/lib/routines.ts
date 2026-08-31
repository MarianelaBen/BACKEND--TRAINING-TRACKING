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
