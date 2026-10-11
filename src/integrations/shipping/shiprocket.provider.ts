import { env } from "../../config/env";
import { redis } from "../../database/redis";
import { mapShipmentStatus, type CreateShipmentInput, type CreatedShipment, type RateQuote, type ShippingService, type Tracking } from "./shipping.types";

const BASE = "https://apiv2.shiprocket.in/v1/external";
const TOKEN_KEY = "shiprocket:token";

/**
 * Shiprocket (https://apidocs.shiprocket.in). Authenticates with the API
 * user's email/password (SHIPPING_API_KEY / SHIPPING_API_SECRET); the token
 * (valid 10 days) is cached in Redis for 9 days.
 */
export class ShiprocketProvider implements ShippingService {
  readonly name = "SHIPROCKET" as const;

  constructor(
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async token(force = false): Promise<string> {
    if (!force) {
      const cached = await redis.get(TOKEN_KEY);
      if (cached) return cached;
    }
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !body.token) throw new Error(`Shiprocket login failed: ${body.message ?? res.status}`);
    await redis.set(TOKEN_KEY, body.token, "EX", 9 * 24 * 3600);
    return body.token;
  }

  private async call<T>(method: "GET" | "POST", path: string, payload?: unknown, retry = true): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.token()}` },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 && retry) {
      await this.token(true);
      return this.call<T>(method, path, payload, false);
    }
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(`Shiprocket ${path} → ${res.status}: ${body.message ?? JSON.stringify(body).slice(0, 300)}`);
    return body;
  }

  async getRates(input: { pickupPostalCode: string; deliveryPostalCode: string; weightGrams: number; declaredValue: number }): Promise<RateQuote[]> {
    const q = new URLSearchParams({
      pickup_postcode: input.pickupPostalCode,
      delivery_postcode: input.deliveryPostalCode,
      weight: (Math.max(input.weightGrams, 100) / 1000).toFixed(2),
      cod: "0",
      declared_value: String(Math.round(input.declaredValue / 100)),
    });
    const body = await this.call<{ data?: { available_courier_companies?: { courier_company_id: number; courier_name: string; rate: number; estimated_delivery_days?: string }[] } }>(
      "GET",
      `/courier/serviceability/?${q.toString()}`,
    );
    return (body.data?.available_courier_companies ?? [])
      .map((c) => ({ courierId: String(c.courier_company_id), courierName: c.courier_name, amount: Math.round(c.rate * 100), estimatedDays: c.estimated_delivery_days ? Number(c.estimated_delivery_days) : null }))
      .sort((a, b) => a.amount - b.amount);
  }

  async createShipment(input: CreateShipmentInput): Promise<CreatedShipment> {
    const [first, ...rest] = input.shipTo.name.trim().split(/\s+/);
    const payload = {
      order_id: input.reference,
      order_date: input.orderDate.toISOString().slice(0, 16).replace("T", " "),
      pickup_location: input.pickupLocation,
      billing_customer_name: first,
      billing_last_name: rest.join(" ") || "-",
      billing_address: input.shipTo.line1,
      billing_address_2: input.shipTo.line2 ?? "",
      billing_city: input.shipTo.city,
      billing_pincode: input.shipTo.postalCode,
      billing_state: input.shipTo.state,
      billing_country: "India",
      billing_email: input.shipTo.email ?? "",
      billing_phone: input.shipTo.phone.replace(/^\+91/, ""),
      shipping_is_billing: true,
      order_items: input.items.map((i) => ({ name: i.name, sku: i.sku, units: i.quantity, selling_price: (i.unitPrice / 100).toFixed(2), hsn: i.hsnCode ?? "" })),
      payment_method: "Prepaid",
      sub_total: (input.subTotal / 100).toFixed(2),
      length: input.lengthCm,
      breadth: input.widthCm,
      height: input.heightCm,
      weight: (Math.max(input.weightGrams, 100) / 1000).toFixed(2),
    };
    const order = await this.call<{ order_id: number; shipment_id: number; status: string }>("POST", input.isReturn ? "/orders/create/return" : "/orders/create/adhoc", payload);

    // Assign the recommended courier and request pickup.
    const awb = await this.call<{ response?: { data?: { awb_code?: string; courier_name?: string; courier_company_id?: number; freight_charges?: number } } }>(
      "POST",
      "/courier/assign/awb",
      { shipment_id: order.shipment_id },
    ).catch(() => null);
    const data = awb?.response?.data;
    if (data?.awb_code) {
      await this.call("POST", "/courier/generate/pickup", { shipment_id: [order.shipment_id] }).catch(() => null);
    }
    return {
      providerOrderId: String(order.order_id),
      providerShipmentId: String(order.shipment_id),
      awb: data?.awb_code ?? null,
      courierName: data?.courier_name ?? null,
      courierId: data?.courier_company_id ? String(data.courier_company_id) : null,
      trackingUrl: data?.awb_code ? `https://shiprocket.co/tracking/${data.awb_code}` : null,
      labelUrl: null,
      status: data?.awb_code ? "PICKUP_SCHEDULED" : "CREATED",
      shippingCost: data?.freight_charges ? Math.round(data.freight_charges * 100) : null,
      estimatedDeliveryAt: null,
    };
  }

  async cancelShipment(input: { providerOrderId: string }) {
    await this.call("POST", "/orders/cancel", { ids: [Number(input.providerOrderId)] });
  }

  async getTracking(input: { awb: string | null; providerShipmentId: string }): Promise<Tracking> {
    const path = input.awb ? `/courier/track/awb/${encodeURIComponent(input.awb)}` : `/courier/track/shipment/${input.providerShipmentId}`;
    const body = await this.call<{
      tracking_data?: {
        shipment_track?: { current_status?: string; edd?: string | null }[];
        shipment_track_activities?: { date: string; status?: string; activity?: string; location?: string; "sr-status-label"?: string }[];
      };
    }>("GET", path);
    const td = body.tracking_data ?? {};
    const current = td.shipment_track?.[0]?.current_status ?? "CREATED";
    return {
      status: mapShipmentStatus(current),
      estimatedDeliveryAt: td.shipment_track?.[0]?.edd ? new Date(td.shipment_track[0].edd) : null,
      events: (td.shipment_track_activities ?? []).map((a) => {
        const raw = a["sr-status-label"] ?? a.status ?? a.activity ?? "UPDATE";
        return { status: mapShipmentStatus(raw), rawStatus: raw, location: a.location ?? null, description: a.activity ?? null, occurredAt: new Date(a.date) };
      }),
    };
  }

  async generateLabel(input: { providerShipmentId: string }) {
    const body = await this.call<{ label_url?: string; label_created?: number }>("POST", "/courier/generate/label", { shipment_id: [Number(input.providerShipmentId)] });
    return body.label_url ?? null;
  }
}

export const shiprocketWebhookToken = () => env.SHIPPING_WEBHOOK_TOKEN;
