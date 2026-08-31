-- Agrega el índice único que ya declara @@unique([sessionId, exerciseId, setNumber])
-- en schema.prisma (etapa 4), pero que había quedado afuera de la migración
-- inicial. Sin esto, el upsert de PUT /student/days/:date/exercises/:id/sets/:n
-- rompe con "no unique or exclusion constraint matching the ON CONFLICT specification".
CREATE UNIQUE INDEX "SetLog_sessionId_exerciseId_setNumber_key" ON "SetLog"("sessionId", "exerciseId", "setNumber");
