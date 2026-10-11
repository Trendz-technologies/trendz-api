/**
 * `prisma migrate dev`, only ever against a database on this machine.
 *
 * `migrate dev` writes new migrations and, when the database does not match
 * the migration history, offers to wipe it. That is fine for a developer's own
 * PostgreSQL and must never happen to a hosted database that holds the shop's
 * data (Supabase). So when DATABASE_URL is not a local address, the migration
 * is made against LOCAL_DATABASE_URL instead, and is then applied to the
 * hosted database with `npm run db:deploy` (which only ever adds).
 *
 * Usage: npm run db:migrate [-- --name add_something]
 */
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: [".env.keys", ".env"], quiet: true });

const isLocal = (url: string | undefined) => {
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
};

let url = process.env.DATABASE_URL;
if (!isLocal(url)) {
  if (!isLocal(process.env.LOCAL_DATABASE_URL)) {
    console.error(
      "DATABASE_URL is a hosted database, and `prisma migrate dev` is not run against one (it can ask to wipe it).\n" +
        "Set LOCAL_DATABASE_URL in .env to a PostgreSQL on this machine to write migrations there,\n" +
        "then apply them to the hosted database with: npm run db:deploy",
    );
    process.exit(1);
  }
  url = process.env.LOCAL_DATABASE_URL;
  console.log("• DATABASE_URL is a hosted database: making the migration against LOCAL_DATABASE_URL instead.");
  console.log("  Apply it to the hosted database afterwards with: npm run db:deploy\n");
}

// Prisma's own command line, started directly (no shell in between to reinterpret the arguments).
const result = spawnSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "dev", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
process.exit(result.status ?? 1);
