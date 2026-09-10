CREATE TABLE "ExerciseCatalogItem" (
    "id" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RoutineType",
    "muscleGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExerciseCatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExerciseCatalogItem_coachId_idx" ON "ExerciseCatalogItem"("coachId");
CREATE UNIQUE INDEX "ExerciseCatalogItem_coachId_name_key" ON "ExerciseCatalogItem"("coachId", "name");
ALTER TABLE "ExerciseCatalogItem" ADD CONSTRAINT "ExerciseCatalogItem_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
