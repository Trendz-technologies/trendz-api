import { execSync } from "node:child_process";
import path from "node:path";

/** Applies migrations to the test database once per test run. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://trendz:trendz_local_pw@127.0.0.1:5432/trendz_test?schema=public&connect_timeout=30";
  execSync("npx prisma migrate deploy", {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
