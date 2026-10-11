import type { ShipmentStatus } from "@prisma/client";

export interface ShipAddress {
  name: string;
  phone: string;
  email?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface ShipItem {
  name: string;
  sku: string;
  quantity: number;
  unitPrice: number; // paise, what the customer paid per unit
  hsnCode?: string | null;
}

export interface CreateShipmentInput {
  reference: string; // our order number (+ suffix for multi-warehouse orders)
  orderDate: Date;
  pickupLocation: string;
  pickupPostalCode: string;
  shipTo: ShipAddress;
  items: ShipItem[];
  subTotal: number; // paise
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  isReturn?: boolean;
}

export interface CreatedShipment {
  providerOrderId: string;
  providerShipmentId: string;
  awb: string | null;
  courierName: string | null;
  courierId: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  status: ShipmentStatus;
  shippingCost: number | null; // paise, what the courier charges
  estimatedDeliveryAt: Date | null;
}

export interface TrackingEvent {
  status: ShipmentStatus;
  rawStatus: string;
  location: string | null;
  description: string | null;
  occurredAt: Date;
}

export interface Tracking {
  status: ShipmentStatus;
  events: TrackingEvent[];
  estimatedDeliveryAt: Date | null;
}

export interface RateQuote {
  courierId: string;
  courierName: string;
  amount: number; // paise
  estimatedDays: number | null;
}

/** The provider-neutral shipping contract used by the rest of the system. */
export interface ShippingService {
  readonly name: "SHIPROCKET" | "MOCK";
  getRates(input: { pickupPostalCode: string; deliveryPostalCode: string; weightGrams: number; declaredValue: number }): Promise<RateQuote[]>;
  createShipment(input: CreateShipmentInput): Promise<CreatedShipment>;
  cancelShipment(input: { providerOrderId: string; awb: string | null }): Promise<void>;
  getTracking(input: { awb: string | null; providerShipmentId: string }): Promise<Tracking>;
  generateLabel(input: { providerShipmentId: string }): Promise<string | null>;
}

/** Maps courier / aggregator status text onto our shipment statuses. */
export function mapShipmentStatus(raw: string): ShipmentStatus {
  const s = raw.toUpperCase().replace(/[\s_-]+/g, " ").trim();
  if (/RTO.*DELIVERED|RETURNED TO ORIGIN|RTO DELIVERED/.test(s)) return "RETURNED";
  if (/RTO|RETURN TO ORIGIN|RETURN INITIATED/.test(s)) return "RETURN_TO_ORIGIN";
  if (/OUT FOR DELIVERY/.test(s)) return "OUT_FOR_DELIVERY";
  if (/^DELIVERED|\bDELIVERED\b/.test(s) && !/UNDELIVERED|NOT DELIVERED/.test(s)) return "DELIVERED";
  if (/CANCEL/.test(s)) return "CANCELLED";
  if (/PICKED UP|PICKUP COMPLETE|SHIPPED/.test(s)) return "PICKED_UP";
  if (/IN TRANSIT|REACHED|DEPARTED|ARRIVED|CONNECTED|DISPATCHED/.test(s)) return "IN_TRANSIT";
  if (/PICKUP (SCHEDULED|GENERATED|QUEUED)|OUT FOR PICKUP|MANIFEST/.test(s)) return "PICKUP_SCHEDULED";
  if (/LOST|DAMAGED|DESTROYED/.test(s)) return "FAILED";
  if (/UNDELIVERED|NOT DELIVERED|FAILED|EXCEPTION/.test(s)) return "IN_TRANSIT";
  return "CREATED";
}
