// Merge del historial cuando el coach reasigna un día que el alumno ya empezó.
// Puro, sin Prisma: la transacción vive en coach.routes.ts.
//
// Se permite reasignar porque si Chino cambia la rutina de un día ya entrenado
// es que está con el alumno al lado decidiéndolo juntos. Lo que el alumno ya
// hizo y sigue estando en la rutina nueva se conserva; el resto se borra.
//
// El cruce va POR NOMBRE, no por exerciseId: la rutina nueva tiene sus propios
// Exercise, con ids que antes no existían (ver lib/exercises.ts).

import { normalizeExerciseName } from './exercises.js';
import type { Sensacion } from '../types/index.js';

export interface SetLogParaMerge {
  exerciseName: string;
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  repsDone: number | null;
  rpe: Sensacion | null;
  note: string | null;
}

export interface SetLogMigrado {
  exerciseId: string;
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  repsDone: number | null;
  rpe: Sensacion | null;
  note: string | null;
}

interface RutinaDestino {
  blocks: { exercises: { id: string; name: string }[] }[];
}

export interface PlanMerge {
  conservadas: SetLogMigrado[];
  borradas: number;
}

// Devuelve las series que sobreviven, ya apuntando al Exercise nuevo, y cuántas
// se pierden. El llamador borra todos los SetLog de la sesión y recrea éstos:
// re-apuntarlos de a uno puede chocar contra el @@unique(sessionId, exerciseId,
// setNumber) a mitad de camino, cuando dos ejercicios se llaman igual.
export function planMergeSetLogs(setLogs: SetLogParaMerge[], destino: RutinaDestino): PlanMerge {
  const porNombre = new Map<string, { id: string }>();
  for (const block of destino.blocks) {
    for (const exercise of block.exercises) {
      const key = normalizeExerciseName(exercise.name);
      // Si la rutina repite un nombre, gana el primero: es el mismo criterio
      // de orden que ve el alumno en pantalla.
      if (!porNombre.has(key)) porNombre.set(key, { id: exercise.id });
    }
  }

  const conservadas: SetLogMigrado[] = [];
  const ocupadas = new Set<string>();
  let borradas = 0;

  for (const log of setLogs) {
    const destinoEjercicio = porNombre.get(normalizeExerciseName(log.exerciseName));
    // Se pierde sólo si el ejercicio ya no está. Si la rutina nueva tiene
    // menos series, las restantes sobreviven como series extra: son parte del
    // trabajo real que el alumno ya hizo.
    if (!destinoEjercicio) {
      borradas += 1;
      continue;
    }
    const clave = `${destinoEjercicio.id}#${log.setNumber}`;
    if (ocupadas.has(clave)) {
      borradas += 1;
      continue;
    }
    ocupadas.add(clave);
    conservadas.push({
      exerciseId: destinoEjercicio.id,
      setNumber: log.setNumber,
      completed: log.completed,
      loadUsed: log.loadUsed,
      repsDone: log.repsDone,
      rpe: log.rpe,
      note: log.note,
    });
  }

  return { conservadas, borradas };
}
