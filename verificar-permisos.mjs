import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

for (const linea of readFileSync('.env', 'utf8').split('\n')) {
  const m = linea.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n\r]*)"?\s*$/);
  if (m) process.env[m[1]] ??= m[2];
}

const connectionString = process.env.DATABASE_URL;
const schema = new URL(connectionString).searchParams.get('schema') ?? undefined;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });

// Todo casteado a ::text: el driver de Prisma 7 no deserializa char ni los
// dominios de information_schema.
const tablas = await prisma.$queryRawUnsafe(`
  SELECT table_name::text AS tabla,
         string_agg(DISTINCT privilege_type::text, ', ')::text AS permisos
  FROM information_schema.table_privileges
  WHERE table_schema = 'chino' AND grantee = 'miridieguezomnia'
  GROUP BY table_name ORDER BY table_name;
`);

const futuras = await prisma.$queryRawUnsafe(`
  SELECT pg_get_userbyid(defaclrole)::text AS quien_crea,
         defaclobjtype::text AS tipo,
         defaclacl::text AS reglas
  FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
  WHERE n.nspname = 'chino';
`);

console.log('=== TABLAS QUE MIRI YA PUEDE USAR ===');
if (tablas.length === 0) console.log('  NINGUNA');
for (const t of tablas) console.log('  ' + t.tabla.padEnd(22) + t.permisos);

console.log('\n=== LO QUE SE CREE EN EL FUTURO ===');
if (futuras.length === 0) console.log('  SIN REGLAS');
for (const f of futuras) {
  const tipo = f.tipo === 'r' ? 'tablas' : f.tipo === 'S' ? 'secuencias' : f.tipo;
  console.log(`  lo que cree ${f.quien_crea} (${tipo}): ${f.reglas}`);
}

await prisma.$disconnect();
