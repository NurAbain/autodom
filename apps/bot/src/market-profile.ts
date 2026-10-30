import type { Profile } from "@autodom/core";
import { NO_BUDGET_LIMIT_MINOR } from "./budget-limit.js";

/**
 * The conditions of the whole local market: every ad of every approved source.
 * The owner card asks for the makes and the cities of the market, and a buyer
 * budget would hide the cars the owner actually owns.
 */
export function marketProfile(userId: number): Profile {
  return {
    user_id: userId,
    chat_id: userId,
    currency: "USD",
    budget_min_minor: 0,
    budget_max_minor: NO_BUDGET_LIMIT_MINOR,
    query: "",
    monitoring: false,
    revision: "0",
    cursor: 0,
    quiet_start_minute: null,
    quiet_end_minute: null,
    market: "KG",
    city: "",
    budget_scope: "car",
    body_type: "",
    year_min: null,
    year_max: null,
    mileage_max_km: null,
    transmission: "",
    use_case: "",
    allow_import: null,
    purchase_by: "",
  };
}
