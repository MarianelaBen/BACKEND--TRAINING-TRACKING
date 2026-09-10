-- Acceso compartido: lo corre MIRI (miridieguezomnia). Es el espejo de
-- grant-miri.sql -- Marianela no lo puede correr por ella, porque
-- ALTER DEFAULT PRIVILEGES sólo lo puede ejecutar el dueño de ese rol.
--
-- Le da a Marianela acceso a todo lo que Miri tenga o cree en el schema chino,
-- para que ninguna de las dos vuelva a quedarse afuera de una tabla que creó
-- la otra.
--
-- Cómo correrlo, con el túnel SSH levantado:
--   cd <ruta del BACKEND--TRAINING-TRACKING>
--   pnpm exec prisma db execute --file ./grant-mari.sql --schema prisma/schema.prisma

-- 1) Las tablas que ya existen y son de Miri.
GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA chino
TO maribenitezomnia;

-- 2) Las secuencias que ya existen (hoy ninguna: todos los id son cuid).
GRANT USAGE, SELECT
ON ALL SEQUENCES IN SCHEMA chino
TO maribenitezomnia;

-- 3) Todo lo que Miri cree de acá en adelante.
ALTER DEFAULT PRIVILEGES FOR ROLE miridieguezomnia IN SCHEMA chino
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO maribenitezomnia;

ALTER DEFAULT PRIVILEGES FOR ROLE miridieguezomnia IN SCHEMA chino
  GRANT USAGE, SELECT ON SEQUENCES TO maribenitezomnia;
