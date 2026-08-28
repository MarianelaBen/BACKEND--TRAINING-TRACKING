// Cálculo de progreso a partir de SetLog — puro, sin Prisma ni Express.
// Traducción directa de la lógica de app-alumno_1.html (exDone/bkDone/bloquesDone),
// incluida la semántica de "verdad vacía": un bloque sin ejercicios, o una
// rutina sin bloques, lee como completo (igual que [].every(Boolean) en el
// prototipo). No es un bug: la validación de eso es tarea del lado coach.

import type { BloqueDia, EjercicioDia, EstadoSet, Sensacion, TipoRutina } from '../types/index.js';

interface ExerciseInput {
  id: string;
  name: string;
  sets: number;
  reps: string;
  load: string | null;
  restSeconds: number;
}

interface BlockInput {
  id: string;
  letter: string;
  name: string;
  mode: string | null;
  estMinutes: number;
  note: string | null;
  exercises: ExerciseInput[];
}

interface RoutineInput {
  id: string;
  name: string;
  type: TipoRutina;
  blocks: BlockInput[];
}

interface SetLogInput {
  exerciseId: string;
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  rpe: Sensacion | null;
}

interface SessionInput {
  setLogs: SetLogInput[];
}

export function computeBloquesDia(routine: RoutineInput, session: SessionInput | null): BloqueDia[] {
  const setLogsPorEjercicio = new Map<string, Map<number, SetLogInput>>();
  for (const log of session?.setLogs ?? []) {
    let porSerie = setLogsPorEjercicio.get(log.exerciseId);
    if (!porSerie) {
      porSerie = new Map();
      setLogsPorEjercicio.set(log.exerciseId, porSerie);
    }
    porSerie.set(log.setNumber, log);
  }

  return routine.blocks.map((block) => {
    const exercises: EjercicioDia[] = block.exercises.map((exercise) => {
      const porSerie = setLogsPorEjercicio.get(exercise.id);
      const setsEstado: EstadoSet[] = [];
      for (let setNumber = 1; setNumber <= exercise.sets; setNumber++) {
        const log = porSerie?.get(setNumber);
        setsEstado.push(
          log
            ? { setNumber, completed: log.completed, loadUsed: log.loadUsed, rpe: log.rpe }
            : { setNumber, completed: false, loadUsed: null, rpe: null },
        );
      }
      return {
        id: exercise.id,
        name: exercise.name,
        sets: exercise.sets,
        reps: exercise.reps,
        load: exercise.load,
        restSeconds: exercise.restSeconds,
        completo: setsEstado.every((s) => s.completed),
        setsEstado,
      };
    });

    return {
      id: block.id,
      letter: block.letter,
      name: block.name,
      mode: block.mode,
      estMinutes: block.estMinutes,
      note: block.note,
      completo: exercises.every((e) => e.completo),
      exercises,
    };
  });
}

export function summarizeBloques(bloques: BloqueDia[]): { bloquesCompletos: number; bloquesTotal: number; completo: boolean } {
  const bloquesTotal = bloques.length;
  const bloquesCompletos = bloques.filter((b) => b.completo).length;
  return { bloquesCompletos, bloquesTotal, completo: bloquesCompletos === bloquesTotal };
}

// "Empezado" = al menos una serie realmente marcada, no sólo que exista una
// Session — por si en la etapa 4 la Session llega a crearse al abrir el día,
// antes de marcar nada.
export function computeEmpezado(session: SessionInput | null): boolean {
  return session?.setLogs.some((log) => log.completed) ?? false;
}
