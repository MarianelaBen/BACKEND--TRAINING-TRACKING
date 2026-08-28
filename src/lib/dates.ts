// Fechas de día (sin hora), siempre UTC medianoche — coincide con cómo
// @prisma/adapter-pg escribe y lee columnas @db.Date en este stack (ver
// plan de la etapa 3 para el detalle del round-trip verificado).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const GYM_TZ = 'America/Argentina/Buenos_Aires';

export function parseDateParam(input: string): Date | null {
  if (!DATE_RE.test(input)) return null;
  const date = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return toDateString(date) === input ? date : null;
}

export function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// "Hoy" según el huso horario del gimnasio, no el del server (que en
// producción probablemente corre en UTC).
export function todayInGymTZ(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GYM_TZ }).format(new Date());
}

export function mondayOf(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const diasDesdeLunes = (date.getUTCDay() + 6) % 7;
  return addDays(dateStr, -diasDesdeLunes);
}

export function addDays(dateStr: string, n: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return toDateString(date);
}
