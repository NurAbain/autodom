import type { Listing } from "@autodom/core";

// Exact source CDN hosts, never arbitrary source subdomains or seller-supplied hosts.
const PHOTO_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "mashina.kg": ["im.mashina.kg", "pictures.mashina.kg", "storage.mashina.kg", "s3.mashina.kg"],
  "encar.com": ["ci.encar.com"],
  "bid.cars": ["images.bid.cars", "mercury.bid.cars", "pluto.bid.car"],
  "truecar.com": ["listings-prod.tcimg.net"],
};

function safePhotoUrl(source: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\s\\\p{Cc}]/u.test(value)) return null;
  // Inspect the literal authority before normalization can hide ports or decode hosts.
  const host = /^https:\/\/([a-z0-9.-]+)\//.exec(value)?.[1];
  if (!host || !Object.hasOwn(PHOTO_HOSTS, source) || !PHOTO_HOSTS[source]?.includes(host))
    return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash || url.hostname !== host) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function listingPhotoUrls(listing: Listing): string[] {
  const photos: string[] = [];
  const cover = safePhotoUrl(listing.source, listing.photo_url);
  if (cover) photos.push(cover);
  for (const value of listing.photo_urls ?? []) {
    const url = safePhotoUrl(listing.source, value);
    if (url && !photos.includes(url)) photos.push(url);
    if (photos.length === 10) break;
  }
  return photos;
}
