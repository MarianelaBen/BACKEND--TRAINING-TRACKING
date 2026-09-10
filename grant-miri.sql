-- Acceso compartido: lo corre MARIANELA (maribenitezomnia).
-- Le da a Miri acceso a todo lo que Marianela tenga o cree en el schema chino.
--
-- Por qué hace falta: en Postgres, quien crea una tabla queda como su dueño y
-- el resto no la ve hasta que se le dé permiso. Con las dos corriendo
-- migraciones sobre la misma base, cada tabla nueva deja a la otra afuera.
-- Ya pasó dos veces (SetLog en agosto, AssignmentExercise el 08/09).
--
-- Ojo: esto es la MITAD. Cubre lo que crea Marianela. Para lo que cree Miri
-- hace falta el archivo espejo (grant-mari.sql), y lo tiene que correr ella:
-- ALTER DEFAULT PRIVILEGES sólo lo puede ejecutar el dueño de ese rol.

-- Se da ALL PRIVILEGES y no sólo SELECT/INSERT/UPDATE/DELETE porque así están
-- las tablas que creó el superusuario, y emparejar evita sorpresas: TRUNCATE
-- lo usan los seeds al limpiar, y REFERENCES hace falta si una migración
-- futura le apunta una foreign key. Es un schema de desarrollo de dos personas
-- que las dos migran: no tiene sentido que una tenga menos permiso que la otra.
-- Correrlo de nuevo no rompe nada, es idempotente.

-- 1) Las tablas que ya existen y son de Marianela (incluye AssignmentExercise,
--    que es la que hoy Miri no puede tocar). Las que no sean suyas se saltean
--    con un warning, no corta la ejecución.
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA chino TO miridieguezomnia;

-- 2) Las secuencias que ya existen. Hoy no hay ninguna (todos los id son cuid,
--    o sea texto), pero si alguna tabla futura usa autoincremental, sin esto
--    los INSERT fallan.
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA chino TO miridieguezomnia;

-- 3) Lo importante: todo lo que Marianela cree DE ACÁ EN ADELANTE queda
--    accesible para Miri sin tener que acordarse de nada.
ALTER DEFAULT PRIVILEGES FOR ROLE maribenitezomnia IN SCHEMA chino
  GRANT ALL PRIVILEGES ON TABLES TO miridieguezomnia;

ALTER DEFAULT PRIVILEGES FOR ROLE maribenitezomnia IN SCHEMA chino
  GRANT ALL PRIVILEGES ON SEQUENCES TO miridieguezomnia;
