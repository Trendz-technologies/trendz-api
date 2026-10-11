import { env, isProduction } from "../../config/env";
import { MockShippingProvider } from "./mock/mock-shipping.provider";
import { ShiprocketProvider } from "./shiprocket.provider";
import type { ShippingService } from "./shipping.types";

let provider: ShippingService | null = null;

/** The configured shipping provider. Business code depends only on ShippingService. */
export function shippingService(): ShippingService {
  if (provider) return provider;
  if (env.SHIPPING_PROVIDER === "shiprocket") {
    if (!env.SHIPPING_API_KEY || !env.SHIPPING_API_SECRET) throw new Error("SHIPPING_PROVIDER=shiprocket requires SHIPPING_API_KEY (email) and SHIPPING_API_SECRET (password)");
    provider = new ShiprocketProvider(env.SHIPPING_API_KEY, env.SHIPPING_API_SECRET);
  } else {
    if (isProduction) throw new Error("The mock shipping provider cannot run in production");
    provider = new MockShippingProvider();
  }
  return provider;
}

export function mockShipping(): MockShippingProvider | null {
  const p = shippingService();
  return p instanceof MockShippingProvider ? p : null;
}

export * from "./shipping.types";
