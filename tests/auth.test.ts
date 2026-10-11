import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { sha256 } from "../src/common/utils/crypto";
import supertest from "supertest";
import { client, createUser, getApp, latestJob, resetDatabase } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

const cookieNames = (res: { headers: Record<string, unknown> }) =>
  ((res.headers["set-cookie"] as string[] | undefined) ?? []).map((c) => c.split("=")[0]);

describe("registration and password login", () => {
  it("registers a customer, sets httpOnly cookies and returns the profile", async () => {
    const c = await client();
    const res = await c
      .post("/api/auth/register")
      .send({ email: "Asha@Example.com", password: "Secret123", firstName: "Asha" })
      .expect(201);

    expect(res.body.data.user).toMatchObject({ email: "asha@example.com", isStaff: false, roles: ["CUSTOMER"], permissions: [] });
    expect(res.body.data.accessToken).toBeUndefined(); // browsers never see tokens
    expect(cookieNames(res)).toEqual(expect.arrayContaining(["access_token", "refresh_token"]));
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("access_token"))!;
    expect(setCookie).toMatch(/HttpOnly/i);

    const me = await c.get("/api/auth/me").expect(200);
    expect(me.body.data.user.email).toBe("asha@example.com");

    // A verification email is queued (as a transient job, never stored in the DB).
    const job = await latestJob("notifications", "transient");
    expect(job?.data).toMatchObject({ kind: "email", template: "auth.verify_email", to: "asha@example.com" });
    expect(await prisma.notification.count()).toBe(0);
  });

  it("rejects duplicate emails and weak passwords", async () => {
    const c = await client();
    await c.post("/api/auth/register").send({ email: "dup@example.com", password: "Secret123", firstName: "A" }).expect(201);
    const c2 = await client();
    const dup = await c2.post("/api/auth/register").send({ email: "DUP@example.com", password: "Secret123", firstName: "B" }).expect(409);
    expect(dup.body).toMatchObject({ success: false, code: "EMAIL_TAKEN" });

    const weak = await c2.post("/api/auth/register").send({ email: "weak@example.com", password: "short", firstName: "C" }).expect(400);
    expect(weak.body.code).toBe("VALIDATION_ERROR");
    expect(weak.body.errors[0].path).toBe("password");
  });

  it("rejects state-changing requests without a CSRF token", async () => {
    const c = await client();
    const res = await c.agent.post("/api/auth/login").send({ identifier: "x@example.com", password: "whatever1" }).expect(403);
    expect(res.body.code).toBe("CSRF_INVALID");
  });

  it("uses the same error for unknown users and wrong passwords, and locks after 5 failures", async () => {
    const user = await createUser({ password: "Correct123" });
    const c = await client();
    const unknown = await c.post("/api/auth/login").send({ identifier: "nobody@test.local", password: "Wrong1234" }).expect(401);
    expect(unknown.body.code).toBe("INVALID_CREDENTIALS");

    for (let i = 0; i < 5; i++) {
      const r = await c.post("/api/auth/login").send({ identifier: user.email, password: "Wrong1234" });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("INVALID_CREDENTIALS");
    }
    const locked = await c.post("/api/auth/login").send({ identifier: user.email, password: "Correct123" }).expect(403);
    expect(locked.body.code).toBe("ACCOUNT_LOCKED");
    expect(await prisma.loginAttempt.count({ where: { userId: user.id, success: false } })).toBe(6);
  });

  it("allows login by phone number in any common format", async () => {
    const user = await createUser({ password: "Correct123", phone: "+919876543210" });
    const c = await client();
    const res = await c.post("/api/auth/login").send({ identifier: "98765 43210", password: "Correct123" }).expect(200);
    expect(res.body.data.user.id).toBe(user.id);
  });
});

describe("sessions", () => {
  it("rotates refresh tokens and revokes the session when an old token is replayed", async () => {
    const user = await createUser({ password: "Correct123" });
    const c = await client();
    const login = await c.post("/api/auth/login").set("X-Client", "native").send({ identifier: user.email, password: "Correct123" }).expect(200);
    const firstRefresh = login.body.data.refreshToken as string;

    const r1 = await c.post("/api/auth/refresh").set("X-Client", "native").send({ refreshToken: firstRefresh }).expect(200);
    expect(r1.body.data.refreshToken).not.toBe(firstRefresh);

    // Replaying the rotated token inside the grace window is tolerated...
    const grace = await c.post("/api/auth/refresh").set("X-Client", "native").send({ refreshToken: firstRefresh }).expect(401);
    expect(grace.body.code).toBe("TOKEN_ROTATED");

    // ...but outside it the session is treated as stolen and revoked.
    await prisma.userSession.updateMany({ where: { previousTokenHash: sha256(firstRefresh) }, data: { lastUsedAt: new Date(Date.now() - 5 * 60_000) } });
    await c.post("/api/auth/refresh").set("X-Client", "native").send({ refreshToken: firstRefresh }).expect(401);
    const session = await prisma.userSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.revokedReason).toBe("refresh token reuse detected");

    // The newest token is now useless too.
    await c.post("/api/auth/refresh").set("X-Client", "native").send({ refreshToken: r1.body.data.refreshToken }).expect(401);
  });

  it("logout revokes the session immediately", async () => {
    const user = await createUser({ password: "Correct123" });
    const c = await client();
    await c.post("/api/auth/login").send({ identifier: user.email, password: "Correct123" }).expect(200);
    await c.get("/api/auth/me").expect(200);
    await c.post("/api/auth/logout").expect(200);
    await c.get("/api/auth/me").expect(401);
  });

  it("supports bearer tokens for native clients without CSRF", async () => {
    const user = await createUser({ password: "Correct123" });
    const c = await client();
    const login = await c.post("/api/auth/login").set("X-Client", "native").send({ identifier: user.email, password: "Correct123" }).expect(200);
    const me = await supertest(getApp()).get("/api/auth/me").set("Authorization", `Bearer ${login.body.data.accessToken}`).expect(200);
    expect(me.body.data.user.id).toBe(user.id);
  });
});

describe("codes by SMS", () => {
  it("do not sign anyone in", async () => {
    const c = await client();
    // Without a session there is no code to ask for or to enter, and the old LOGIN purpose is refused outright.
    await c.post("/api/auth/otp").send({ phone: "9123456789" }).expect(401);
    await c.post("/api/auth/otp/verify").send({ phone: "9123456789", code: "123456" }).expect(401);
    const refused = await c.post("/api/auth/otp").send({ phone: "9123456789", purpose: "LOGIN" }).expect(400);
    expect(JSON.stringify(refused.body)).toContain("Signing in with a code is not available");
    await c.post("/api/auth/otp/verify").send({ phone: "9123456789", code: "123456", purpose: "LOGIN" }).expect(400);

    expect(await prisma.otpCode.count()).toBe(0);
    expect(await prisma.user.count({ where: { phone: "+919123456789" } })).toBe(0);
    await c.get("/api/auth/me").expect(401);
  });

  it("confirm the mobile number of a signed-in account, and are never stored in plaintext", async () => {
    const user = await createUser({ password: "Secret123" });
    const c = await client();
    await c.post("/api/auth/login").send({ identifier: user.email, password: "Secret123" }).expect(200);
    await c.post("/api/auth/otp").send({ phone: "9123456789" }).expect(200);

    const job = await latestJob("notifications", "transient");
    const code = job!.data.variables.otp as string;
    expect(job!.data.to).toBe("+919123456789");
    const stored = await prisma.otpCode.findFirstOrThrow({ where: { identifier: "+919123456789" } });
    expect(stored.purpose).toBe("VERIFY_PHONE");
    expect(stored.codeHash).not.toContain(code);

    const wrong = await c.post("/api/auth/otp/verify").send({ phone: "9123456789", code: code === "000000" ? "111111" : "000000" }).expect(400);
    expect(wrong.body.code).toBe("OTP_INVALID");

    const ok = await c.post("/api/auth/otp/verify").send({ phone: "+91 91234 56789", code }).expect(200);
    expect(ok.body.data.user).toMatchObject({ id: user.id, phone: "+919123456789", phoneVerified: true });

    // Codes are single use.
    const reused = await c.post("/api/auth/otp/verify").send({ phone: "9123456789", code }).expect(400);
    expect(reused.body.code).toBe("OTP_EXPIRED");
  });

  it("enforce a resend cooldown", async () => {
    const user = await createUser({ password: "Secret123" });
    const c = await client();
    await c.post("/api/auth/login").send({ identifier: user.email, password: "Secret123" }).expect(200);
    await c.post("/api/auth/otp").send({ phone: "9000000001" }).expect(200);
    const again = await c.post("/api/auth/otp").send({ phone: "9000000001" }).expect(429);
    expect(again.headers["retry-after"]).toBeDefined();
  });
});

describe("password reset", () => {
  it("does not reveal whether an account exists, and resets + revokes sessions", async () => {
    const user = await createUser({ password: "OldPass123" });
    const other = await client();
    await other.post("/api/auth/login").send({ identifier: user.email, password: "OldPass123" }).expect(200);

    const c = await client();
    const unknown = await c.post("/api/auth/password/forgot").send({ email: "ghost@test.local" }).expect(200);
    const known = await c.post("/api/auth/password/forgot").send({ email: user.email }).expect(200);
    expect(unknown.body).toEqual(known.body);

    const job = await latestJob("notifications", "transient");
    const token = new URL(job!.data.data.url).searchParams.get("token")!;
    await c.post("/api/auth/password/reset").send({ token, password: "NewPass456" }).expect(200);

    await other.get("/api/auth/me").expect(401); // old session revoked
    await c.post("/api/auth/login").send({ identifier: user.email, password: "OldPass123" }).expect(401);
    await c.post("/api/auth/login").send({ identifier: user.email, password: "NewPass456" }).expect(200);
    await c.post("/api/auth/password/reset").send({ token, password: "Another789" }).expect(400); // single use
  });
});
