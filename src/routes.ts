import { Router } from "express";
import { publicApiLimit } from "./common/middleware/rate-limit";
import { authRouter } from "./modules/auth/auth.routes";
import { accountRouter } from "./modules/users/account.routes";
import { usersRouter } from "./modules/users/users.routes";
import { permissionsRouter, rolesRouter } from "./modules/rbac/roles.routes";
import { settingsRouter } from "./modules/settings/settings.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { healthRouter } from "./modules/health/health.routes";
import { categoriesRouter } from "./modules/catalog/categories.routes";
import { brandsRouter } from "./modules/catalog/brands.routes";
import { productsRouter } from "./modules/catalog/products.routes";
import { uploadsRouter } from "./modules/catalog/uploads.routes";
import { taxRouter } from "./modules/tax/tax.routes";
import { storefrontRouter } from "./modules/storefront/storefront.routes";
import { codesRouter, scanRouter, variantCodesRouter } from "./modules/codes/codes.routes";
import { inventoryRouter } from "./modules/inventory/inventory.routes";
import { warehousesRouter } from "./modules/warehouses/warehouses.routes";
import { suppliersRouter } from "./modules/suppliers/suppliers.routes";
import { purchaseOrdersRouter } from "./modules/purchasing/purchase-orders.routes";
import { cartRouter } from "./modules/cart/cart.routes";
import { accountOrdersRouter, checkoutRouter, ordersRouter } from "./modules/orders/orders.routes";
import { paymentsRouter } from "./modules/payments/payments.routes";
import { refundsRouter } from "./modules/refunds/refunds.routes";
import { creditNotesRouter, invoicesRouter } from "./modules/invoices/invoices.routes";
import { couponsRouter, discountsRouter } from "./modules/promotions/promotions.routes";
import { accountReturnsRouter, returnsRouter } from "./modules/returns/returns.routes";
import { accountReviewsRouter, reviewsRouter, storeReviewsRouter } from "./modules/reviews/reviews.routes";
import { accountTrackingRouter, shipmentsRouter, shippingRouter } from "./modules/shipping/shipping.routes";
import { posRouter } from "./modules/pos/pos.routes";
import { dashboardRouter, reportsRouter } from "./modules/reports/reports.routes";
import { emailLogsRouter, notificationsRouter, smsLogsRouter } from "./modules/notifications/notifications.routes";
import { customersRouter } from "./modules/users/customers.routes";
import { wishlistRouter } from "./modules/users/wishlist.routes";

/** Every API module is mounted here, under /api. */
export function apiRouter(): Router {
  const api = Router();
  api.use("/health", healthRouter);
  api.use(publicApiLimit);

  api.use("/auth", authRouter);
  api.use("/account", accountRouter);
  api.use("/account", accountOrdersRouter);
  api.use("/account", accountReturnsRouter);
  api.use("/account", accountTrackingRouter);
  api.use("/account", wishlistRouter);
  api.use("/account", accountReviewsRouter);
  api.use("/users", usersRouter);
  api.use("/roles", rolesRouter);
  api.use("/permissions", permissionsRouter);
  api.use("/settings", settingsRouter);
  api.use("/audit-logs", auditRouter);

  api.use("/store", storefrontRouter);
  api.use("/store", storeReviewsRouter);
  api.use("/categories", categoriesRouter);
  api.use("/brands", brandsRouter);
  api.use("/products", scanRouter); // /products/scan and /products/code/:code before /products/:id
  api.use("/products", productsRouter);
  api.use("/codes", codesRouter);
  api.use("/variants", variantCodesRouter);

  api.use("/inventory", inventoryRouter);
  api.use("/warehouses", warehousesRouter);
  api.use("/suppliers", suppliersRouter);
  api.use("/purchase-orders", purchaseOrdersRouter);

  api.use("/cart", cartRouter);
  api.use("/checkout", checkoutRouter);
  api.use("/orders", ordersRouter);
  api.use("/payments", paymentsRouter);
  api.use("/refunds", refundsRouter);
  api.use("/invoices", invoicesRouter);
  api.use("/credit-notes", creditNotesRouter);
  api.use("/coupons", couponsRouter);
  api.use("/discounts", discountsRouter);
  api.use("/returns", returnsRouter);
  api.use("/reviews", reviewsRouter);
  api.use("/shipping", shippingRouter);
  api.use("/shipments", shipmentsRouter);
  api.use("/pos", posRouter);
  api.use("/dashboard", dashboardRouter);
  api.use("/reports", reportsRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/sms-logs", smsLogsRouter);
  api.use("/email-logs", emailLogsRouter);
  api.use("/customers", customersRouter);
  api.use("/uploads", uploadsRouter);
  api.use("/tax-classes", taxRouter);
  return api;
}
