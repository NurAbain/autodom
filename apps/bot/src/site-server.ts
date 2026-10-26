import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Listing, MARKETS } from "@autodom/core";
import {
  CATALOG_PAGE_SIZE,
  type CatalogQuery,
  catalogQueryToProfile,
  parseCatalogQuery,
} from "@autodom/core/catalog-query";
import type { Store } from "@autodom/storage";
import { listingPhotoUrls, photoCspSources } from "./media.js";
import {
  renderCar,
  renderCatalog,
  renderHome,
  renderNotFound,
  type SiteContext,
  type SitePricePoint,
} from "./site-views.js";

export interface SiteServerOptions {
  store: Store;
  /** Public origin of the site, used for canonical links. */
  publicUrl: string;
  /** Telegram username of the full Autodom bot, used for the hand-off links. */
  botUsername?: string | undefined;
  assetsDirectory?: string | undefined;
  onRequest?: (observation: {
    route: string;
    method: "GET" | "POST" | "other";
    status: number | "aborted";
    durationSeconds: number;
  }) => void;
}

const HOME_PAGE_SIZE = 12;
const SIMILAR_PAGE_SIZE = 4;

/** Same price band around the car, same make and model, only fresh offers. */
function similarQuery(listing: Listing, currency: "USD" | "KGS"): CatalogQuery | null {
  const make = listing.catalog_attributes.make ?? "";
  if (!make) return null;
  const price = currency === "USD" ? listing.price_usd_minor : listing.price_kgs_minor;
  if (price === null || price <= 0) return null;
  const band = Math.round(price * 0.25);
  return {
    q: "",
    market: Object.hasOwn(MARKETS, listing.market) ? listing.market : "ALL",
    currency,
    budget_min_minor: Math.max(0, price - band),
    budget_max_minor: price + band,
    year_min: null,
    year_max: null,
    mileage_max_km: null,
    body_type: "",
    transmission: "",
    city: "",
    make,
    model: listing.catalog_attributes.model ?? "",
    sort: "price_asc",
    page: 1,
  };
}

export async function startSiteServer(options: SiteServerOptions): Promise<Server> {
  const origin = new URL(options.publicUrl).origin;
  const directory = options.assetsDirectory ?? fileURLToPath(new URL("./public/", import.meta.url));
  const stylesheet = await readFile(join(directory, "site.css"));
  const contentSecurityPolicy = [
    "default-src 'none'",
    "style-src 'self'",
    `img-src 'self' ${photoCspSources().join(" ")}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  const context = (query: CatalogQuery, total: number, pages: number): SiteContext => ({
    query,
    listings: [],
    total,
    pages,
    brands: [],
    publicUrl: origin,
    botUsername: options.botUsername,
  });

  const server = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      let route = "unmatched";
      const started = performance.now();
      response.setHeader("Content-Security-Policy", contentSecurityPolicy);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      const finish = (status: number | "aborted"): void => {
        try {
          options.onRequest?.({
            route,
            method:
              request.method === "GET" || request.method === "HEAD"
                ? "GET"
                : request.method === "POST"
                  ? "POST"
                  : "other",
            status,
            durationSeconds: (performance.now() - started) / 1000,
          });
        } catch {
          // Telemetry must never change what the visitor receives.
        }
      };
      response.once("finish", () => finish(response.statusCode));
      response.once("close", () =>
        finish(response.writableFinished ? response.statusCode : "aborted"),
      );
      void (async () => {
        const url = new URL(request.url ?? "/", origin);
        const sendHtml = (status: number, html: string): void => {
          response.writeHead(status, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html),
            "Cache-Control": "public, max-age=60",
          });
          response.end(request.method === "HEAD" ? undefined : html);
        };
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.setHeader("Allow", "GET, HEAD");
          sendHtml(405, renderNotFound(context(parseCatalogQuery(""), 0, 1)));
          return;
        }
        if (url.pathname === "/health") {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ healthy: true }));
          return;
        }
        if (url.pathname === "/site.css") {
          response.writeHead(200, {
            "Content-Type": "text/css; charset=utf-8",
            "Content-Length": stylesheet.length,
            "Cache-Control": "public, max-age=3600",
          });
          response.end(request.method === "HEAD" ? undefined : stylesheet);
          return;
        }
        const photosOf = (listings: readonly Listing[]): Map<string, string> => {
          const photos = new Map<string, string>();
          for (const listing of listings) {
            const first = listingPhotoUrls(listing)[0];
            if (first) photos.set(listing.id, first);
          }
          return photos;
        };
        if (url.pathname === "/") {
          route = "/";
          const query = parseCatalogQuery("");
          const profile = catalogQueryToProfile(query);
          const listings = await options.store.searchCatalog(profile, {
            limit: HOME_PAGE_SIZE,
            offset: 0,
            sort: "new",
          });
          const total = await options.store.countMatches(profile);
          const brands = await options.store.brandFacets(profile, 24);
          const page = context(query, total, 1);
          sendHtml(200, renderHome({ ...page, listings, brands }, photosOf(listings)));
          return;
        }
        if (url.pathname === "/cars") {
          route = "/cars";
          const query = parseCatalogQuery(url.search);
          const profile = catalogQueryToProfile(query);
          const total = await options.store.countMatches(profile);
          const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
          // A page beyond the last one shows the last page, and the links agree with it.
          const current = { ...query, page: Math.min(query.page, pages) };
          const listings = await options.store.searchCatalog(profile, {
            limit: CATALOG_PAGE_SIZE,
            offset: (current.page - 1) * CATALOG_PAGE_SIZE,
            sort: query.sort,
          });
          const page = context(current, total, pages);
          sendHtml(200, renderCatalog({ ...page, listings }, photosOf(listings)));
          return;
        }
        const brand = /^\/brands\/([^/]+)$/u.exec(url.pathname);
        if (brand) {
          route = "/brands";
          const query = {
            ...parseCatalogQuery(url.search),
            make: decodeURIComponent(brand[1]!),
            model: "",
            page: 1,
          };
          const profile = catalogQueryToProfile(query);
          const total = await options.store.countMatches(profile);
          const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
          const listings = await options.store.searchCatalog(profile, {
            limit: CATALOG_PAGE_SIZE,
            offset: 0,
            sort: query.sort,
          });
          const page = context(query, total, pages);
          sendHtml(200, renderCatalog({ ...page, listings }, photosOf(listings)));
          return;
        }
        const model = /^\/models\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
        if (model) {
          route = "/models";
          const query = {
            ...parseCatalogQuery(url.search),
            make: decodeURIComponent(model[1]!),
            model: decodeURIComponent(model[2]!),
            page: 1,
          };
          const profile = catalogQueryToProfile(query);
          const total = await options.store.countMatches(profile);
          const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
          const listings = await options.store.searchCatalog(profile, {
            limit: CATALOG_PAGE_SIZE,
            offset: 0,
            sort: query.sort,
          });
          const page = context(query, total, pages);
          sendHtml(200, renderCatalog({ ...page, listings }, photosOf(listings)));
          return;
        }
        const car = /^\/cars\/([^/]+)$/u.exec(url.pathname);
        if (car) {
          route = "/cars/:id";
          const listing = await options.store.getListing(decodeURIComponent(car[1]!));
          if (!listing) {
            sendHtml(404, renderNotFound(context(parseCatalogQuery(""), 0, 1)));
            return;
          }
          const currency = "KGS";
          const history: SitePricePoint[] = await options.store.priceHistory(listing.id);
          const similarProfile = similarQuery(listing, currency);
          const similar = similarProfile
            ? (
                await options.store.searchCatalog(catalogQueryToProfile(similarProfile), {
                  limit: SIMILAR_PAGE_SIZE + 1,
                  offset: 0,
                  sort: "price_asc",
                })
              )
                .filter((item) => item.id !== listing.id)
                .slice(0, SIMILAR_PAGE_SIZE)
            : [];
          const page = context(parseCatalogQuery(""), 1, 1);
          sendHtml(
            200,
            renderCar(
              { listing, photos: listingPhotoUrls(listing), history, similar },
              { ...page, query: { ...page.query, currency } },
            ),
          );
          return;
        }
        route = "not_found";
        sendHtml(404, renderNotFound(context(parseCatalogQuery(""), 0, 1)));
      })().catch((error: unknown) => {
        try {
          response.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
          response.end(
            `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Каталог временно недоступен</title><p>Каталог временно недоступен. Попробуйте позже.</p></html>`,
          );
        } catch {
          response.destroy();
        }
        if (!(error instanceof Error)) throw error;
      });
    },
  );
  return server;
}
