// Adherencia = qué porcentaje de los días asignados en un rango el alumno
// completó. Puro (sin Prisma): reusa la misma noción de "día completo" que
// GET /student/week (computeBloquesDia + summarizeBloques de lib/progress.ts),
// para no reimplementar esa lógica del lado coach.

import type { Adherencia, DiaAdherencia, Sensacion, TipoRutina } from '../types/index.js';
import { toDateString } from './dates.js';
import { computeBloquesDia, summarizeBloques } from './progress.js';

interface ExerciseRow {
  id: string;
  name: string;
  sets: number;
  reps: string;
  load: string | null;
  restSeconds: number;
}

interface BlockRow {
  id: string;
  letter: string;
  name: string;
  mode: string | null;
  estMinutes: number;
  note: string | null;
  exercises: ExerciseRow[];
}

interface RoutineRow {
  id: string;
  name: string;
  type: TipoRutina;
  blocks: BlockRow[];
}

interface SetLogRow {
  exerciseId: string;
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  rpe: Sensacion | null;
}

export interface AssignmentForAdherence {
  date: Date;
  routine: RoutineRow;
  session: { setLogs: SetLogRow[] } | null;
}

export function computeAdherence(assignments: AssignmentForAdherence[], start: string, end: string): Adherencia {
  const days: DiaAdherencia[] = assignments.map((assignment) => {
    const bloques = computeBloquesDia(assignment.routine, assignment.session);
    return { date: toDateString(assignment.date), completo: summarizeBloques(bloques).completo };
  });

  const asignados = days.length;
  const completados = days.filter((d) => d.completo).length;
  const pct = asignados === 0 ? null : completados / asignados;

  return { start, end, asignados, completados, pct, days };
}
