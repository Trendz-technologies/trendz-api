# Security

How Trendz protects customer data, money and stock, and what operators have to do to keep it that way. Report suspected vulnerabilities privately to the store's technical owner. Do not open a public issue.

## 1. Secrets

| Rule | How it is enforced |
| --- | --- |
| Secrets never reach the browser | Only `NEXT_PUBLIC_*` variables are bundled into the web app: site URL, media origin and store name. The Razorpay **key id** is public by design and is served from `/api/store/config`. The key secret, webhook secret, R2 keys, SMS and email keys, JWT/OTP secrets and the database URL exist only in the API process. |
| No secrets in git | `.gitignore` excludes every `.env*` except `.env.example`. Production values are entered in the hosts' own settings: the API's on Render (`render.yaml` names them, without values), the web app's on Vercel, which holds only the API's address and the `NEXT_PUBLIC_*` values. |
| No unsafe production config | `src/config/env.ts` refuses to start with `NODE_ENV=production` if any of these apply: a mock provider (payment, SMS, shipping), `COOKIE_SECURE=false`, a missing Razorpay webhook secret or Shiprocket webhook token, missing R2 settings, placeholder JWT/OTP secrets, or identical JWT/OTP secrets. |
| A hosted database is not a public API | On Supabase the roles behind the project's public key (`anon`, `authenticated`) could by default read and write every table through Supabase's REST API. `scripts/db-lockdown.ts` revokes all their privileges and enables row level security with no policy on every table; it runs after every `npm run db:deploy` and fails the deploy if any table is still reachable. The application connects as the tables' owner over TLS; the anon and service_role keys are not used and are not stored anywhere in this project. |
| Least-privilege provider keys | Use an R2 API token scoped to the media bucket, and a separate token scoped to the backup bucket. Use a Razorpay key pair per environment, and SES/Brevo keys limited to sending. |

Rotate a secret by changing it on the Render service's Environment page; saving redeploys the API with the new value.
- Rotating `JWT_SECRET` signs everyone out at their next request. Refresh sessions survive, so users are silently re-issued tokens.
- Rotating `OTP_SECRET` invalidates outstanding OTP codes, which expire after 5 minutes anyway.

## 2. Authentication

- **Passwords** are hashed with argon2id (19 MiB, 2 iterations, OWASP baseline). They must be 8–128 characters and contain letters and digits.
  - Unknown accounts still run a dummy hash, so response timing does not reveal which emails exist.
  - The message on a forgot-password request is identical whether or not the account exists.
- **Lockout**: 5 wrong passwords lock the account for 15 minutes. Every attempt is recorded in `login_attempts`.
- **OTP**: nobody signs in with a code. A code by SMS only confirms the mobile number of an account that is already signed in (`/auth/otp` and `/auth/otp/verify` answer 401 without a session). 6-digit codes are stored only as `HMAC-SHA256(OTP_SECRET, phone:purpose:code)` and are never stored in plaintext. Each code expires after 5 minutes and allows at most 5 attempts. A resend has a 30-second cooldown, and each number has an hourly cap.
  - The SMS is sent through a transient Redis job, so the code is never written to the notifications table.
  - SMS logs mask the code.
- **Tokens**:
  - Access JWT (HS256): 15 minutes.
  - Refresh token: 30 days, rotated on every use. Only its SHA-256 hash is stored. Reusing a rotated token after a 60-second grace window revokes the whole session family, which detects token theft.
  - Password reset and email verification tokens are random, stored hashed, single-use and short-lived.
- **Cookies**: browsers get `access_token` and `refresh_token` as `HttpOnly; SameSite=Lax; Secure` (in production). The refresh cookie is scoped to `/api/auth`. Native clients (`X-Client: native`) receive tokens in the body and send `Authorization: Bearer`.
- **CSRF**: double-submit token. A readable `csrf_token` cookie must be echoed in the `X-CSRF-Token` header on every state-changing cookie-authenticated request. Bearer requests and the signed webhooks are exempt.
- **Sessions**: users can sign out everywhere. Each request loads the user's status and permissions from a 60-second cache, and that cache is cleared whenever a user's roles, status or a role's permissions change. Disabling a staff user or removing a permission therefore takes effect immediately.

## 3. Authorisation (RBAC)

- Every staff route checks a permission code (`requirePermission`). The full list is in `src/modules/rbac/permissions.ts`.
- The web admin hides what the user cannot do, but **the API is the authority**. Hiding a button is never the protection.
- Customers can only reach their own orders, addresses, returns and invoices. Ownership is checked in the service layer, and a foreign id returns 404, not 403.
- `SUPER_ADMIN` holds `*`. Only a super admin can grant `SUPER_ADMIN`, and system roles cannot be deleted.
- These sensitive POS actions need their own permissions and are written to the audit log:
  - manual discounts (`pos.manual_discount`, capped by setting)
  - selling beyond stock (`pos.override_stock`)
  - changing a SKU (`codes.manage`)

## 4. Money, stock and payments

- **The server prices everything.** The cart, checkout and POS bills are re-priced from the database inside the order transaction: tax, discounts, coupons, shipping and rounding. Prices or totals sent by the client are ignored.
- **Payments are only trusted after server verification.**
  - `/payments/verify` checks the Razorpay signature with the key secret and fetches the payment from Razorpay to confirm amount, currency and status.
  - The `payment.captured` / `order.paid` webhook is verified with `RAZORPAY_WEBHOOK_SECRET` against the raw body.
  - The browser's success callback alone never marks an order paid.
- **Idempotency**:
  - Order placement, payment creation, POS checkout, refunds and goods receipts accept an `Idempotency-Key`, and replays return the stored response.
  - Webhook events are de-duplicated by event id in `webhook_events`.
  - Payment capture uses a row lock, so the verify call and the webhook racing each other cannot double-confirm.
- **No overselling**: stock rows are locked with `SELECT … FOR UPDATE` in a fixed order, which prevents deadlocks. Stock is reserved when an order is placed and consumed only on payment. The concurrency tests in `tests/inventory.test.ts` and `checkout.test.ts` prove it.
- **Tamper-evident records**:
  - Database triggers make `inventory_transactions`, `audit_logs` and `credit_notes` append-only.
  - Issued invoices can't be edited. Corrections go through credit notes.
  - CHECK constraints keep stock buckets and money columns non-negative.

## 5. Input, output and transport

- Every request body, query and param is parsed with zod; unknown fields are stripped. Prisma parameterises all SQL, and the few raw queries use tagged templates with bound parameters.
- Product descriptions allow a small HTML subset: paragraphs, lists, emphasis, headings and `http(s)`/`mailto` links. `sanitize-html` enforces this allow-list on the API before storing (`src/common/utils/html.ts`). The storefront filters again when rendering, and JSON-LD is escaped.
- Uploads never pass through the API.
  - On Cloudinary (`STORAGE_PROVIDER=cloudinary`) the API signs an upload form instead: the signature fixes the picture's name and the allowed formats (JPEG, PNG, WebP, AVIF), and the API secret that made it stays on the server. Cloudinary does not let a signature fix the file size, so the size is checked when the upload is completed and by the plan's own limit.
  - On R2 the API issues a presigned `PUT` that is bound to the content type and exact content length, and only for JPEG, PNG, WebP or AVIF, up to 2 MB for every picture.
  - On R2 the worker re-decodes every image with sharp, which strips metadata and rejects non-images, and writes WebP/AVIF sizes. The original upload is then deleted. On Cloudinary the sizes are re-encoded by Cloudinary from the stored photo, and only those sizes are shown on the site.
  - Private objects (invoices, labels) live outside the `public/` prefix and are only served through authenticated API routes.
- Headers:
  - Helmet on the API, with `default-src 'none'` for JSON.
  - A Content-Security-Policy on the web app that allows only self, Razorpay checkout and the media origin.
  - `frame-ancestors 'none'`, and HSTS: from the API when `COOKIE_SECURE=true`, and from Vercel for the web app.
  - `Permissions-Policy` allows the camera only on the site itself, for POS scanning.
- CORS: only `WEB_URL` and `CORS_ORIGINS`. Browsers normally use same-origin `/api`.
- TLS terminates at Vercel (web app) and at Render (API). Redis accepts connections from inside Render only (`ipAllowList: []` in `render.yaml`), and the database is reached over TLS through Supabase's pooler.

## 6. Abuse controls

Per-IP and per-identity limits (Redis-backed, `rate-limiter-flexible`):

| Action | Limit |
| --- | --- |
| Sign-in | 20 per IP / 15 min, and 10 per identifier / 15 min |
| Registration | 10 per IP / hour |
| OTP request | 20 per IP / hour, plus a 30 s cooldown per number |
| OTP verify | 30 per IP / 15 min, plus 5 attempts per code |
| Password reset | 10 per IP / hour |
| Token refresh | 60 per IP / min |
| Coupon checks | 20 per IP / 5 min |
| Checkout | 30 per user (or IP) / 10 min |
| Payment creation | 20 per user (or IP) / 10 min |
| Public catalogue API | 300 per IP / min |

The per-IP limits depend on the API seeing the visitor's address, not a proxy's: `TRUST_PROXY` says how many proxies stand in front of it (3 for Vercel in front of Render; DEPLOYMENT.md → Troubleshooting says how to check). The API's own address on Render is public too. A caller that goes there directly, around Vercel, can send a forged forwarded address and so dodge the per-IP limits; the per-identifier and per-user limits and the account lockout still apply. To close that gap, have Vercel add a secret header to what it passes on and have the API refuse requests without it (Vercel's documentation: "Restricting your origin to Vercel traffic").

## 7. Audit and monitoring

- `audit_logs` records who did what, from which IP and user agent, with old and new values. It covers:
  - logins, role and permission changes
  - price, product, stock and settings changes
  - manual discounts and stock overrides
  - refunds, cancellations, invoice and credit-note issue
  - payment reconciliation
  - invalid webhook signatures

  The log is append-only and viewable under Admin → Audit logs.
- The structured logs (pino) redact `cookie`, `authorization`, `x-csrf-token` and `set-cookie` headers, and any `password`, `token`, `otp` or signature field. Request bodies are not logged.
- Card data never touches Trendz. Razorpay Checkout collects it, so PCI scope is limited to SAQ-A.

## 8. Operator checklist

- [ ] The API's environment on Render has real provider credentials. No `mock` or `console` providers, and `COOKIE_SECURE=true`.
- [ ] Random `JWT_SECRET` and `OTP_SECRET`, different from each other (`render.yaml` has Render generate them).
- [ ] No account in the hosted database has the example password from `.env.example`. A database copied from a development machine does: change the super admin's password before the site has a public address.
- [ ] The Razorpay webhook URL is `https://<domain>/api/payments/webhook`, with `payment.captured`, `payment.failed`, `order.paid` and `refund.*` events, and its secret is set.
- [ ] The Shiprocket webhook sends the `x-api-key` token equal to `SHIPPING_WEBHOOK_TOKEN`.
- [ ] The R2 media bucket is public **only** through the custom domain for `public/*`, and its CORS allows `PUT` from the site origin. The backup bucket is private.
- [ ] Change the seeded admin password after the first sign-in, and keep `SEED_ADMIN_PASSWORD` out of the Render environment (the seed is run from a developer's machine, DEPLOYMENT.md §4).
- [ ] Give staff accounts the narrowest role that fits. Review users and roles quarterly.
- [ ] The database is backed up (Supabase's free plan keeps no backups; DEPLOYMENT.md → Backups). Do a test restore every quarter.
- [ ] Review `npm audit --omit=dev` results with each release. CI reports them.
