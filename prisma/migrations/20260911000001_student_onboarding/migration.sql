ALTER TABLE "StudentProfile"
ADD COLUMN "goal" TEXT,
ADD COLUMN "experience" TEXT,
ADD COLUMN "trainingDaysPerWeek" INTEGER,
ADD COLUMN "sessionMinutes" INTEGER,
ADD COLUMN "limitations" TEXT,
ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);

-- Los alumnos que ya usaban la app no deben volver a pasar por el onboarding.
UPDATE "StudentProfile"
SET "onboardingCompletedAt" = CURRENT_TIMESTAMP;
