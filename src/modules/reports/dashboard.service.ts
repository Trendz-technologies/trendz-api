import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { cached } from "../../database/redis";
import { getSetting } from "../settings/settings.service";

const PAID = Prisma.sql`payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')`;
const n = (v: unknown) => Number(v ?? 0);

/** Start of today / this month in IST, as UTC instants. */
function istBoundaries() {
  const offset = 330 * 60_000;
  const nowIst = new Date(Date.now() + offset);
  const today = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - offset);
  const month = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - offset);
  return { today, month };
}

export function dashboardSummary() {
  // Short cache: the dashboard is polled, the numbers move slowly.
  return cached("dashboard:summary", 30, async () => {
    const { today, month } = istBoundaries();
    const { defaultLowStockThreshold } = await getSetting("inventory");
    const [sales, statusCounts, customers, products, stock, refunds, paymentStatus] = await Promise.all([
      prisma.$queryRaw<{ total: bigint; today: bigint; month: bigint; orders: bigint }[]>`
        SELECT COALESCE(SUM(grand_total - amount_refunded), 0) AS total,
               COALESCE(SUM(grand_total - amount_refunded) FILTER (WHERE placed_at >= ${today}), 0) AS today,
               COALESCE(SUM(grand_total - amount_refunded) FILTER (WHERE placed_at >= ${month}), 0) AS month,
               COUNT(*) AS orders
        FROM orders WHERE ${PAID}`,
      prisma.order.groupBy({ by: ["status"], _count: true }),
      prisma.user.count({ where: { isStaff: false } }),
      prisma.product.count({ where: { status: "ACTIVE" } }),
      prisma.$queryRaw<{ low: bigint; out: bigint; value: bigint }[]>`
        WITH v AS (
          SELECT pv.id, COALESCE(SUM(il.on_hand - il.reserved), 0) AS available, COALESCE(SUM(il.on_hand), 0) AS on_hand, pv.cost_price,
                 COALESCE(pv.low_stock_threshold, NULLIF(p.min_stock_level, 0), ${defaultLowStockThreshold}) AS threshold
          FROM product_variants pv JOIN products p ON p.id = pv.product_id
          LEFT JOIN inventory_levels il ON il.variant_id = pv.id
          WHERE pv.status = 'ACTIVE' AND p.status = 'ACTIVE'
          GROUP BY pv.id, p.min_stock_level
        )
        SELECT COUNT(*) FILTER (WHERE available > 0 AND available <= threshold) AS low,
               COUNT(*) FILTER (WHERE available <= 0) AS out,
               COALESCE(SUM(on_hand * COALESCE(cost_price, 0)), 0) AS value
        FROM v`,
      prisma.refund.aggregate({ where: { status: { in: ["PROCESSED", "PROCESSING"] } }, _sum: { amount: true }, _count: true }),
      prisma.order.groupBy({ by: ["paymentStatus"], _count: true }),
    ]);
    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));
    return {
      totalSales: n(sales[0]?.total),
      todaySales: n(sales[0]?.today),
      monthSales: n(sales[0]?.month),
      totalOrders: n(sales[0]?.orders),
      pendingOrders: (byStatus.CONFIRMED ?? 0) + (byStatus.PROCESSING ?? 0) + (byStatus.PACKED ?? 0),
      awaitingPayment: byStatus.PENDING ?? 0,
      deliveredOrders: byStatus.DELIVERED ?? 0,
      cancelledOrders: byStatus.CANCELLED ?? 0,
      returnRequests: byStatus.RETURN_REQUESTED ?? 0,
      totalCustomers: customers,
      totalProducts: products,
      lowStockProducts: n(stock[0]?.low),
      outOfStockProducts: n(stock[0]?.out),
      inventoryValue: n(stock[0]?.value),
      refunds: { count: refunds._count, amount: refunds._sum.amount ?? 0 },
      paymentStatus: Object.fromEntries(paymentStatus.map((p) => [p.paymentStatus, p._count])),
    };
  });
}

export async function dashboardCharts(range: "7d" | "30d" | "90d" | "12m") {
  const days = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 }[range];
  const from = new Date(Date.now() - days * 86_400_000);
  const bucket = range === "12m" ? Prisma.sql`'month'` : Prisma.sql`'day'`;
  const istTs = Prisma.sql`(placed_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
  return cached(`dashboard:charts:${range}`, 60, async () => {
    const [series, topProducts, categories, methods, inventory] = await Promise.all([
      prisma.$queryRaw<{ bucket: Date; revenue: bigint; orders: bigint }[]>`
        SELECT date_trunc(${bucket}, ${istTs})::date AS bucket, COALESCE(SUM(grand_total), 0) AS revenue, COUNT(*) AS orders
        FROM orders WHERE ${PAID} AND placed_at >= ${from} GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ name: string; quantity: bigint; revenue: bigint }[]>`
        SELECT i.product_name AS name, SUM(i.quantity) AS quantity, SUM(i.line_total) AS revenue
        FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND o.placed_at >= ${from}
        GROUP BY i.product_name ORDER BY revenue DESC LIMIT 10`,
      prisma.$queryRaw<{ name: string; revenue: bigint }[]>`
        SELECT COALESCE(root.name, c.name) AS name, SUM(i.line_total) AS revenue
        FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id JOIN categories c ON c.id = p.category_id
        LEFT JOIN categories root ON root.id = NULLIF(split_part(c.path, '/', 2), '')::uuid
        WHERE o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND o.placed_at >= ${from}
        GROUP BY 1 ORDER BY revenue DESC`,
      prisma.$queryRaw<{ method: string; count: bigint; amount: bigint }[]>`
        SELECT COALESCE(method, provider::text) AS method, COUNT(*) AS count, SUM(amount) AS amount
        FROM payments WHERE status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND created_at >= ${from}
        GROUP BY 1 ORDER BY amount DESC`,
      dashboardSummary(),
    ]);
    // Fill gaps so charts have a point per day.
    const points = new Map(series.map((s) => [new Date(s.bucket).toISOString().slice(0, 10), { revenue: n(s.revenue), orders: n(s.orders) }]));
    const timeline: { date: string; revenue: number; orders: number }[] = [];
    if (range === "12m") {
      for (const [date, v] of points) timeline.push({ date, ...v });
    } else {
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() + 330 * 60_000 - i * 86_400_000).toISOString().slice(0, 10);
        timeline.push({ date: d, ...(points.get(d) ?? { revenue: 0, orders: 0 }) });
      }
    }
    return {
      range,
      sales: timeline,
      topProducts: topProducts.map((t) => ({ name: t.name, quantity: n(t.quantity), revenue: n(t.revenue) })),
      categorySales: categories.map((c) => ({ name: c.name, revenue: n(c.revenue) })),
      paymentMethods: methods.map((m) => ({ method: m.method, count: n(m.count), amount: n(m.amount) })),
      inventoryStatus: {
        low: inventory.lowStockProducts,
        out: inventory.outOfStockProducts,
        healthy: Math.max(0, (await prisma.productVariant.count({ where: { status: "ACTIVE", product: { status: "ACTIVE" } } })) - inventory.lowStockProducts - inventory.outOfStockProducts),
      },
    };
  });
}
