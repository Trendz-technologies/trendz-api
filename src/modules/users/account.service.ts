import { z } from "zod";
import { prisma } from "../../database/prisma";
import { badRequest, notFound } from "../../common/errors/app-error";
import { isIndianPincode, stateCodeFor } from "../../common/utils/india";
import { phoneSchema } from "../auth/auth.schemas";
import { invalidatePrincipal } from "../auth/principal";

export const profileUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).nullable().optional(),
  dateOfBirth: z.iso.date().nullable().optional(),
  gender: z.enum(["female", "male", "other", "prefer_not_to_say"]).nullable().optional(),
  marketingOptIn: z.boolean().optional(),
});

export const addressSchema = z
  .object({
    label: z.string().trim().max(30).nullable().optional(),
    fullName: z.string().trim().min(2).max(100),
    phone: phoneSchema,
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).nullable().optional(),
    landmark: z.string().trim().max(100).nullable().optional(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(100),
    postalCode: z.string().trim(),
    country: z.literal("IN").default("IN"),
    isDefaultShipping: z.boolean().optional().default(false),
    isDefaultBilling: z.boolean().optional().default(false),
  })
  .superRefine((a, ctx) => {
    if (!stateCodeFor(a.state)) ctx.addIssue({ code: "custom", path: ["state"], message: "Select a valid state" });
    if (!isIndianPincode(a.postalCode)) ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid 6-digit PIN code" });
  });

export type AddressInput = z.infer<typeof addressSchema>;

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      phone: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      createdAt: true,
      passwordHash: true,
      profile: { select: { firstName: true, lastName: true, dateOfBirth: true, gender: true, marketingOptIn: true } },
    },
  });
  if (!user) throw notFound("User");
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: !!passwordHash };
}

export async function updateProfile(userId: string, input: z.infer<typeof profileUpdateSchema>) {
  await prisma.userProfile.upsert({
    where: { userId },
    create: {
      userId,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      gender: input.gender ?? null,
      marketingOptIn: input.marketingOptIn ?? false,
    },
    update: {
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: input.dateOfBirth === undefined ? undefined : input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      gender: input.gender,
      marketingOptIn: input.marketingOptIn,
    },
  });
  await invalidatePrincipal(userId);
  return getProfile(userId);
}

export function listAddresses(userId: string) {
  return prisma.address.findMany({ where: { userId }, orderBy: [{ isDefaultShipping: "desc" }, { createdAt: "desc" }] });
}

const MAX_ADDRESSES = 20;

export async function createAddress(userId: string, input: AddressInput) {
  const count = await prisma.address.count({ where: { userId } });
  if (count >= MAX_ADDRESSES) throw badRequest(`You can save up to ${MAX_ADDRESSES} addresses`);
  const first = count === 0;
  return prisma.$transaction(async (tx) => {
    if (input.isDefaultShipping || first) await tx.address.updateMany({ where: { userId }, data: { isDefaultShipping: false } });
    if (input.isDefaultBilling || first) await tx.address.updateMany({ where: { userId }, data: { isDefaultBilling: false } });
    return tx.address.create({
      data: {
        ...input,
        userId,
        stateCode: stateCodeFor(input.state)!,
        isDefaultShipping: input.isDefaultShipping || first,
        isDefaultBilling: input.isDefaultBilling || first,
      },
    });
  });
}

export async function updateAddress(userId: string, id: string, input: AddressInput) {
  const existing = await prisma.address.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw notFound("Address");
  return prisma.$transaction(async (tx) => {
    if (input.isDefaultShipping) await tx.address.updateMany({ where: { userId }, data: { isDefaultShipping: false } });
    if (input.isDefaultBilling) await tx.address.updateMany({ where: { userId }, data: { isDefaultBilling: false } });
    return tx.address.update({ where: { id }, data: { ...input, stateCode: stateCodeFor(input.state)! } });
  });
}

export async function deleteAddress(userId: string, id: string) {
  const res = await prisma.address.deleteMany({ where: { id, userId } });
  if (res.count === 0) throw notFound("Address");
}

export async function getOwnedAddress(userId: string, id: string) {
  const a = await prisma.address.findFirst({ where: { id, userId } });
  if (!a) throw notFound("Address");
  return a;
}
