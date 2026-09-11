import type { Listing } from "@autodom/core";

// Exact source CDN hosts, not arbitrary source subdomains or seller-supplied URLs.
// Mashina hosts come from catalog image variants and its image preconnects;
// the other hosts match the corresponding source parsers.
const PHOTO_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "mashina.kg": ["im.mashina.kg", "pictures.mashina.kg", "storage.mashina.kg", "s3.mashina.kg"],
  "encar.com": ["ci.encar.com"],
  "bid.cars": ["images.bid.cars", "mercury.bid.cars", "pluto.bid.car"],
  "truecar.com": ["listings-prod.tcimg.net"],
};

export function listingPhotoUrl(listing: Listing): string | null {
  const value = listing.photo_url;
  if (!value || /[\s\\\p{Cc}]/u.test(value)) return null;
  // Inspect the literal authority before URL normalization can erase :443 or
  // decode a disguised host. Credentials, ports, IPs and suffix tricks fail here.
  const host = /^https:\/\/([a-z0-9.-]+)\//.exec(value)?.[1];
  if (
    !host ||
    !Object.hasOwn(PHOTO_HOSTS, listing.source) ||
    !PHOTO_HOSTS[listing.source]?.includes(host)
  )
    return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash || url.hostname !== host) return null;
    return url.href;
  } catch {
    return null;
  }
}
