// Adherencia = qué porcentaje de los días asignados en un rango el alumno
// completó.
//
// A diferencia de GET /student/week (que necesita el árbol completo de
// bloques/ejercicios para mostrarle al alumno qué falta), acá solo hace
// falta el resumen. blocksDone/blocksTotal/status ya quedan cacheados en
// Session cada vez que se marca una serie (ver PUT .../sets/:setNumber en
// student.routes.ts), así que este cálculo lee eso directo en vez de volver
// a traer el árbol entero por cada asignación. La única excepción son los
// SetLog que tienen comentario: se incluyen para que el coach pueda leerlos
// desde el historial sin hacer una request adicional por sesión.

import type { Adherencia, ComentarioSerie, DetalleSerie, DiaAdherencia, EstadoSesion, Sensacion, TipoRutina } from '../types/index.js';
import { toDateString } from './dates.js';

export interface AssignmentForAdherence {
  date: Date;
  routine: { name: string; type: TipoRutina; blocksTotal: number };
  session: {
    blocksDone: number;
    blocksTotal: number;
    status: EstadoSesion;
    durationMinutes: number | null;
    sensation: Sensacion | null;
    comentarios: ComentarioSerie[];
    seriesExtra: number;
    series: DetalleSerie[];
  } | null;
}

export function computeAdherence(assignments: AssignmentForAdherence[], start: string, end: string): Adherencia {
  const days: DiaAdherencia[] = assignments.map((assignment) => {
    // Sin Session: nadie tocó ese día todavía. bloquesTotal sale de la
    // rutina actual (misma "verdad vacía" que summarizeBloques: 0 bloques
    // lee como completo).
    const bloquesTotal = assignment.session?.blocksTotal ?? assignment.routine.blocksTotal;
    const bloquesCompletos = assignment.session?.blocksDone ?? 0;
    const completo = assignment.session ? assignment.session.status === 'COMPLETO' : bloquesTotal === 0;

    return {
      date: toDateString(assignment.date),
      completo,
      routineName: assignment.routine.name,
      bloquesCompletos,
      bloquesTotal,
      durationMinutes: assignment.session?.durationMinutes ?? null,
      sensation: assignment.session?.sensation ?? null,
      estado: assignment.session?.status ?? 'SIN_HACER',
      comentarios: assignment.session?.comentarios ?? [],
      seriesExtra: assignment.session?.seriesExtra ?? 0,
      series: assignment.session?.series ?? [],
    };
  });

  const asignados = days.length;
  const completados = days.filter((d) => d.completo).length;
  const pct = asignados === 0 ? null : completados / asignados;

  return { start, end, asignados, completados, pct, days };
}
