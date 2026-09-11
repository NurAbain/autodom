import {
  normalizeVin,
  VIN_SOURCE_URLS,
  type VinCheckResult,
  type VinLookup,
  type VinProvider,
} from "@autodom/core";
import { checkCar365 } from "./car365.js";
import { checkCarHistory } from "./carhistory.js";
import { VinTransport, type VinTransportOptions } from "./vin-session.js";

export class VinCheckService {
  readonly #enabled: Record<VinProvider, boolean> = { carhistory: false, car365: false };
  readonly #transport: VinTransport | undefined;

  constructor(options: VinTransportOptions & { providers: readonly VinProvider[] }) {
    for (const provider of options.providers) this.#enabled[provider] = true;
    if (options.providers.length) this.#transport = new VinTransport(options);
  }

  readonly check: VinLookup = async (value, signal): Promise<VinCheckResult> => {
    const vin = normalizeVin(value);
    if (!vin) throw new RangeError("VIN must contain 17 letters and digits, without I, O or Q");
    signal?.throwIfAborted();
    const result: VinCheckResult = {
      vin,
      checked_at: Date.now() / 1000,
      carhistory: { status: "disabled", source_url: VIN_SOURCE_URLS.carhistory, checked_at: null },
      car365: {
        status: "disabled",
        source_url: VIN_SOURCE_URLS.car365,
        checked_at: null,
        data: null,
      },
    };
    const transport = this.#transport;
    if (!transport) return result;
    await Promise.all([
      (async () => {
        if (!this.#enabled.carhistory) return;
        result.carhistory.checked_at = Date.now() / 1000;
        try {
          result.carhistory.status = await transport.run(
            "carhistory",
            (session) => checkCarHistory(vin, session),
            signal,
          );
        } catch {
          signal?.throwIfAborted();
          result.carhistory.status = "unavailable";
        }
      })(),
      (async () => {
        if (!this.#enabled.car365) return;
        result.car365.checked_at = Date.now() / 1000;
        try {
          result.car365.data = await transport.run(
            "car365",
            (session) => checkCar365(vin, session),
            signal,
          );
          result.car365.status = result.car365.data ? "available" : "not_found";
        } catch {
          signal?.throwIfAborted();
          result.car365.status = "unavailable";
        }
      })(),
    ]);
    return result;
  };

  async close(): Promise<void> {
    await this.#transport?.close();
  }
}
