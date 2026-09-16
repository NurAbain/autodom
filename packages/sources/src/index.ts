import {
  type FetchPageOptions,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { fetchPage as bidcars } from "./bidcars.js";
import { fetchPage as dubicars } from "./dubicars.js";
import { fetchPage as encar } from "./encar.js";
import { fetchPage as lalafo } from "./lalafo.js";
import { fetchPage as mashina } from "./mashina.js";
import { fetchPage as truecar } from "./truecar.js";

const fetchers: Readonly<Record<string, (options: FetchPageOptions) => Promise<SourcePage>>> = {
  "mashina.kg": mashina,
  "lalafo.kg": lalafo,
  "encar.com": encar,
  "truecar.com": truecar,
  "bid.cars": bidcars,
  "dubicars.com": dubicars,
};

export async function fetchSourcePage(
  source: string,
  options: FetchPageOptions,
): Promise<SourcePage> {
  requireSourceAccess(source);
  const fetcher = fetchers[source];
  if (!fetcher) throw new SourceError("Unknown catalog source");
  return fetcher(options);
}

export { DETAIL_DELAY_SECONDS } from "./bidcars.js";
export { checkCar365, parseCar365Record } from "./car365.js";
export { checkCarHistory, parseCarHistoryAvailability } from "./carhistory.js";
export type { ProxyTransportOptions } from "./http.js";
export { ProxyTransport, retryAfterSeconds } from "./http.js";
export { parseVagvinCarfaxRecord, VagvinCarfaxLookup } from "./vagvin-carfax.js";
