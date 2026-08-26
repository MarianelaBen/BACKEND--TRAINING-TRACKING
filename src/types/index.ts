// Tipos compartidos con el front (chino-web). Mantener en sync a mano:
// cualquier cambio acá hay que reflejarlo del otro lado.
//
// Son las formas que devuelve la API (JSON), no los modelos de Prisma:
// fechas como string ISO, sin campos internos (ej. passwordHash).

export type Rol = 'COACH' | 'STUDENT';
export type TipoRutina = 'FUERZA' | 'METABOLICO' | 'MOVILIDAD';
export type Sensacion = 'FACIL' | 'JUSTA' | 'AL_LIMITE' | 'NO_PUDE';
export type EstadoSesion = 'SIN_HACER' | 'A_MEDIAS' | 'COMPLETO';

export interface Usuario {
  id: string;
  email: string;
  role: Rol;
  name: string;
  initials: string | null;
}

export interface PerfilAlumno {
  id: string;
  userId: string;
  coachId: string | null;
  plan: string | null;
  planStartDate: string | null;
  planActive: boolean;
  nextPayment: string | null;
}

export interface Ejercicio {
  id: string;
  blockId: string;
  name: string;
  sets: number;
  reps: string;
  load: string | null;
  restSeconds: number;
  orderIndex: number;
}

export interface Bloque {
  id: string;
  routineId: string;
  letter: string;
  name: string;
  mode: string | null;
  estMinutes: number;
  note: string | null;
  orderIndex: number;
  exercises: Ejercicio[];
}

export interface Rutina {
  id: string;
  coachId: string;
  name: string;
  type: TipoRutina;
  createdAt: string;
  blocks: Bloque[];
}

export interface Asignacion {
  id: string;
  studentId: string;
  routineId: string;
  date: string;
  routine?: Rutina;
}

export interface SetLog {
  id: string;
  sessionId: string;
  exerciseId: string;
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  rpe: Sensacion | null;
}

export interface Sesion {
  id: string;
  studentId: string;
  routineId: string;
  assignmentId: string | null;
  date: string;
  durationMinutes: number | null;
  sensation: Sensacion | null;
  status: EstadoSesion;
  blocksDone: number;
  blocksTotal: number;
  createdAt: string;
  setLogs: SetLog[];
}

export interface Marca {
  id: string;
  studentId: string;
  exerciseName: string;
  value: string;
  note: string | null;
  updatedAt: string;
}

export interface Mensaje {
  id: string;
  studentId: string;
  senderId: string;
  body: string;
  sentAt: string;
  readAt: string | null;
}
