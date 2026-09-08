-- Fase 2 de las correcciones del 08/09: un ejercicio se mide por repeticiones
-- O por tiempo, nunca por las dos. Al alumno se le muestra el que corresponda.
--
-- Sacar el NOT NULL de "reps" NO pierde datos: relaja la restricción, las filas
-- que ya tienen texto lo conservan. Por eso el CHECK se puede agregar en la
-- misma migración: todo lo cargado hasta hoy tiene reps y no tiene duración,
-- o sea cumple "exactamente uno" desde el vamos.

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN     "durationSeconds" INTEGER,
ALTER COLUMN "reps" DROP NOT NULL;

-- La regla no se puede expresar en Prisma, así que va a mano: la validación de
-- POST/PATCH /coach/routines devuelve un 400 con mensaje claro, y esto lo
-- garantiza de verdad a nivel base.
ALTER TABLE "Exercise" ADD CONSTRAINT "Exercise_reps_xor_duration"
  CHECK (("reps" IS NOT NULL) <> ("durationSeconds" IS NOT NULL));
