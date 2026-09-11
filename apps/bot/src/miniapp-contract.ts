import type { Profile } from "@autodom/core";
import type { Reply } from "./conversation.js";

export interface MiniAppSession {
  user: { id: number; firstName: string };
  profile: Profile | null;
  draftState: string | null;
  replies: Reply[];
}

export interface MiniAppCar {
  id: string;
  title: string;
  url: string | null;
  photoUrl: string | null;
  price: string;
  year: number | null;
  mileage: string;
  transmission: string;
  bodyType: string;
  city: string;
  market: string;
  source: string;
  observedAt: number | null;
  detailsHtml: string;
}

export interface MiniAppCars {
  cars: MiniAppCar[];
  total: number;
  offset: number;
  nextOffset: number | null;
  revision: string;
}
