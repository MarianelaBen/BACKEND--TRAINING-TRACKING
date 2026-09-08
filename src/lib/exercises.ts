// Cruce de ejercicios por nombre.
//
// Cada rutina tiene sus PROPIOS Exercise: "Press de banca" en la rutina A y
// "Press de banca" en la rutina B son dos filas distintas, con ids distintos.
// Todo lo que necesite seguir un ejercicio a lo largo del tiempo (la última
// carga que usó el alumno, el merge al reasignar un día) tiene que cruzar por
// nombre, no por exerciseId — por id no encuentra nada.

import { prisma } from './prisma.js';

// Trim + minúsculas: alcanza para que "Press de banca" y "press de banca "
// sean el mismo ejercicio, sin meterse a normalizar acentos (en la voz de
// Chino "Sentadilla búlgara" siempre se escribe igual).
export function normalizeExerciseName(name: string): string {
  return name.trim().toLowerCase();
}

// Última carga anotada por el alumno para cada uno de esos nombres, en algún
// día ANTERIOR al pedido. Una sola consulta para todo el día: el alternativo
// era un endpoint por ejercicio, y eso son N requests desde el gimnasio con
// mal wifi.
//
// Devuelve un Map de nombre normalizado -> carga. Los nombres que el alumno
// nunca hizo (o hizo sin anotar carga) simplemente no están en el Map.
export async function fetchUltimaCargaPorNombre(
  studentId: string,
  date: Date,
  names: string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();

  const logs = await prisma.setLog.findMany({
    where: {
      completed: true,
      loadUsed: { not: null },
      exercise: { name: { in: names } },
      session: { studentId, date: { lt: date } },
    },
    select: {
      loadUsed: true,
      exercise: { select: { name: true } },
      session: { select: { date: true } },
    },
    // Del día más reciente al más viejo: la primera aparición de cada nombre
    // en este orden es, por definición, la última carga.
    orderBy: [{ session: { date: 'desc' } }, { setNumber: 'desc' }],
  });

  const ultimaCarga = new Map<string, string>();
  for (const log of logs) {
    const key = normalizeExerciseName(log.exercise.name);
    if (!ultimaCarga.has(key) && log.loadUsed !== null) {
      ultimaCarga.set(key, log.loadUsed);
    }
  }
  return ultimaCarga;
}
