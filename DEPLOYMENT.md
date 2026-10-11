# Deployment: Vercel (web) and Render (API)

Trendz is two repositories and two hosts:

| Part | Repository | Host | What it runs |
| --- | --- | --- | --- |
| Web app (storefront, admin, POS) | `trendz` | Vercel | Next.js. Passes every `/api/*` request on to the API |
| API and background jobs | `trendz-api` (this one) | Render | Express, with the BullMQ jobs in the same process, and a Key Value (Redis) instance |
| Database | | Supabase | PostgreSQL |
| Pictures | | Cloudinary | |

```
visitor ──► Vercel  (https://<site>)
              │  /api/*  (rewrite, so cookies stay first-party)
              ▼
            Render  (https://<api>.onrender.com) ──► Supabase · Cloudinary
              └─ Key Value (queues, rate limits, cache)      Razorpay · Shiprocket · MSG91 · Brevo
```

The browser only ever talks to the Vercel address. Nothing secret is set on Vercel: every key lives on Render.

Both hosts deploy the `main` branch on every push. `render.yaml` in this repository describes the Render side; the web repository has a `vercel.json`.

---

## 1. Before the first deploy

**The API refuses to start in production** (`NODE_ENV=production`, which `render.yaml` sets) when any of these apply. This is deliberate and there is no switch to turn it off:

- the mock payment gateway, the console SMS sender or the mock shipping provider is selected
- `COOKIE_SECURE` is not `true`
- Razorpay is selected without its keys and webhook secret, or Shiprocket without its webhook token
- the image storage settings are missing
- the JWT / OTP secrets are placeholders, or the same value

**A shop that has no Razorpay or Shiprocket account yet starts without them**, and that is how `render.yaml` is set: `PAYMENT_PROVIDER=none` and `SHIPPING_PROVIDER=none`. Nothing is simulated in their place:

- **No payment gateway**: the shop takes no online orders. The storefront shows the catalogue and the bag; at checkout it says that online ordering is not open yet (with the shop's WhatsApp link) and the API refuses the order, so no stock is ever held for an order nobody can pay. The billing counter (`/pos`) works with cash and UPI.
- **No courier service**: staff enter a shipment by hand (courier and tracking number).

So the least the first deploy needs is:

| What | Why | Where to get it |
| --- | --- | --- |
| A Supabase project | Database | §2 |
| Cloudinary keys | Pictures | Cloudinary console → Settings → API Keys |

Razorpay, Shiprocket, MSG91 and Brevo are connected later (§6). Until MSG91 and Brevo have keys, sending an SMS or an email fails with the provider's error (shown under Admin → Notifications).

**Two rules, because the repositories are public:**

1. No secret goes into a file that git tracks. Values go into the Render and Vercel dashboards.
2. No hosted database may contain an account with the example password from `.env.example`. A database copied from a developer's machine does (the seeded super admin). Change that password in the app (Account → Profile) before the site has a public address, or use a new database (§2) and seed it as in §4.

## 2. Database (Supabase)

Use **a project of its own for the hosted site**, not the one a developer's machine points at. Three reasons:

- The jobs that run every minute (releasing unpaid orders, sending queued notifications) would otherwise run from both places against the same rows, and a notification could be sent twice.
- Test orders would mix with real ones.
- The session pooler allows a fixed number of clients per database user (15 on the smallest size; Database → Connection pooling shows the figure). Every process takes up to 5 (`connection_limit`), and each deploy's build connects as well while the previous instance is still up, so a shared project runs into "max clients reached".

1. Create the project in the region closest to the API: Singapore (`ap-southeast-1`) for the Render region in `render.yaml`. Keep the database password.
2. Copy the **session pooler** string (Connect → Session pooler, port 5432) and add `?schema=public&connection_limit=5&connect_timeout=30` to it. This is `DATABASE_URL`. The transaction pooler (port 6543) is not used, and the direct address is IPv6 only.
3. Nothing else: the first deploy creates the tables (`npm run db:deploy` in the build command) and closes them to Supabase's own REST API (`scripts/db-lockdown.ts`).

Never run `prisma migrate dev`, `prisma db push` or `prisma migrate reset` against it. `npm run db:migrate` refuses a hosted database by design.

## 3. API on Render

1. Render → **New → Blueprint** → connect the `trendz-api` repository. Render reads `render.yaml` and shows two things to create: the web service `trendz-api` and the Key Value instance `trendz-redis`, both on the free plan in Singapore.
2. Render asks for the values that are not in the file:

   | Value | What to enter |
   | --- | --- |
   | `WEB_URL` | The web app's address, for example `https://trendz.vercel.app`, without a trailing slash. It must be an address, so enter the one you plan to use; correct it after §5 if it turns out different |
   | `DATABASE_URL` | The string from §2 |
   | `CLOUDINARY_URL` | `cloudinary://<api key>:<api secret>@<cloud name>` |
   | `CLOUDINARY_FOLDER` | The folder in the Cloudinary account that this database's pictures are in. A new database: `trendz`. A database copied from a development machine: the folder that machine used (`CLOUDINARY_FOLDER` in its `.env`), otherwise none of its pictures show |
   | `RAZORPAY_*`, `SHIPPING_*`, `SMS_*`, `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS` | Leave empty until the accounts exist (§6) |

   `JWT_SECRET` and `OTP_SECRET` are generated by Render. `REDIS_URL` is filled in from the Key Value instance.
3. Apply. The build installs, compiles, applies the migrations and starts the API. It is up when `https://<api>.onrender.com/api/health/ready` answers `{"database":"up","redis":"up"}`.

If the deploy fails with "Unsafe production configuration" or "Invalid environment configuration", the log lists exactly which values to fix (Render → the service → Environment).

The values Render asked for are changed later on the service's Environment page. The values written in `render.yaml` (`TRUST_PROXY`, the provider names, …) are changed in the file: Render puts the file's value back every time it syncs the Blueprint.

Environments with databases of their own use a Cloudinary folder each (`trendz` for the live shop, `trendz-dev` for development), so their pictures stay apart.

## 4. The first admin

A new database has no users. Render's free plan has no shell, so the seed is run once **from a developer's machine** against the hosted database. It creates the roles, permissions, default warehouse, tax classes and one super admin, and no demo products:

```powershell
# PowerShell, in this repository's folder, set up as in README.md (local .env, Docker services running)
$env:DATABASE_URL = "<the string from §2>"
$env:SEED_DEMO = "false"
$env:SEED_ADMIN_EMAIL = "owner@example.com"
$env:SEED_ADMIN_PASSWORD = "<12 or more characters, not the example value>"
npm run db:seed
```

Close that terminal afterwards so the values do not stay in it. Sign in at `https://<site>/login` and change the password. Do not put `SEED_ADMIN_PASSWORD` on Render.

The seed is safe to run again: it never creates a second super admin and leaves roles a shop has edited alone. Run it again after a release that adds permissions.

## 5. Web app on Vercel

1. Vercel → **Add New → Project** → import the `trendz` repository. Vercel recognises Next.js; leave the build settings as they are.
2. Environment variables (all environments):

   | Name | Value |
   | --- | --- |
   | `API_INTERNAL_URL` | The API's address on Render, `https://<api>.onrender.com`, without a trailing slash |
   | `NEXT_PUBLIC_SITE_URL` | The site's own address, `https://<site>` |
   | `NEXT_PUBLIC_MEDIA_ORIGIN` | `https://res.cloudinary.com https://api.cloudinary.com` |
   | `NEXT_PUBLIC_STORE_NAME` | `Trendz Women's Wear` |

3. Deploy. Then make sure `WEB_URL` on Render is this site's address (it is used for the links in emails).

All four values are fixed when the web app is built: after changing one, redeploy (Vercel → Deployments → Redeploy). Without `NEXT_PUBLIC_MEDIA_ORIGIN` the page's Content-Security-Policy blocks every picture and upload.

`vercel.json` in the web repository does two things: it runs the server-side code in Singapore, next to the API, and it stops Vercel's CDN from keeping copies of `/api/*` answers.

## 6. Providers

The keys go on the Render service's Environment page; saving redeploys the API. Razorpay and Shiprocket are also switched on in `render.yaml`, in this order: enter the keys on the Environment page, then change `PAYMENT_PROVIDER` to `razorpay` (or `SHIPPING_PROVIDER` to `shiprocket`) in the file and push. The other way round the API refuses to start, because the provider is selected and its keys are missing.

| Provider | In the provider's dashboard | On Render |
| --- | --- | --- |
| **Razorpay** | Use **live** keys for a shop that takes money; test-mode keys while trying it out (no money moves, and the server still verifies every signature). Add a webhook at `https://<site>/api/payments/webhook` with the events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed` and `refund.failed`, and set a webhook secret | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| **Shiprocket** | Create an API user. Configure the pickup location (its nickname goes in `SHIPPING_PICKUP_LOCATION`). Set the tracking webhook to `https://<site>/api/shipping/webhook` with the header `x-api-key: <SHIPPING_WEBHOOK_TOKEN>` | `SHIPPING_API_KEY` (email), `SHIPPING_API_SECRET` (password), `SHIPPING_WEBHOOK_TOKEN` |
| **MSG91 (SMS)** | Register a DLT entity, sender id and templates for the OTP, order and shipping messages: the three texts in `src/integrations/sms/sms.types.ts`, with the same variable names (`otp`, `minutes`, `order`, `message`, `status`, `url`) | `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_TEMPLATE_*` |
| **Brevo (email)** | Verify the sending domain and publish its SPF, DKIM and DMARC records | `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS` (a verified sender) |
| **Cloudinary** | Nothing to set up: no bucket, CORS rule or upload preset. Leave "Strict transformations" off (the default) | `CLOUDINARY_URL`, `CLOUDINARY_FOLDER` |

Render's free plan blocks outgoing SMTP, which is why `render.yaml` selects Brevo's web API. Amazon SES (`EMAIL_PROVIDER=ses` and the `AWS_*` values) also works.

Then confirm in **Admin**: Notifications → **Send test** for email and SMS, place a ₹1 test order, create a test shipment.

**Business settings** (Admin → Settings) are configurable rather than hard-coded. Have the store owner and accountant confirm them before launch: store legal name, GSTIN and state; tax classes and rates; whether prices include tax; shipping rates; return window; POS discount cap; invoice prefixes.

## 7. What the free plans mean

Render describes its free instances as not for production applications, and Vercel's Hobby plan is for personal, non-commercial use. They are fine for showing and testing the shop. For a shop that takes orders, these are the limits that matter:

**Render (API)**

- **It sleeps after 15 minutes without a request** and takes about a minute to wake. The first visitor after a quiet spell waits, and may see an error once.
- **No job runs while it sleeps.** They catch up when the next request wakes it. The two that touch stock and money are `orders.expire-unpaid` (every minute: gives back the stock held by an order that was never paid) and `payments.reconcile` (every 10 minutes: confirms a payment whose webhook was missed). Overnight, stock can stay held and a paid order can stay unconfirmed for hours. Emails and SMS, shipment tracking and the daily clean-ups wait the same way.
- A Razorpay or Shiprocket webhook that arrives while it sleeps meets that one-minute wake. Razorpay retries, and `payments.reconcile` and `shipments.sync` pick up what was missed.
- **The Key Value instance keeps everything in memory.** A restart empties it: queued jobs are queued again from the database by the sweep jobs, rate-limit counters start again. It holds 25 MB.
- 750 free instance hours a month for the whole account, which is one service awake all month. No shell, no outgoing SMTP.
- An external monitor that requests `https://<api>.onrender.com/api/health` every 10 minutes keeps it awake, at the price of using all of the month's free hours.

A paid Render instance removes the first three points and is the first thing to change (ARCHITECTURE.md §9).

**Supabase (database)**: a free project is paused after about a week without activity, which takes the shop offline until someone resumes it in the dashboard, and it keeps **no backups** (§9).

**Vercel (web)**: the Hobby plan has no Skew Protection, so a browser tab left open across a deploy may need a reload.

## 8. Releasing changes

Push to `main`. Render rebuilds the API and Vercel the web app, each from its own repository. When a change needs both, release the API first, so the web app never asks for something the API does not have yet.

The API's build applies new migrations with `prisma migrate deploy`, which applies committed migrations only and never resets, drops or pushes the schema.

- Never run `prisma migrate reset`, `prisma db push` or `--accept-data-loss` against the hosted database.
- The previous release keeps serving until the new one is ready, so every migration must work with the **previous** code: add columns as nullable or with defaults, backfill in a job, remove or rename only in a later release (expand → deploy → contract).
- Destructive data changes need an explicit, reviewed migration and a fresh backup.
- A new migration is written on a developer's machine (`npm run db:migrate`, against the local PostgreSQL) and committed.

`.github/workflows/ci.yml` runs lint, typecheck, the test suite and the build on every push and pull request. Render does not wait for it unless the service's auto-deploy is set to "After CI Checks Pass".

## 9. Backups

Supabase's free plan has none. Either move the project to a paid plan (daily backups; point-in-time recovery as an add-on) or run `infra/scripts/backup-postgres.sh` on a schedule from a machine you control. It uses `pg_dump` (which must be at least the Supabase PostgreSQL version), verifies the dump, and can upload it to a private S3-compatible bucket; the settings are listed at the top of the script, read from the file named by `BACKUP_CONFIG`. `restore-postgres.sh` restores a dump into a new database and never touches the live one.

Pictures are on Cloudinary. Redis holds only queues, counters and cache; nothing in it needs a backup.

Rehearse a restore every quarter.

## 10. Monitoring and troubleshooting

- **Uptime**: point an external monitor at `https://<api>.onrender.com/api/health/ready` (database and Redis) and at the home page.
- **Logs**: Render → the service → Logs (structured JSON; secrets are redacted). Vercel → the project → Logs.
- **In the app**: Admin → Notifications shows failed emails and SMS with retry; Admin → Payments → Reconcile resolves a stuck payment; the dashboard shows low stock and pending orders.

| Symptom | Check |
| --- | --- |
| Render deploy fails: "Unsafe production configuration" | The log lists what to fix on the Environment page (§1) |
| Render deploy fails during `db:deploy` | `DATABASE_URL`: it must be the session pooler string with the query string from §2 |
| The site loads, every API call fails or the first one after a pause is slow | The API is asleep or not deployed. Open `https://<api>.onrender.com/api/health`. Check `API_INTERNAL_URL` on Vercel, then redeploy the web app |
| Pictures do not show, uploads are refused by the browser | `NEXT_PUBLIC_MEDIA_ORIGIN` on Vercel, then redeploy |
| Signing in works, the next request is signed out | `COOKIE_DOMAIN` must stay empty: the cookies belong to the Vercel address |
| "Too many requests" for everyone at once, or the wrong IP in Admin → Audit logs | `TRUST_PROXY`. Sign in and look at the newest row in Admin → Audit logs: it should show your own public IP address. If it shows another, change `TRUST_PROXY` in `render.yaml` by one (3 → 2 or 4) and push |
| The site works but no product, category or banner picture shows | `CLOUDINARY_FOLDER` on Render is not the folder this database's pictures are in (§3) |
| Payments stuck "pending" | The webhook address and secret in Razorpay; Admin → Payments → Reconcile |
| Pictures stay "Processing" | The jobs are not running: `RUN_WORKER_IN_API` must be `true` on Render. Then `npm run storage:check` from a developer's machine with the same Cloudinary values |
| Emails or SMS not arriving | Admin → Notifications: failed rows show the provider's error. Check SPF/DKIM and the DLT templates |
| Jobs stop, Redis errors about memory in the log | The 25 MB Key Value instance is full (it never evicts, because the queues need every key). Restart it in Render, or move it to a paid plan |

## 11. Other hosts

Nothing in the code is tied to Render or Vercel. On a host with a background worker, run the jobs as their own process (`npm run start:worker`) and leave `RUN_WORKER_IN_API` empty. The original combined repository's history holds a complete single-server setup (Nginx, PM2, provisioning, deploy and rollback scripts for one Ubuntu machine) that was written before the split.
