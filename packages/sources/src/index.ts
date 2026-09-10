import {
  type FetchPageOptions,
  requireSourceAccess,
  SourceError,
  type SourcePage,
} from "@autodom/core";
import { fetchPage as bidcars } from "./bidcars.js";
import { fetchPage as encar } from "./encar.js";
import { fetchPage as mashina } from "./mashina.js";
import { fetchPage as truecar } from "./truecar.js";

const fetchers: Readonly<Record<string, (options: FetchPageOptions) => Promise<SourcePage>>> = {
  "mashina.kg": mashina,
  "encar.com": encar,
  "truecar.com": truecar,
  "bid.cars": bidcars,
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
export type { ProxyTransportOptions, RequestOutcome } from "./http.js";
export { ProxyTransport, retryAfterSeconds } from "./http.js";
