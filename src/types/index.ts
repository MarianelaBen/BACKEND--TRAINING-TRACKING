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
  // Tipo de trabajo del ejercicio. null en los ejercicios cargados antes de
  // que existiera el campo — el front no puede asumir que siempre viene.
  type: TipoRutina | null;
  sets: number;
  // Un ejercicio se mide por repeticiones O por tiempo, nunca por las dos:
  // si reps viene con texto, durationSeconds es null, y al revés. Al alumno se
  // le muestra sólo el que corresponda.
  reps: string | null;
  durationSeconds: number | null;
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
  routine?: RutinaResumen;
  // Sólo cuando se reasignó un día que el alumno ya había empezado: cuántas
  // series se pudieron conservar y cuántas se perdieron, para la alerta.
  merge?: ResultadoMerge;
}

export interface ResultadoMerge {
  conservadas: number;
  borradas: number;
}

export interface SetLog {
  id: string;
  sessionId: string;
  exerciseId: string;
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  // Lo que el alumno hizo de verdad. Ejercicio.reps es el plan del coach.
  repsDone: number | null;
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

// ── Vista alumno: rutina del día / semana (etapa 3) ──────────────────
// Formas de respuesta compuestas, ajustadas a lo que realmente consumen
// las pantallas de app-alumno_1.html (semana(), vHoy(), vRutina(), vEjercicio()).
// No son un espejo 1:1 de los modelos de Prisma: por ejemplo no llevan
// orderIndex (el array ya viene ordenado) ni mode/subtítulos que no tienen
// dato real detrás.

export interface RutinaResumen {
  id: string;
  name: string;
  type: TipoRutina;
}

export interface EstadoSet {
  setNumber: number;
  completed: boolean;
  loadUsed: string | null;
  repsDone: number | null;
  rpe: Sensacion | null;
}

export interface EjercicioDia {
  id: string;
  name: string;
  type: TipoRutina | null;
  sets: number;
  // Uno de los dos, nunca los dos: ver Ejercicio.
  reps: string | null;
  durationSeconds: number | null;
  load: string | null;
  // Lo último que el alumno levantó en un ejercicio con este mismo nombre, en
  // un día anterior. null si nunca lo hizo o si nunca anotó la carga. Se
  // cruza por nombre a propósito: cada rutina tiene sus propios Exercise, así
  // que el mismo ejercicio en dos rutinas son dos filas con ids distintos.
  ultimaCarga: string | null;
  restSeconds: number;
  completo: boolean;
  setsEstado: EstadoSet[];
}

export interface BloqueDia {
  id: string;
  letter: string;
  name: string;
  mode: string | null;
  estMinutes: number;
  note: string | null;
  completo: boolean;
  exercises: EjercicioDia[];
}

export interface DiaSemana {
  date: string;
  esDescanso: boolean;
  completo: boolean;
  // Mismo shape que DiaAsignacionCoach.routine, para que el front lo reuse.
  rutina: RutinaResumen | null;
}

export interface SemanaAlumno {
  start: string;
  end: string;
  days: DiaSemana[];
}

export interface DiaDetalle {
  date: string;
  esDescanso: boolean;
  esHoy: boolean;
  empezado: boolean;
  rutina: RutinaResumen | null;
  bloques: BloqueDia[];
  bloquesCompletos: number;
  bloquesTotal: number;
  completo: boolean;
  durationMinutes: number | null;
  sensation: Sensacion | null;
}

// ── Vista coach: alumnos, rutinas, adherencia, asignación (etapas 5 y 6) ─

export interface AlumnoResumen {
  id: string;
  userId: string;
  name: string;
  initials: string | null;
  plan: string | null;
  planActive: boolean;
  nextPayment: string | null;
  unreadCount: number;
}

export interface AlumnoFicha {
  id: string;
  userId: string;
  name: string;
  email: string;
  initials: string | null;
  plan: string | null;
  planStartDate: string | null;
  planActive: boolean;
  nextPayment: string | null;
  records: Marca[];
}

export interface DiaAdherencia {
  date: string;
  completo: boolean;
  routineName: string;
  bloquesCompletos: number;
  bloquesTotal: number;
  durationMinutes: number | null;
  sensation: Sensacion | null;
  estado: EstadoSesion;
}

export interface Adherencia {
  start: string;
  end: string;
  asignados: number;
  completados: number;
  pct: number | null;
  days: DiaAdherencia[];
}

export interface RutinaListado {
  id: string;
  name: string;
  type: TipoRutina;
  createdAt: string;
}

export interface DiaAsignacionCoach {
  date: string;
  esDescanso: boolean;
  routine: RutinaResumen | null;
}

// Los valores que Chino le puso a UN ejercicio para UN alumno en UN día. Pisan
// a los de la rutina, que pasan a ser el valor sugerido. reps y durationSeconds
// nunca vienen los dos: un ejercicio se mide por repeticiones o por tiempo.
export interface OverrideEjercicio {
  exerciseId: string;
  reps: string | null;
  durationSeconds: number | null;
  load: string | null;
}
