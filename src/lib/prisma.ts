import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// El param ?schema= de DATABASE_URL no lo lee el driver `pg` solo:
// hay que pasárselo aparte al adapter.
const connectionString = process.env.DATABASE_URL;
const schema = connectionString ? new URL(connectionString).searchParams.get('schema') ?? undefined : undefined;

const adapter = new PrismaPg({ connectionString }, { schema });

export const prisma = new PrismaClient({ adapter });
