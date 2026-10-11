# Trendz API

The API and background jobs of Trendz: an e-commerce storefront, admin panel, POS billing, inventory and GST invoicing. The web app that uses it is the [`trendz`](https://github.com/Trendz-technologies/trendz) repository.

| | |
| --- | --- |
| **Stack** | Express 5, Prisma 6 / PostgreSQL 16+, Redis + BullMQ jobs, zod: REST under `/api` |
| **Integrations** | Razorpay · Shiprocket · MSG91 · Brevo / Amazon SES / SMTP · Cloudflare R2 or Cloudinary (images). Each has a clearly separated **mock adapter for local development**. Production refuses the mock adapters. |
| **Hosting** | Render (`render.yaml`), with the web app on Vercel. See [DEPLOYMENT.md](DEPLOYMENT.md) |

What it covers:

- **Catalogue**: products with option/variant matrices, images, categories and brands.
- **Inventory**: multiple warehouses, a stock ledger, reservations, transfers, suppliers, purchase orders and goods receipts.
- **Selling**: storefront with Postgres search, cart, checkout, payments, orders, shipping, returns and refunds.
- **Documents**: GST invoices and credit notes.
- **Promotions**: coupons and automatic discounts.
- **Codes and POS**: QR/barcodes with label printing, and POS billing with USB or camera scanning.
- **Operations**: notifications, reports with CSV/Excel/PDF export, RBAC and audit logs.

Documentation:

| Doc | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, modules, critical flows, configurable business rules |
| [DATABASE.md](DATABASE.md) | Schema, constraints, triggers, numbering |
| [API.md](API.md) | Endpoints, auth, errors, idempotency |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Render and Vercel, providers, what the free plans mean, releases, backups |
| [SECURITY.md](SECURITY.md) | Threat model, controls, operator checklist |

---

## Local development

### Prerequisites

- **Node.js 22** (≥ 20.11) and npm 10
- **PostgreSQL 16+** installed locally, for example with the Windows installer, which includes **pgAdmin 4**. The app is developed against PostgreSQL 18 on port 5432.
- **Docker** (Desktop on Windows/macOS) for Redis, MinIO (R2 stand-in) and Mailpit

The local stack uses non-default ports so it can run beside other projects:

| Service | Address |
| --- | --- |
| Web | http://localhost:3100 |
| API | http://127.0.0.1:4100/api |
| PostgreSQL (local server, pgAdmin) | `127.0.0.1:5432` (user `trendz`, password `trendz_local_pw`, databases `trendz` and `trendz_test`) |
| Redis | `127.0.0.1:6390` |
| MinIO (S3 / R2 stand-in) | API http://localhost:9100 · console http://localhost:9101 (`trendz_minio` / `trendz_minio_secret`) |
| Mailpit (catches all email) | SMTP `1125` · inbox http://localhost:8125 |

### First run

```bash
npm install
npm run infra:up          # docker compose: redis, minio, mailpit

cp .env.example .env      # local defaults work as-is; set JWT_SECRET / OTP_SECRET

# once: create the trendz role and databases in your local PostgreSQL (see "Database in pgAdmin")
npm run db:migrate        # prisma migrate dev (creates the schema + extensions)
npm run storage:init      # creates the MinIO bucket, public/ read policy, CORS
npm run db:seed           # roles, permissions, warehouses, tax classes, admin + demo catalogue
```

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then run the two processes, each in its own terminal:

```bash
npm run dev           # API on :4100 (tsx watch)
npm run worker:dev    # background jobs: email/SMS, image processing, invoices, reservation expiry
```

On a slow machine, skip watch mode: `npx tsx src/server.ts` and `npx tsx src/worker.ts`. To run both in one process, as the hosted API does, set `RUN_WORKER_IN_API=true` in `.env` and start only the first.

The web app is a separate repository (`trendz`): clone it next to this one and follow its README. It expects this API on `http://127.0.0.1:4100`.

### Database in pgAdmin

The app uses the PostgreSQL server installed on this machine, so you can browse and query its data in pgAdmin.

1. **Create the role and databases** (once). In pgAdmin, right-click your PostgreSQL server, choose **PSQL Tool**, and run:
   ```
   \i '<path to this repository>/infra/postgres/local-setup.sql'
   ```
   This creates the `trendz` login (password `trendz_local_pw`, local only) and the `trendz` and `trendz_test` databases. It is safe to run again.
2. **Create the tables and data**: `npm run db:migrate`, then `npm run db:seed`.
3. **View it in pgAdmin**: the `trendz` database appears under your existing server. You can also register a separate connection: host `127.0.0.1`, port `5432`, user `trendz`. Tables are under *trendz → Schemas → public → Tables*.

The local `trendz` role is a superuser, because the test suite suspends triggers while it resets `trendz_test`. Production uses a normal role.

To use a throwaway Docker database instead, run `docker compose --profile docker-db up -d` and change `DATABASE_URL` to port `5544`.

### Signing in

| Who | How |
| --- | --- |
| Super admin | The email and password in `SEED_ADMIN_*` in `.env` (the example values are for a local machine only; DEPLOYMENT.md §4 for a hosted database) → http://localhost:3100/admin |
| Cashier / staff | Create them in Admin → Users, with the `CASHIER`, `MANAGER`, `INVENTORY_MANAGER`, `SALES_MANAGER` or `SUPPORT` role |
| Customer | Register at `/register`, then sign in with the email (or mobile number) and password. The verification email lands in Mailpit |

The demo seed adds:

- the shop's six collections as categories: Kurti Sets, Anarkali, Western Wear, Lehenga, Party Wear and Kids Wear
- 12 women's wear products with colour × size variants and images, in Western Wear and Party Wear (the other collections start empty, ready for the shop's own range)
- two warehouses: `WH-001` (online fulfilment) and `WH-002` (City Store, used for POS)
- stock, one supplier and an approved purchase order

### Image storage (R2 or Cloudinary)

Every picture the application stores (product photos, category pictures, brand logos, the home page, offer and About pictures) is kept by one service, chosen with `STORAGE_PROVIDER` in `.env`. The code is in `src/integrations/object-storage/`; the rest of the API only knows storage keys.

- **`r2`** (the default; MinIO locally): the browser uploads the file with a presigned `PUT`, the worker makes the WebP and AVIF sizes with sharp, and the upload is deleted.
- **`cloudinary`**: the browser posts the file to Cloudinary with a form the API has signed, the photo is kept there, and Cloudinary makes the same sizes from it (requested once, when the upload completes). Category, brand and content pictures are served as `f_auto,q_auto`, at most 1600px wide. No bucket to create and no worker CPU spent on resizing.
- **The API secret never reaches the browser.** It signs each upload on the server; the browser gets a signature that is good for one picture under one name.
- **One folder per environment.** `CLOUDINARY_FOLDER` (for example `trendz-dev` and `trendz`) keeps environments apart inside one Cloudinary account.
- **Where the keys go locally**: `.env.keys`, a short uncommitted file with just the keys a developer has to obtain (the Cloudinary keys, the Supabase connection strings). The API reads it together with `.env`, and a value in it wins. On Render the same names go on the service's Environment page.
- **Checking a new account**: `npm run storage:check` uploads a test picture from the server and the way a browser does, reads it back, makes the sizes and deletes it again.
- **Switching an environment that already has pictures**: set the Cloudinary values, keep the `R2_*` ones, and run `npm run storage:migrate` (a dry run; add `-- --apply` to move them). It copies the pictures to Cloudinary and updates the addresses in the database; the files on R2 / MinIO are left in place.
- **Limits**: every picture (product photos, category images, brand logos, content pictures) may be at most 2 MB, in JPEG, PNG, WebP or AVIF. The admin says so beside each upload control and refuses a larger file before sending anything; the API gives no upload ticket for a larger size (`MAX_IMAGE_BYTES` in `src/integrations/object-storage/storage.types.ts`, mirrored in `src/lib/upload.ts` (web repository)). R2 then refuses a file that is not the size the ticket was given for. Cloudinary cannot, so there the stored size is checked when the picture is put to use (a product photo's upload is completed; a category, brand or content record is saved with a new picture), and an oversized picture is refused and deleted (`src/modules/media/upload-limit.ts`).
- **Tests** always use the local MinIO bucket (`tests/setup-env.ts`), so a test run never writes to a real Cloudinary account. `tests/cloudinary.test.ts` runs the Cloudinary code against a stand-in for its API.

### Database on Supabase

The application can keep its data in a Supabase project instead of a PostgreSQL on the same machine. Supabase is used as a plain PostgreSQL server: the application has its own sign-in and does not use Supabase Auth, Storage or its REST API.

- **Connection**: `DATABASE_URL` in `.env` is the **session pooler** string (Supabase → Connect, port 5432) ending in `?schema=public&connection_limit=5&connect_timeout=30`. The API and the worker are long-running processes, which is what the session pooler is for; the transaction pooler (port 6543) is not used. Supabase's anon key, service_role key and JWT secret are not needed.
- **Creating the tables**: `npm run db:deploy` applies the committed migrations (it only ever adds) and then runs `scripts/db-lockdown.ts`.
- **The tables are closed to Supabase's own REST API.** By default the roles behind a Supabase project's public key may read and write every table in `public`. The lock-down takes every privilege away from them and switches row level security on for every table, with no policy; the application signs in as the tables' owner and is not affected. It runs after every `db:deploy`, so tables added later are covered, and does nothing on a PostgreSQL that is not Supabase.
- **Writing a new migration**: `npm run db:migrate` never runs `prisma migrate dev` against a hosted database (that command can ask to wipe a database that does not match). When `DATABASE_URL` is not a local address it uses `LOCAL_DATABASE_URL`, the PostgreSQL on this machine; apply the result to Supabase with `npm run db:deploy`.
- **Tests never touch it.** They run against `trendz_test` on the local PostgreSQL (`tests/setup-env.ts`), and the helper that empties the tables refuses any database whose name does not end in `_test`.
- **Free plan**: a project is paused after about a week without activity (resume it in the Supabase dashboard), and backups are not included; see DEPLOYMENT.md before using it for the live shop.

### Customer reviews

Customers rate and review products they have received.

- **Who can review**: a signed-in customer with a delivered order that contains the product. That makes every review a verified purchase. One review per customer and product; they can edit or remove it.
- **Where**: "Write a review" appears on each item of a delivered order (Account → Orders), on Account → Reviews (which lists delivered products still waiting for a review) and on the product page. The "order delivered" email and notification invite the customer to review.
- **Product page**: average rating, a breakdown by stars and the reviews, with the customer's first name and last initial only. The average is also in the page's structured data for search engines.
- **Moderation**: Admin → Reviews (permissions `reviews.read` and `reviews.moderate`; store manager, sales manager and support have them by default). Staff publish, reject (with an internal note) or delete; the customer is notified either way and can edit a rejected review and send it again.
- **Two settings**, Admin → Settings → Reviews: switch reviews on or off, and whether a review needs approval before it is shown (default: it does).
- After pulling this change run `npm run db:migrate` (new `product_reviews` table) and `npm run db:seed` (registers the two permissions and grants them to the system roles above).

### Development adapters (no credentials needed)

| Integration | Local adapter | What it does |
| --- | --- | --- |
| Payments | `PAYMENT_PROVIDER=mock` | A "Test payment" dialog replaces Razorpay Checkout. The server still verifies HMAC signatures and processes signed webhooks through the real pipeline. |
| SMS | `SMS_PROVIDER=console` | Logs the message to the API console. OTPs are masked in `sms_logs`. |
| Email | `EMAIL_PROVIDER=smtp` → Mailpit | Real SMTP delivery to a local inbox |
| Shipping | `SHIPPING_PROVIDER=mock` | Creates AWBs and labels. Admin → Order → "Simulate next courier status" walks a shipment through the lifecycle. |
| Storage | MinIO (`STORAGE_PROVIDER=r2`) | The same S3 API calls the app makes against Cloudflare R2 |

### Switching to real providers

Set the variables in `.env` (all documented in `.env.example`) and restart the API and worker.

| Provider | Variables / steps |
| --- | --- |
| **Razorpay** | `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. For local webhooks, expose port 4100 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:4100`) and register `<tunnel>/api/payments/webhook`. |
| **Cloudflare R2** | `R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` (custom domain), `R2_FORCE_PATH_STYLE=false`. Set the bucket's CORS policy to allow `PUT`, `GET` and `HEAD` from the site's address, and set `NEXT_PUBLIC_MEDIA_ORIGIN` in the web env. |
| **Cloudinary** (instead of R2) | `STORAGE_PROVIDER=cloudinary` and `CLOUDINARY_URL` (the one line the Cloudinary console shows under Settings → API Keys) or `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`; `CLOUDINARY_FOLDER` (one folder per environment). In the web env set `NEXT_PUBLIC_MEDIA_ORIGIN="https://res.cloudinary.com https://api.cloudinary.com"` and rebuild the web app. Then `npm run storage:check`, and `npm run storage:migrate` to move pictures that are already on R2 / MinIO. See "Image storage" above. |
| **MSG91** | `SMS_PROVIDER=msg91`, `SMS_API_KEY`, `SMS_SENDER_ID`, and `SMS_TEMPLATE_OTP/ORDER/SHIPPING` (DLT template ids; texts in `src/integrations/sms/sms.types.ts`) |
| **Brevo** | `EMAIL_PROVIDER=brevo`, `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS` (a verified sender) |
| **Amazon SES** | `EMAIL_PROVIDER=ses`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| **Shiprocket** | `SHIPPING_PROVIDER=shiprocket`, `SHIPPING_API_KEY` (API user email), `SHIPPING_API_SECRET` (password), `SHIPPING_PICKUP_LOCATION`, `SHIPPING_WEBHOOK_TOKEN` |

Check delivery from Admin → Notifications → **Send test**.

### Business rules to confirm

Money, tax and stock rules are **settings**, not code: Admin → Settings and Admin → Settings → Tax classes. The seeded values are examples only, and the store owner or accountant must confirm them:

- store legal name, GSTIN and state
- whether prices include GST
- the apparel tax slab
- flat shipping fee and free-shipping threshold
- reservation timeout
- return window
- POS manual-discount cap
- coupon stacking
- whether customer reviews need approval before they are shown
- invoice prefixes

ARCHITECTURE.md §7 lists every configurable rule and its default.

## Testing

```bash
npm run test          # vitest + supertest against the trendz_test DB, Redis DB 1 and MinIO
npm run lint
npm run typecheck
```

The suite resets the test database between tests and covers:

- auth, RBAC, catalogue and codes
- pricing and tax
- **concurrent stock allocation (no overselling)**
- checkout, idempotent payments and webhooks
- reservations, refunds and credit notes
- returns, shipping and POS
- reports

CI (`.github/workflows/ci.yml`) runs the same suite on every push to `main` and on pull requests.

## Useful scripts

| Command | What it does |
| --- | --- |
| `npm run infra:up` / `infra:down` | Start / stop the local Docker services |
| `npm run dev` / `worker:dev` | The API and the job worker in watch mode |
| `npm run build`, then `npm start` / `npm run start:worker` | Compile to `dist/` and run the compiled API / worker |
| `npm run db:migrate` | Create and apply a migration in development (`prisma migrate dev`), always against a PostgreSQL on this machine |
| `npm run db:deploy` | Apply committed migrations only (what the hosted build runs), then close the tables to Supabase's REST API when the database is on Supabase |
| `npm run db:seed` | Seed core data, plus demo data outside production |
| `npm run db:studio` | Prisma Studio |
| `npm run storage:init` / `storage:check` / `storage:migrate` | Create the local bucket / test an image storage account / move pictures from R2 to Cloudinary |

## Repository layout

```
src/modules/<domain>   routes · service · schemas per business module
src/integrations/      razorpay · shipping · sms · email · object-storage (each with a mock/ adapter)
src/jobs/              BullMQ queues, job definitions and the runner that starts them
src/server.ts          the API (and the jobs too when RUN_WORKER_IN_API=true)
src/worker.ts          the jobs as a process of their own
prisma/                schema, migrations (with CHECK constraints and triggers), seeds
scripts/               database and image storage tools
tests/                 integration tests
infra/                 local PostgreSQL setup, backup and restore scripts
render.yaml            the hosted API on Render
docker-compose.yml     local Redis, MinIO and Mailpit
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Can't reach database server` | Check that the PostgreSQL service is running (Windows Services → `postgresql-x64-18`) and that `infra/postgres/local-setup.sql` has been run. Use `127.0.0.1` rather than `localhost`. |
| Port already in use | Another project is using 4100 or the Docker ports. Change the port mapping in `docker-compose.yml` and the matching URLs in `.env` (and in the web app's `.env.local`). |
| Images stay "Processing" | The worker is not running (`npm run worker:dev`), or MinIO is down |
| No verification email or SMS | Email: check Mailpit at http://localhost:8125. SMS: check the API console output. |
| Prisma client out of date after pulling | `npm run db:generate` |
| API requests hang, or `docker` commands stop responding | Docker Desktop has stalled. Restart it, then run `npm run infra:up`. The API fails fast on a stalled Redis (1.5 s command timeout) and falls back to the database. |
