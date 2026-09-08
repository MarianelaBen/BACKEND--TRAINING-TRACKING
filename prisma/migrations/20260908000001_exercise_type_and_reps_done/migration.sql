-- Fase 1 de las correcciones del 08/09: dos columnas nuevas, las dos nullables.
-- Nada de lo que ya está cargado se rompe ni se reescribe.
--
-- Exercise.type: el tipo de trabajo (Movilidad / Fuerza / Metabólico) pasa a
-- definirse también por ejercicio, no sólo por rutina. Reusa el enum
-- RoutineType que ya existe. Los ejercicios cargados antes quedan en NULL.
--
-- SetLog.repsDone: las repeticiones que el alumno realmente hizo. Exercise.reps
-- sigue siendo el plan del coach (texto: "8", "máx", "12 por lado"); esto es
-- el número crudo de lo que se hizo, para poder graficar progresión.

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN     "type" "RoutineType";

-- AlterTable
ALTER TABLE "SetLog" ADD COLUMN     "repsDone" INTEGER;
