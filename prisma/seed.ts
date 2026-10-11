/**
 * Idempotent seed. Safe to run repeatedly:
 *   - permissions are upserted from the code catalog
 *   - system roles are created if missing (existing role edits are preserved)
 *   - a super admin is created only if none exists
 *   - demo catalog data is created only outside production
 */
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import { seedCore } from "./seed-core";
import { seedDemoData } from "./seed-demo";
import { closeRedis } from "../src/database/redis";
import { closeQueues } from "../src/jobs/queues";

dotenv.config({ quiet: true });
const prisma = new PrismaClient();

async function main() {
  await seedCore(prisma);
  if (process.env.NODE_ENV !== "production" && process.env.SEED_DEMO !== "false") {
    await seedDemoData(prisma);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  // Close every connection opened by app modules so the process can exit.
  .finally(() => Promise.allSettled([prisma.$disconnect(), closeRedis(), closeQueues()]));
