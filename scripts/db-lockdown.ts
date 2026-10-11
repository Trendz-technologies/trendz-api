/**
 * Keeps the application's tables private on Supabase.
 *
 * Supabase puts an automatic REST API (its "Data API") in front of the
 * database, and by default the roles behind its public key, `anon` and
 * `authenticated`, may read and write every table in the `public` schema.
 * This application does not use that API: the tables are reached only by the
 * Express API, signed in as their owner. So here:
 *
 *   - those two roles lose every privilege on the schema and on its tables,
 *     sequences and functions, now and for objects created later;
 *   - row level security is switched on for every table, with no policy. That
 *     refuses them even if a privilege is granted again by mistake. The owner
 *     (the role the application and the migrations sign in as) is not affected.
 *
 * On any other PostgreSQL (local, self-hosted) those roles do not exist and
 * nothing is changed. Safe to run repeatedly: `npm run db:deploy` runs it after
 * the migrations, so a table added by a new migration is covered as well.
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

// Only the database is needed here, so the rest of the application (and its settings) is not loaded.
dotenv.config({ path: [".env.keys", ".env"], quiet: true });
const prisma = new PrismaClient();

const API_ROLES = ["anon", "authenticated"];

async function main() {
  const roles = (await prisma.$queryRawUnsafe<{ rolname: string }[]>(`SELECT rolname FROM pg_roles WHERE rolname IN (${API_ROLES.map((r) => `'${r}'`).join(", ")})`)).map((r) => r.rolname);
  if (!roles.length) {
    console.log("• not a Supabase database (no anon / authenticated roles): nothing to lock down");
    return;
  }
  const list = roles.map((r) => `"${r}"`).join(", ");

  for (const objects of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL ${objects} IN SCHEMA public FROM ${list}`);
    // For what this role creates from now on (Supabase's own default is to grant these).
    await prisma.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ${objects} FROM ${list}`);
  }
  await prisma.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${list}`);

  const open = await prisma.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY tablename`);
  for (const { tablename } of open) await prisma.$executeRawUnsafe(`ALTER TABLE public."${tablename.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY`);

  // Report what is true now, not what was asked for: can either role still do anything to any table?
  // (They keep the right to look names up in the schema, which every role has and which opens nothing by itself.)
  const reachable = roles.map((r) => `has_table_privilege('${r}', format('public.%I', tablename)::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')`).join(" OR ");
  const [state] = await prisma.$queryRawUnsafe<{ tables: number; unprotected: number; reachable: number }[]>(
    `SELECT count(*)::int AS tables,
            count(*) FILTER (WHERE NOT rowsecurity)::int AS unprotected,
            count(*) FILTER (WHERE ${reachable})::int AS reachable
     FROM pg_tables WHERE schemaname = 'public'`,
  );
  const locked = state!.unprotected === 0 && state!.reachable === 0;
  console.log(
    `${locked ? "✔" : "✘"} Supabase lock-down: ${state!.tables} tables; row level security newly switched on for ${open.length}, missing on ${state!.unprotected}; ` +
      `tables that ${roles.join(" / ")} can still read or write: ${state!.reachable}`,
  );
  if (!locked) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
