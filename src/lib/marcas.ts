// Mapper compartido entre coach.routes.ts y student.routes.ts: el coach lee
// las marcas de sus alumnos, y el alumno lee las suyas propias (GET /student/me).

import type { Marca } from '../types/index.js';

interface PersonalRecordRow {
  id: string;
  studentId: string;
  exerciseName: string;
  value: string;
  note: string | null;
  updatedAt: Date;
}

export function toMarca(record: PersonalRecordRow): Marca {
  return {
    id: record.id,
    studentId: record.studentId,
    exerciseName: record.exerciseName,
    value: record.value,
    note: record.note,
    updatedAt: record.updatedAt.toISOString(),
  };
}
