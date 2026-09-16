import { isEncarPhotoUrl, normalizeVin, type VinCheckResult } from "@autodom/core/vin";
import { isVinArchivePhotoUrl } from "@autodom/core/vin-archive";
import { confirmedEncarListings, confirmedVinArchiveResult } from "./vin-text.js";

/** Eligibility comes from confirmed source evidence, never a client-supplied photo count. */
export function confirmedVinPhotoCount(result: VinCheckResult): number {
  if (normalizeVin(result.vin) !== result.vin) return 0;
  let count = 0;
  for (const listing of confirmedEncarListings(result)) {
    for (const photo of listing.photo_urls) {
      if (isEncarPhotoUrl(photo, listing.id)) count++;
    }
  }
  if (result.archives?.vin !== result.vin) return count;
  for (const source of confirmedVinArchiveResult(result.archives).sources) {
    for (const lot of source.lots) {
      for (const photo of lot.photos) {
        if (isVinArchivePhotoUrl(photo, source.provider, lot.auction, lot.lot_id, result.vin))
          count++;
      }
    }
  }
  return count;
}

/** Preserve all free facts without exposing image URLs before a verified payment. */
export function withoutVinPhotos(result: VinCheckResult): VinCheckResult {
  return {
    ...result,
    ...(result.encar?.data
      ? {
          encar: {
            ...result.encar,
            data: {
              ...result.encar.data,
              listings: result.encar.data.listings.map((listing) => ({
                ...listing,
                photo_urls: [],
              })),
            },
          },
        }
      : {}),
    ...(result.archives
      ? {
          archives: {
            ...result.archives,
            sources: result.archives.sources.map((source) => ({
              ...source,
              lots: source.lots.map((lot) => ({ ...lot, photos: [] })),
            })),
          },
        }
      : {}),
  };
}
