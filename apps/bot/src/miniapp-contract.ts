import type { PaymentOrder } from "@autodom/core/payments";
import type { VinCheckResult } from "@autodom/core/vin";

export type MiniAppVinResult = VinCheckResult & {
  reportSalesEnabled: boolean;
  reportPrice: Pick<PaymentOrder, "amount" | "currency"> | null;
};

export interface MiniAppFinikMethods {
  banks: { name: string; url: string; logoUrl: string | null }[];
}

export interface MiniAppCar {
  id: string;
  title: string;
  url: string | null;
  photoUrls: string[];
  price: string;
  year: number | null;
  mileage: string;
  transmission: string;
  bodyType: string;
  city: string;
  market: string;
  source: string;
  observedAt: number | null;
  availability: string;
  detailsHtml: string;
  vin: string | null;
}
