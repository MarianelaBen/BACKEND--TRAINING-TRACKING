-- Fase 3 de las correcciones del 08/09: rutinas genéricas.
--
-- Chino arma la rutina SIN peso ni repeticiones y las completa recién cuando se
-- la asigna a un alumno, para que sean personalizadas de cada uno. Hasta ahora
-- "load" y "reps" vivían en Exercise, o sea dentro de la rutina: cambiarle el
-- peso a Mica se lo cambiaba a TODOS los alumnos con esa rutina asignada.
--
-- Los valores de Exercise pasan a ser el SUGERIDO de la rutina; el de cada
-- alumno para cada día vive acá. GET /student/days/:date resuelve cuál gana.

-- CreateTable
CREATE TABLE "AssignmentExercise" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "reps" TEXT,
    "load" TEXT,
    "durationSeconds" INTEGER,

    CONSTRAINT "AssignmentExercise_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentExercise_assignmentId_exerciseId_key" ON "AssignmentExercise"("assignmentId", "exerciseId");

-- AddForeignKey
ALTER TABLE "AssignmentExercise" ADD CONSTRAINT "AssignmentExercise_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentExercise" ADD CONSTRAINT "AssignmentExercise_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- La misma regla que Exercise: repeticiones o tiempo, nunca las dos.
ALTER TABLE "AssignmentExercise" ADD CONSTRAINT "AssignmentExercise_reps_xor_duration"
  CHECK (NOT ("reps" IS NOT NULL AND "durationSeconds" IS NOT NULL));

-- Y en Exercise el CHECK se relaja: hasta la fase 2 exigía exactamente uno de
-- los dos, pero una rutina genérica no tiene ninguno todavía. Sigue prohibido
-- tener los dos, que es lo que importa.
ALTER TABLE "Exercise" DROP CONSTRAINT "Exercise_reps_xor_duration";
ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_reps_xor_duration"
  CHECK (NOT ("reps" IS NOT NULL AND "durationSeconds" IS NOT NULL));
