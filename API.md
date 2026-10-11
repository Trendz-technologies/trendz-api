# API

Base path: `/api`. JSON in, JSON out (except PDFs, images and exports).

## Conventions

**Success**

```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 } }
```

**Error** (centralized handler, no stack traces in production)

```json
{ "success": false, "message": "Only 2 units of TSH-RED-M-001 are available", "code": "OUT_OF_STOCK", "errors": [] }
```

| HTTP | `code` examples |
|---|---|
| 400 | `VALIDATION_ERROR` (with `errors: [{ path, message }]`), `BAD_REQUEST` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `CSRF_INVALID`, `ACCOUNT_LOCKED` |
| 404 | `NOT_FOUND`, `CODE_NOT_FOUND` |
| 409 | `CONFLICT`, `OUT_OF_STOCK`, `DUPLICATE_SKU`, `IDEMPOTENCY_CONFLICT`, `INVALID_STATE` |
| 422 | `COUPON_INVALID`, `PAYMENT_VERIFICATION_FAILED` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |

**Not found as 200** — a `GET` sent with `X-Not-Found-Status: 200` receives a
404 as HTTP 200 with the same error body. The storefront's server-side fetches
use it: their page cache (Next.js) only replaces a stored response with a 200,
so with a plain 404 a deleted product or category would stay on the site.

**Rich text** — the admin's description fields (product `description` and
`shortDescription`; `description` of a category, brand, discount, role, tax
class and warehouse location) take HTML from its rich text editor. The API
stores an allow-list only (`p br strong b em i u s ul ol li h3 h4 blockquote a
span`, links limited to http, https and mailto) and returns that HTML. Length
limits count the text, not the markup. An empty editor is stored as `null`.

**Authentication** — httpOnly cookies `access_token` (15 min JWT) and
`refresh_token` (rotating, 30 days, stored hashed). `POST /api/auth/refresh`
rotates both.

**CSRF** — state-changing requests authenticated by cookie must send header
`X-CSRF-Token` matching the `csrf_token` cookie (double-submit). Webhooks are
exempt and verified by signature instead.

**Idempotency** — `POST /api/orders`, `POST /api/payments/create`,
`POST /api/refunds`, `POST /api/returns/:id/refund` and `POST /api/pos/carts/:id/checkout` require an
`Idempotency-Key` header (UUID). A retry with the same key returns the original
response; reusing the key with a different body returns `409 IDEMPOTENCY_CONFLICT`.

**Pagination** — `?page=1&limit=20` (max 100). **Money** — integer paise.

**Permissions** — admin endpoints list the required permission in brackets.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/health/ready` | PostgreSQL + Redis readiness |

## Auth — `/auth`

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/csrf` | Issues CSRF cookie + token |
| POST | `/auth/register` | Email + password (+ optional phone). Sends verification email |
| POST | `/auth/login` | Email or phone + password. Rate limited, lockout after repeated failures |
| POST | `/auth/otp` | Signed in: send a 6-digit code by SMS to `{ phone }`, to confirm that number on the account. Rate limited. 401 without a session |
| POST | `/auth/otp/verify` | Signed in: `{ phone, code }` marks the number as verified on the account. A code never signs anyone in: sign-in is by password, and `purpose: "LOGIN"` is answered with 400 |
| POST | `/auth/refresh` | Rotate tokens (reuse detection revokes the session) |
| POST | `/auth/logout` | Revoke current session |
| POST | `/auth/logout-all` | Revoke all sessions |
| GET | `/auth/me` | Current user, roles, permissions |
| POST | `/auth/verify-email/request` | Resend verification email |
| POST | `/auth/verify-email/confirm` | `{ token }` |
| POST | `/auth/password/forgot` | Always 200 (no account enumeration) |
| POST | `/auth/password/reset` | `{ token, password }` — revokes all sessions |
| POST | `/auth/password/change` | `{ currentPassword, newPassword }` |

## Storefront (public) — `/store`

| Method | Path | Notes |
|---|---|---|
| GET | `/store/config` | Public settings (currency, free-shipping threshold, payment key id), the saved theme (`appearance`), the home page offers block (`homeOffers`, null while switched off) and the CMS content: `home` (home page sections), `contact` (contact details), `pages` (slug and title of each published legal page) and `aboutPublished` (whether the About us page is shown). Sent with `Cache-Control: no-cache`, so browsers revalidate it on every use |
| GET | `/store/pages/:slug` | A published legal page (`terms`, `privacy`): `{ slug, title, body, updatedAt }`, title and body in English and Tamil, body as sanitised HTML. 404 while it is a draft |
| GET | `/store/about` | The About us page: `{ eyebrow, title, intro, body, imageUrl, updatedAt }`, text in English and Tamil, body as sanitised HTML, `imageUrl` null while it has no picture. 404 while it is switched off |
| GET | `/store/products` | `q, category, brand, minPrice, maxPrice, inStock, sort (newest\|price_asc\|price_desc\|name\|relevance), page, limit` |
| GET | `/store/products/:slug` | Product detail with variants, options, images, availability |
| GET | `/store/search/suggest` | `q` — top matches by name / SKU |
| GET | `/store/categories` | Active category tree |
| GET | `/store/categories/:slug` | Category + breadcrumbs |
| GET | `/store/brands` | Active brands |
| GET | `/store/coupons` | Public active coupons |
| GET | `/store/sitemap` | Slugs + timestamps for `sitemap.xml` |

## Customer account — `/account` (authenticated)

| Method | Path |
|---|---|
| GET, PATCH | `/account/profile` |
| GET, POST | `/account/addresses` |
| PATCH, DELETE | `/account/addresses/:id` |
| GET | `/account/orders` |
| GET | `/account/orders/:orderNumber` |
| POST | `/account/orders/:orderNumber/cancel` |
| GET | `/account/orders/:orderNumber/invoice.pdf` |
| GET | `/account/orders/:orderNumber/tracking` |
| GET, POST | `/account/returns` |
| GET | `/account/returns/:returnNumber` |
| GET, POST | `/account/wishlist` |
| DELETE | `/account/wishlist/:productId` |
| GET | `/account/reviews` — the customer's reviews, and delivered products not reviewed yet |
| GET | `/account/reviews/product/:productId` — may I review it, and my review if I wrote one |
| PUT, DELETE | `/account/reviews/product/:productId` — body `{ rating: 1–5, title?, comment? }` |
| GET | `/account/notifications` |
| POST | `/account/notifications/:id/read` |
| GET | `/account/sessions` |
| DELETE | `/account/sessions/:id` |

## Reviews

A customer may review a product once an order containing it has been delivered
(`403 REVIEW_NOT_ELIGIBLE` otherwise), so every review is a verified purchase.
There is one review per customer and product; saving again replaces it and
sends it back through moderation. Two settings in the `reviews` group decide
the rest: `enabled` (off: `403 REVIEWS_DISABLED`, and nothing is shown) and
`requireApproval` (on: a review is `PENDING` until staff publish it; off: it
is `PUBLISHED` at once).

| Method | Path | Notes |
|---|---|---|
| GET | `/store/products/:slug/reviews` | Public. Published reviews with `summary { average, count, distribution }`. Query: `sort` (newest | highest | lowest), `page`, `limit` (max 50). Reviews carry a display name such as "Asha R.", never an email or phone |
| GET | `/reviews` | reviews.read — moderation queue. Query: `status` (PENDING | PUBLISHED | REJECTED), `rating`, `productId`, `q`; `meta.counts` has the totals per status |
| POST | `/reviews/:id/moderate` | reviews.moderate — `{ action: "publish" | "reject", note? }`. The note is internal. The customer gets an in-app notification |
| DELETE | `/reviews/:id` | reviews.moderate |

## Cart & checkout

| Method | Path | Notes |
|---|---|---|
| GET | `/cart` | Server-priced cart with stock warnings |
| POST | `/cart/items` | `{ variantId, quantity }` |
| PATCH | `/cart/items/:itemId` | `{ quantity }` |
| DELETE | `/cart/items/:itemId` | |
| DELETE | `/cart` | Clear |
| POST | `/cart/coupon` | `{ code }` |
| DELETE | `/cart/coupon` | |
| POST | `/checkout/quote` | `{ shippingAddressId, couponCode? }` → full server-side breakdown |
| POST | `/orders` | Place order from cart (Idempotency-Key). Reserves stock |

## Payments

| Method | Path | Notes |
|---|---|---|
| POST | `/payments/create` | `{ orderId }` → Razorpay order (Idempotency-Key) |
| POST | `/payments/verify` | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` |
| POST | `/payments/webhook` | Razorpay webhook (raw body, `X-Razorpay-Signature`) |
| POST | `/payments/mock/complete` | **Development only** — simulates the Razorpay checkout popup |
| GET | `/payments` | [payments.read] |
| GET | `/payments/:id` | [payments.read] |
| POST | `/payments/:id/reconcile` | [payments.manage] Re-fetch status from Razorpay |

## Catalog administration

| Method | Path | Permission |
|---|---|---|
| GET, POST | `/products` | products.read / products.write |
| GET, PUT, DELETE | `/products/:id` | products.read / products.write / products.delete |
| POST | `/products/:id/images/upload-url` | products.write — an upload ticket (see below) |
| POST | `/products/:id/images/:imageId/complete` | products.write — checks the file arrived and queues the sizes |
| PATCH, DELETE | `/products/:id/images/:imageId` | products.write |
| POST | `/products/:id/images/:imageId/replace` | products.write — an upload ticket for the new file |
| PUT | `/products/:id/images/order` | products.write |
| GET, POST | `/categories` | categories.read / categories.write |
| PUT, DELETE | `/categories/:id` | categories.write |
| PUT | `/categories/reorder` | categories.write |
| GET, POST | `/brands` · PUT, DELETE `/brands/:id` | brands.* |
| GET, POST | `/tax-classes` · PUT, DELETE `/tax-classes/:id` | settings.write |
| POST | `/uploads/presign` | category / brand images; `purpose: "content"` for home page pictures: offers and the banner (settings.write) |

**Upload tickets.** `upload-url`, `replace` and `/uploads/presign` answer with a one-time permission for the browser to send the file straight to image storage: `{ uploadUrl, method, headers, fields? }`.

- Without `fields` (R2 / MinIO): `PUT` the file to `uploadUrl` with `headers`; the content type and exact size are part of the signature.
- With `fields` (Cloudinary): `POST` a multipart form to `uploadUrl` with every field, then the file in a field named `file`. The fields hold a signature for that one picture; changing any of them makes Cloudinary refuse the upload.

`/uploads/presign` also returns `key` (saved on the category, brand or content setting) and `publicUrl`.

**Size limit.** Every picture may be at most 2 MB. A request for a ticket states the file's `size`; a larger size is answered with 400 "Images must be at most 2 MB". On Cloudinary, which does not hold an upload to the stated size, the stored size is checked on `complete` and when a category, brand or content setting is saved with a new picture: an oversized picture is deleted and the request answered with 400, code `IMAGE_TOO_LARGE`.

## Product codes, scanning & labels

| Method | Path | Permission |
|---|---|---|
| GET | `/products/code/:code` | pos.use or inventory.read |
| POST | `/products/scan` | pos.use or inventory.read — `{ code, warehouseId }` |
| GET | `/products/:id/codes` | products.read |
| POST | `/variants/:variantId/codes` | codes.manage — generate (`{ type }`) or assign (`{ type, value }`) |
| PATCH | `/codes/:id` | codes.manage — activate / deactivate |
| POST | `/codes/:id/regenerate` | codes.manage |
| GET | `/codes/:id/image` | products.read — `?format=png\|svg` |
| POST | `/codes/bulk-generate` | codes.manage — `{ variantIds\|productIds, types }` |
| POST | `/codes/labels` | products.read — PDF label sheet (A4 grid or label roll) |

## Inventory, warehouses, suppliers, purchasing

| Method | Path | Permission |
|---|---|---|
| GET | `/inventory` | inventory.read — levels with filters |
| GET | `/inventory/variants/:variantId` | inventory.read — per-warehouse breakdown |
| GET | `/inventory/transactions` | inventory.read — ledger |
| GET | `/inventory/low-stock` | inventory.read |
| POST | `/inventory/adjust` | inventory.adjust |
| GET, POST | `/inventory/transfers` | inventory.read / inventory.transfer |
| GET | `/inventory/transfers/:id` | inventory.read |
| POST | `/inventory/transfers/:id/dispatch` · `/receive` · `/cancel` | inventory.transfer |
| GET, POST | `/warehouses` · PUT `/warehouses/:id` | warehouses.* |
| GET, POST | `/warehouses/:id/locations` · PUT, DELETE `/warehouses/:id/locations/:locationId` | warehouses.write |
| GET, POST | `/suppliers` · GET, PUT `/suppliers/:id` | suppliers.* |
| GET | `/suppliers/:id/purchase-history` | suppliers.read |
| GET, POST | `/purchase-orders` · GET, PUT `/purchase-orders/:id` | purchases.* |
| POST | `/purchase-orders/:id/submit` · `/approve` · `/receive` · `/close` · `/cancel` | purchases.write / purchases.approve / purchases.receive |

## Orders, returns, refunds, invoices

| Method | Path | Permission |
|---|---|---|
| GET | `/orders` | orders.read |
| GET | `/orders/:id` | orders.read |
| PATCH | `/orders/:id/status` | orders.update — validated state machine |
| POST | `/orders/:id/cancel` | orders.cancel — releases stock, refunds if paid. The cancel stands even if the refund fails; the response then carries `refundError` and the FAILED refund can be retried |
| GET | `/returns` · `/returns/:id` | returns.read |
| POST | `/returns/:id/approve` · `/reject` · `/receive` · `/close` | returns.manage |
| POST | `/returns/scan` | returns.manage — scan item, locate order line |
| POST | `/returns/:id/refund` | returns.manage + refunds.create — `{ amount? }` (defaults to what is still refundable for the return; Idempotency-Key) |
| GET, POST | `/refunds` · GET `/refunds/:id` | refunds.read / refunds.create (Idempotency-Key) |
| POST | `/refunds/:id/retry` | refunds.create — retries a FAILED gateway refund on the same record; if the earlier attempt reached Razorpay it is recorded instead of refunding again |
| POST | `/invoices/:orderId` | invoices.write — issue invoice (idempotent) |
| GET | `/invoices` · `/invoices/:id` · `/invoices/:id/pdf` | invoices.read |
| GET | `/credit-notes` · `/credit-notes/:id/pdf` | invoices.read |

## Shipping

| Method | Path | Permission |
|---|---|---|
| POST | `/shipping/rates` | public — `{ postalCode, weightGrams }` |
| POST | `/shipments` | shipping.manage — `{ orderId }` |
| GET | `/shipments` · `/shipments/:id` | shipping.read |
| GET | `/shipments/:id/tracking` | shipping.read |
| POST | `/shipments/:id/cancel` | shipping.manage |
| GET | `/shipments/:id/label` | shipping.read |
| POST | `/shipping/webhook` | provider callback (token verified) |

## POS — `/pos`

| Method | Path | Permission |
|---|---|---|
| GET | `/pos/config` | pos.use — enabled payment methods and the manual-discount cap (cashiers lack settings.read) |
| POST | `/pos/carts` | pos.use — `{ warehouseId }` (returns the cashier's open cart if one exists) |
| GET | `/pos/carts/:id` | pos.use |
| PATCH | `/pos/carts/:id` | pos.use — customer, coupon, bill discount (pos.manual_discount) |
| POST | `/pos/carts/:id/scan` | pos.use — `{ code, quantity?, override? }` (override needs pos.override_stock; audited) |
| POST | `/pos/carts/:id/items` | pos.use — `{ variantId, quantity, override? }` |
| PATCH, DELETE | `/pos/carts/:id/items/:itemId` | pos.use |
| POST | `/pos/carts/:id/checkout` | pos.use — `{ paymentMethod: CASH\|UPI_MANUAL\|CARD_MANUAL\|RAZORPAY, referenceNumber?, amountTendered? }` (Idempotency-Key) |
| POST | `/pos/carts/:id/abandon` | pos.use |
| GET | `/pos/products/search` | pos.use — `q, warehouseId` |

## Marketing

| Method | Path | Permission |
|---|---|---|
| GET, POST | `/coupons` · GET, PUT, DELETE `/coupons/:id` | coupons.* |
| GET, POST | `/discounts` · PUT, DELETE `/discounts/:id` | discounts.* |

## Notifications

| Method | Path | Permission |
|---|---|---|
| GET | `/notifications` | notifications.read — delivery log (all channels) |
| POST | `/notifications/:id/retry` | notifications.manage |
| POST | `/notifications/test` | notifications.manage — send a test email / SMS |
| GET | `/sms-logs` · `/email-logs` | notifications.read |

## Administration

| Method | Path | Permission |
|---|---|---|
| GET | `/dashboard/summary` · `/dashboard/charts` | dashboard.read |
| GET | `/reports/:type` | reports.read — `type`: sales, orders, products, inventory, low-stock, customers, refunds, payments, taxes, suppliers, purchases · `format`: json, csv, xlsx, pdf |
| GET, POST | `/users` · GET, PUT `/users/:id` | users.read / users.write |
| PUT | `/users/:id/roles` | users.roles |
| POST | `/users/:id/status` | users.write |
| GET | `/customers` · `/customers/:id` | customers.read |
| GET, POST | `/roles` · GET, PUT, DELETE `/roles/:id` | roles.read / roles.write — PUT takes `{ name, description, permissions[] }` (system roles keep their code; SUPER_ADMIN is fixed) |
| GET | `/permissions` | roles.read |
| GET | `/settings` · PUT `/settings/:key` | settings.read / settings.write |
| GET | `/settings/:key` | settings.read — one group with `updatedAt` and `updatedBy` (null until first saved). The CMS content is four of these groups: `homePage`, `contact`, `termsPage`, `privacyPage` |
| GET | `/audit-logs` | audit.read |
