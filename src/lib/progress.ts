// Cálculo de progreso a partir de SetLog — puro, sin Prisma ni Express.
// Traducción directa de la lógica de app-alumno_1.html (exDone/bkDone/bloquesDone),
// incluida la semántica de "verdad vacía": un bloque sin ejercicios, o una
// rutina sin bloques, lee como completo (igual que [].every(Boolean) en el
// prototipo). No es un bug: la validación de eso es tarea del lado coach.

import type { BloqueDia, EjercicioDia, EstadoSet, Sensacion, TipoRutina } from '../types/index.js';
import { normalizeExerciseName } from './exercises.js';

interface ExerciseInput {
  id: string;
  name: string;
  type: TipoRutina | null;
  sets: number;
  reps: string | null;
  durationSeconds: number | null;
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
  repsDone: number | null;
  rpe: Sensacion | null;
}

interface SessionInput {
  setLogs: SetLogInput[];
}

// Valores personalizados de un ejercicio para el día concreto que se está
// mirando (AssignmentExercise). Ver resolveMedida más abajo.
export interface OverrideInput {
  reps: string | null;
  durationSeconds: number | null;
  load: string | null;
}

// Cuál gana entre el valor de la rutina y el del día. La medida (reps/tiempo)
// se resuelve EN BLOQUE, no campo por campo: si el override dice "45 segundos"
// y la rutina decía "8 repeticiones", mezclarlos dejaría el ejercicio con las
// dos cosas, que es justo lo que no puede pasar. load sí cae por separado.
function resolveEjercicio(exercise: ExerciseInput, override: OverrideInput | undefined) {
  const defineMedida = override !== undefined && (override.reps !== null || override.durationSeconds !== null);
  return {
    reps: defineMedida ? override.reps : exercise.reps,
    durationSeconds: defineMedida ? override.durationSeconds : exercise.durationSeconds,
    load: override?.load ?? exercise.load,
  };
}

// ultimaCargaPorNombre: nombre de ejercicio normalizado -> última carga que el
// alumno usó en un día anterior. La consulta vive en lib/exercises.ts; acá sólo
// se lee, para que este módulo siga siendo puro. Si no se pasa, ultimaCarga
// queda en null (es el caso de /week, que no la necesita).
//
// overridesPorEjercicio: exerciseId -> valores personalizados de ese día.
export function computeBloquesDia(
  routine: RoutineInput,
  session: SessionInput | null,
  ultimaCargaPorNombre?: Map<string, string>,
  overridesPorEjercicio?: Map<string, OverrideInput>,
): BloqueDia[] {
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
            ? { setNumber, completed: log.completed, loadUsed: log.loadUsed, repsDone: log.repsDone, rpe: log.rpe }
            : { setNumber, completed: false, loadUsed: null, repsDone: null, rpe: null },
        );
      }
      const { reps, durationSeconds, load } = resolveEjercicio(exercise, overridesPorEjercicio?.get(exercise.id));
      return {
        id: exercise.id,
        name: exercise.name,
        type: exercise.type,
        sets: exercise.sets,
        reps,
        durationSeconds,
        load,
        ultimaCarga: ultimaCargaPorNombre?.get(normalizeExerciseName(exercise.name)) ?? null,
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
