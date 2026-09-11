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
