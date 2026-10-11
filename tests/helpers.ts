import request from "supertest";
import type { Express } from "express";
import argon2 from "argon2";
import { createApp } from "../src/app";
import { prisma } from "../src/database/prisma";
import { redis } from "../src/database/redis";
import { getQueue, type QueueName } from "../src/jobs/queues";
import { seedCore } from "../prisma/seed-core";

let app: Express | null = null;
export const getApp = () => (app ??= createApp());

/** Wipes every table (TRUNCATE skips row triggers) and Redis DB 1, then re-seeds reference data. */
let allTables: string[] | null = null;

export async function resetDatabase() {
  // This empties every table. It must only ever reach a throwaway test database, never the one the
  // application uses (tests/setup-env.ts points the tests at trendz_test; this is the second lock).
  const [{ db }] = await prisma.$queryRaw<[{ db: string }]>`SELECT current_database() AS db`;
  if (!db.endsWith("_test")) throw new Error(`Refusing to empty the database "${db}": tests only run against a database whose name ends in "_test".`);
  allTables ??= (
    await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  ).map((t) => t.tablename);
  // TRUNCATE ... CASCADE is slow (~1.5s) on Docker for Windows. Instead, DELETE
  // only the tables that have rows, with triggers and FK checks suspended
  // (session_replication_role=replica; test database only, superuser role).
  const nonEmpty = await prisma.$queryRawUnsafe<{ t: string }[]>(
    allTables.map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM "${t}")`).join(" UNION ALL "),
  );
  if (nonEmpty.length) {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      ...nonEmpty.map((r) => prisma.$executeRawUnsafe(`DELETE FROM "${r.t}"`)),
    ]);
  }
  await redis.flushdb();
  await seedCore(prisma, { quiet: true });
}

/** A supertest agent that keeps cookies and sends the CSRF header automatically. */
export async function client() {
  const agent = request.agent(getApp());
  const res = await agent.get("/api/auth/csrf").expect(200);
  const csrf = res.body.data.csrfToken as string;
  const wrap =
    (method: "post" | "put" | "patch" | "delete") =>
    (url: string) =>
      agent[method](url).set("X-CSRF-Token", csrf);
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(url),
    post: wrap("post"),
    put: wrap("put"),
    patch: wrap("patch"),
    delete: wrap("delete"),
  };
}

export type TestClient = Awaited<ReturnType<typeof client>>;

let counter = 0;
export async function createUser(opts: { roles?: string[]; email?: string; password?: string; phone?: string; isStaff?: boolean; warehouseId?: string } = {}) {
  counter += 1;
  const roles = opts.roles ?? ["CUSTOMER"];
  const email = opts.email ?? `user${counter}-${Date.now()}@test.local`;
  const password = opts.password ?? "Password123";
  const roleRows = await prisma.role.findMany({ where: { code: { in: roles } } });
  const user = await prisma.user.create({
    data: {
      email,
      phone: opts.phone,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 4096, timeCost: 2 }),
      isStaff: opts.isStaff ?? roles.some((r) => r !== "CUSTOMER"),
      emailVerifiedAt: new Date(),
      defaultWarehouseId: opts.warehouseId,
      profile: { create: { firstName: "Test", lastName: `User${counter}` } },
      roles: { create: roleRows.map((r) => ({ roleId: r.id })) },
    },
  });
  return { ...user, password };
}

export async function loginAs(roles: string[] = ["CUSTOMER"], extra: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser({ ...extra, roles });
  const c = await client();
  await c.post("/api/auth/login").send({ identifier: user.email, password: user.password }).expect(200);
  return { client: c, user };
}

/** Reads the newest job of a given name from a queue (jobs are not processed in tests). */
export async function latestJob(queue: QueueName, name: string) {
  const jobs = await getQueue(queue).getJobs(["waiting", "prioritized", "delayed"], 0, 50);
  return jobs.filter((j) => j.name === name).sort((a, b) => b.timestamp - a.timestamp)[0];
}

export async function drainQueue(queue: QueueName) {
  await getQueue(queue).drain(true);
}
