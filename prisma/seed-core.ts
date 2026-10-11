import type { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { PERMISSIONS, SYSTEM_ROLES } from "../src/modules/rbac/permissions";

/** Core reference data required in every environment (including tests). */
export async function seedPermissions(prisma: PrismaClient) {
  const entries = Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description, module: code.split(".")[0]! }));
  const known = new Set((await prisma.permission.findMany({ select: { code: true } })).map((p) => p.code));
  await prisma.permission.createMany({ data: entries, skipDuplicates: true });
  // On a database that already has roles, a permission added in a later release would reach nobody but the
  // super admin. Give it, once, to the system roles that have it by default; roles are otherwise left as edited.
  const added = entries.map((e) => e.code).filter((code) => !known.has(code));
  if (known.size && added.length) await grantToSystemRoles(prisma, added);
  // Keep descriptions in sync for permissions that already existed.
  const existing = await prisma.permission.findMany({ select: { code: true, description: true } });
  const changed = entries.filter((e) => existing.some((x) => x.code === e.code && x.description !== e.description));
  for (const e of changed) await prisma.permission.update({ where: { code: e.code }, data: { description: e.description } });
  console.log(`✔ ${entries.length} permissions`);
}

export async function seedRoles(prisma: PrismaClient) {
  const perms = await prisma.permission.findMany({ select: { id: true, code: true } });
  for (const [code, def] of Object.entries(SYSTEM_ROLES)) {
    const existing = await prisma.role.findUnique({ where: { code } });
    if (existing) continue;
    const codes = def.permissions === "*" ? [] : def.permissions;
    await prisma.role.create({
      data: {
        code,
        name: def.name,
        description: def.description,
        isSystem: true,
        permissions: { create: perms.filter((p) => codes.includes(p.code as never)).map((p) => ({ permissionId: p.id })) },
      },
    });
    console.log(`✔ role ${code}`);
  }
}

async function grantToSystemRoles(prisma: PrismaClient, codes: string[]) {
  const perms = await prisma.permission.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  for (const [roleCode, def] of Object.entries(SYSTEM_ROLES)) {
    if (def.permissions === "*") continue; // the super admin has everything without rows
    const defaults: readonly string[] = def.permissions;
    const grant = perms.filter((p) => defaults.includes(p.code));
    const role = grant.length ? await prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } }) : null;
    if (!role) continue;
    await prisma.rolePermission.createMany({ data: grant.map((p) => ({ roleId: role.id, permissionId: p.id })), skipDuplicates: true });
    console.log(`✔ role ${roleCode}: granted ${grant.map((p) => p.code).join(", ")}`);
  }
}

export async function seedWarehouse(prisma: PrismaClient) {
  const count = await prisma.warehouse.count();
  if (count > 0) return;
  await prisma.warehouse.create({
    data: {
      code: "WH-001",
      name: "Main Warehouse",
      addressLine1: "Update this address in Admin → Warehouses",
      city: "Chennai",
      state: "Tamil Nadu",
      stateCode: "33",
      postalCode: "600001",
      isOnlineFulfillment: true,
      priority: 1,
    },
  });
  console.log("✔ default warehouse WH-001 (update its address)");
}

export async function seedSuperAdmin(prisma: PrismaClient) {
  const hasSuper = await prisma.userRole.count({ where: { role: { code: "SUPER_ADMIN" } } });
  if (hasSuper) return;
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn("! SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — no super admin created");
    return;
  }
  if (process.env.NODE_ENV === "production" && (password === "ChangeMe!2026" || password.length < 12)) {
    throw new Error("Set a strong SEED_ADMIN_PASSWORD (12+ characters, not the example value) before seeding production");
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { code: "SUPER_ADMIN" } });
  const warehouse = await prisma.warehouse.findFirst({ orderBy: { priority: "asc" } });
  await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
      isStaff: true,
      emailVerifiedAt: new Date(),
      defaultWarehouseId: warehouse?.id,
      profile: { create: { firstName: "Store", lastName: "Admin" } },
      roles: { create: { roleId: role.id } },
    },
    update: { isStaff: true, roles: { create: { roleId: role.id } } },
  });
  console.log(`✔ super admin ${email} (change the password after first login)`);
}

export async function seedTaxClasses(prisma: PrismaClient) {
  if ((await prisma.taxClass.count()) > 0) return;
  // EXAMPLES ONLY. Confirm every rate and slab with your tax advisor before
  // selling; edit them in Admin → Settings → Tax. Nothing in the code assumes
  // these values.
  const classes: { code: string; name: string; description: string; isDefault?: boolean; rates: { rateBps: number; min?: number; max?: number }[] }[] = [
    { code: "GST_0", name: "Exempt / 0%", description: "Example", rates: [{ rateBps: 0 }] },
    { code: "GST_5", name: "GST 5%", description: "Example", rates: [{ rateBps: 500 }] },
    { code: "GST_18", name: "GST 18%", description: "Example", isDefault: true, rates: [{ rateBps: 1800 }] },
    {
      code: "APPAREL",
      name: "Apparel (price slab)",
      description: "Example slab: rate depends on the taxable value per piece. Verify current notified slabs.",
      rates: [
        { rateBps: 500, max: 250_000 },
        { rateBps: 1800, min: 250_001 },
      ],
    },
  ];
  for (const c of classes) {
    await prisma.taxClass.create({
      data: {
        code: c.code,
        name: c.name,
        description: c.description,
        isDefault: c.isDefault ?? false,
        rates: { create: c.rates.map((r) => ({ rateBps: r.rateBps, minUnitPrice: r.min ?? null, maxUnitPrice: r.max ?? null, effectiveFrom: new Date("2025-09-22T00:00:00+05:30") })) },
      },
    });
  }
  console.log("✔ example tax classes (CONFIRM RATES BEFORE GO-LIVE)");
}

export async function seedCore(prisma: PrismaClient, opts: { quiet?: boolean } = {}) {
  const log = console.log;
  if (opts.quiet) console.log = () => undefined;
  try {
    await seedPermissions(prisma);
    await seedRoles(prisma);
    await seedWarehouse(prisma);
    await seedSuperAdmin(prisma);
    await seedTaxClasses(prisma);
  } finally {
    console.log = log;
  }
}
