// Seed mínimo para desarrollo: un coach, dos alumnos y una rutina de ejemplo.
// Correr con: pnpm seed

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';

const connectionString = process.env.DATABASE_URL;
const schema = connectionString ? new URL(connectionString).searchParams.get('schema') ?? undefined : undefined;
const adapter = new PrismaPg({ connectionString }, { schema });
const prisma = new PrismaClient({ adapter });

const DEV_PASSWORD = 'chino1234';

async function main() {
  const passwordHash = await argon2.hash(DEV_PASSWORD);

  const coach = await prisma.user.upsert({
    where: { email: 'chino@entrenaconchino.com' },
    update: {},
    create: {
      email: 'chino@entrenaconchino.com',
      passwordHash,
      role: 'COACH',
      name: 'Chino Díaz',
      initials: 'CD',
    },
  });

  const alumna = await prisma.user.upsert({
    where: { email: 'mica@example.com' },
    update: {},
    create: {
      email: 'mica@example.com',
      passwordHash,
      role: 'STUDENT',
      name: 'Micaela Sosa',
      initials: 'MS',
      studentProfile: {
        create: {
          coachId: coach.id,
          plan: 'Hipertrofia · 5 días',
          planStartDate: new Date('2026-06-01'),
          planActive: true,
        },
      },
    },
    include: { studentProfile: true },
  });

  await prisma.user.upsert({
    where: { email: 'juan@example.com' },
    update: {},
    create: {
      email: 'juan@example.com',
      passwordHash,
      role: 'STUDENT',
      name: 'Juan Pérez',
      initials: 'JP',
      studentProfile: {
        create: {
          coachId: coach.id,
          plan: 'Iniciación · 3 días',
          planStartDate: new Date('2026-07-15'),
          planActive: true,
        },
      },
    },
  });

  const studentProfileId = alumna.studentProfile!.id;

  // Routine no tiene un campo natural para upsert (el id es un cuid), así que
  // la idempotencia se resuelve a mano: si ya existe una con este nombre para
  // este coach, se reusa en vez de duplicarla.
  const routine =
    (await prisma.routine.findFirst({ where: { coachId: coach.id, name: 'Tren superior — Fuerza' } })) ??
    (await prisma.routine.create({
      data: {
        coachId: coach.id,
        name: 'Tren superior — Fuerza',
        type: 'FUERZA',
        blocks: {
          create: [
            {
              letter: 'A',
              name: 'Fuerza principal',
              mode: 'Series rectas',
              estMinutes: 25,
              note: 'Dale, entrada en calor bien hecha y a subir el peso de a poco. No hay apuro.',
              orderIndex: 0,
              exercises: {
                create: [
                  { name: 'Press de banca', sets: 4, reps: '8', load: '60 kg', restSeconds: 90, orderIndex: 0 },
                  { name: 'Remo con barra', sets: 4, reps: '8', load: '50 kg', restSeconds: 90, orderIndex: 1 },
                ],
              },
            },
            {
              letter: 'B',
              name: 'Accesorios',
              mode: 'Circuito · 2 vueltas',
              estMinutes: 15,
              note: 'Bajá el press si sentís molestia en el hombro.',
              orderIndex: 1,
              exercises: {
                create: [
                  { name: 'Press militar mancuernas', sets: 3, reps: '12', load: '14 kg', restSeconds: 60, orderIndex: 0 },
                  { name: 'Curl de bíceps', sets: 3, reps: '12 por lado', load: '10 kg', restSeconds: 45, orderIndex: 1 },
                ],
              },
            },
          ],
        },
      },
    }));

  const assignment = await prisma.assignment.upsert({
    where: { studentId_date: { studentId: studentProfileId, date: new Date('2026-08-26') } },
    update: {},
    create: {
      studentId: studentProfileId,
      routineId: routine.id,
      date: new Date('2026-08-26'),
    },
  });

  const existingRecord = await prisma.personalRecord.findFirst({
    where: { studentId: studentProfileId, exerciseName: 'Press de banca' },
  });
  if (!existingRecord) {
    await prisma.personalRecord.create({
      data: {
        studentId: studentProfileId,
        exerciseName: 'Press de banca',
        value: '62,5 kg',
        note: '+7,5 kg en 4 semanas',
      },
    });
  }

  // Sin unique key natural para el mensaje de bienvenida: si el alumno ya
  // tiene algún mensaje, no lo repite (es sólo dato de demo).
  const existingMessage = await prisma.message.findFirst({ where: { studentId: studentProfileId } });
  if (!existingMessage) {
    await prisma.message.create({
      data: {
        studentId: studentProfileId,
        senderId: coach.id,
        body: 'Dale Mica, esta semana subimos el press de banca. Cualquier cosa me contás.',
      },
    });
  }

  console.log('Seed listo.');
  console.log(`Coach:  chino@entrenaconchino.com / ${DEV_PASSWORD}`);
  console.log(`Alumna: mica@example.com / ${DEV_PASSWORD} (asignación del ${assignment.date.toISOString().slice(0, 10)})`);
  console.log(`Alumno: juan@example.com / ${DEV_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
