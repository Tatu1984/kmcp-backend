import type { Request } from "express";

/**
 * IP geolocation for login security.
 *
 * Sources, in priority order:
 *   1. vercel-ip — city, region, country, coordinates and timezone that Vercel
 *      injects as `x-vercel-ip-*` headers. Free, no external call.
 *   2. ipinfo — postal code, ISP, ASN and VPN/proxy detection. Only when
 *      IPINFO_TOKEN is configured, so the system works without it.
 *   3. ip-api — free, no key, used as a baseline when neither yields a city.
 *
 * Coordinates are then refined to a named locality via BigDataCloud.
 *
 * Every external call has a tight timeout and degrades to "unknown". A slow geo
 * lookup must never hold up a login — an attendant standing at a kerb in the
 * rain does not care where our enrichment API is.
 */

export interface GeoInfo {
  city?: string;
  /** Locality or neighbourhood within the city, e.g. "Salt Lake, Bidhannagar". */
  district?: string;
  region?: string;
  /** PIN / ZIP code — the most reliable sub-city signal from IP geo. */
  postal?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  isp?: string;
  asn?: string;
  org?: string;
  /** True when the IP belongs to a hosting, VPN or proxy network. */
  isVpnOrProxy?: boolean;
  ipTimezone?: string;
  source: "vercel-ip" | "ipinfo" | "ip-api" | "unknown";
}

// ---------------------------------------------------------------- IP helpers

export function isPrivateIp(ip: string): boolean {
  if (!ip) return false;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  // CGNAT — very common on Indian mobile networks, which most attendants use.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  return false;
}

export const isLoopbackIp = (ip: string): boolean =>
  Boolean(ip) && (ip === "::1" || ip.startsWith("127."));

/** Strips the IPv4-mapped IPv6 prefix so cache keys are stable. */
export function normaliseIp(ip: string | null | undefined): string {
  if (!ip) return "";
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? m[1] : ip;
}

/** The client IP, honouring the proxy chain Vercel puts in front of us. */
export function clientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return normaliseIp(first || req.ip || req.socket?.remoteAddress || "");
}

// -------------------------------------------------------------- header source

const decode = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const toNumber = (value?: string): number | undefined => {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export function geoFromVercelHeaders(req: Request): GeoInfo {
  const city = decode(req.header("x-vercel-ip-city"));
  return {
    city,
    region: decode(req.header("x-vercel-ip-country-region")),
    country: req.header("x-vercel-ip-country") ?? undefined,
    latitude: toNumber(req.header("x-vercel-ip-latitude")),
    longitude: toNumber(req.header("x-vercel-ip-longitude")),
    ipTimezone: req.header("x-vercel-ip-timezone") ?? undefined,
    source: city ? "vercel-ip" : "unknown",
  };
}

// ------------------------------------------------------------ external lookups

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { value: GeoInfo; expiresAt: number }>();

// ip-api's free tier allows 45 requests a minute; we self-impose 40.
const rate = { windowMs: 60_000, max: 40, hits: [] as number[] };

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await work(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface IpinfoResponse {
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
  loc?: string;
  org?: string;
  timezone?: string;
  privacy?: { vpn?: boolean; proxy?: boolean; tor?: boolean; hosting?: boolean };
}

async function enrichWithIpinfo(ip: string): Promise<GeoInfo | null> {
  const token = process.env.IPINFO_TOKEN;
  if (!token || !ip) return null;

  const data = await withTimeout(async (signal) => {
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}?token=${token}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as IpinfoResponse) : null;
  }, 2500);

  if (!data) return null;

  const [lat, lng] = (data.loc ?? "").split(",");
  const asnMatch = data.org?.match(/^(AS\d+)\s+(.*)$/);

  return {
    city: data.city,
    region: data.region,
    postal: data.postal,
    country: data.country,
    latitude: toNumber(lat),
    longitude: toNumber(lng),
    asn: asnMatch?.[1],
    isp: asnMatch?.[2] ?? data.org,
    org: data.org,
    ipTimezone: data.timezone,
    isVpnOrProxy: data.privacy
      ? Boolean(data.privacy.vpn || data.privacy.proxy || data.privacy.tor || data.privacy.hosting)
      : undefined,
    source: "ipinfo",
  };
}

interface IpApiResponse {
  status?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  /** Coordinates matter: impossible-travel detection cannot work without them. */
  lat?: number;
  lon?: number;
  zip?: string;
  isp?: string;
  as?: string;
  timezone?: string;
}

async function lookupIpApi(ip: string): Promise<GeoInfo | null> {
  const now = Date.now();
  rate.hits = rate.hits.filter((t) => t > now - rate.windowMs);
  if (rate.hits.length >= rate.max) return null;
  rate.hits.push(now);

  const data = await withTimeout(async (signal) => {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,zip,lat,lon,isp,as,timezone`;
    const res = await fetch(url, { signal });
    return res.ok ? ((await res.json()) as IpApiResponse) : null;
  }, 3000);

  if (data?.status !== "success") return null;

  return {
    city: data.city,
    region: data.regionName,
    postal: data.zip,
    country: data.countryCode ?? data.country,
    latitude: data.lat,
    longitude: data.lon,
    isp: data.isp,
    org: data.as,
    asn: data.as?.match(/^(AS\d+)/)?.[1],
    ipTimezone: data.timezone,
    source: "ip-api",
  };
}

interface BigDataCloudResponse {
  locality?: string;
  localityInfo?: { administrative?: { name?: string; order?: number }[] };
  postcode?: string;
}

/** Turns coordinates into a named locality — the "which part of the city" answer. */
async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<{ district?: string; postal?: string } | null> {
  const data = await withTimeout(async (signal) => {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
      { signal, headers: { Accept: "application/json" } },
    );
    return res.ok ? ((await res.json()) as BigDataCloudResponse) : null;
  }, 2500);

  if (!data) return null;

  const finest = (data.localityInfo?.administrative ?? [])
    .filter((a) => a.name)
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0]?.name;

  return { district: data.locality ?? finest, postal: data.postcode };
}

/**
 * Best available geolocation for a request. Vercel headers as the always-on
 * base, enriched by ipinfo where configured, with ip-api as a fallback, then
 * refined to a locality. Cached for a day — an IP's city does not change
 * minute to minute.
 */
export async function resolveGeo(req: Request, ip: string): Promise<GeoInfo> {
  const base = geoFromVercelHeaders(req);

  if (!ip || isLoopbackIp(ip) || isPrivateIp(ip)) {
    return base.city ? base : { ...base, source: "unknown" };
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    // Keep the live header values, which are per-request and free.
    return { ...cached.value, ...(base.city ? base : {}) };
  }

  const enriched = await enrichWithIpinfo(ip);
  let merged: GeoInfo = enriched
    ? {
        city: base.city ?? enriched.city,
        region: base.region ?? enriched.region,
        postal: enriched.postal,
        country: base.country ?? enriched.country,
        latitude: base.latitude ?? enriched.latitude,
        longitude: base.longitude ?? enriched.longitude,
        ipTimezone: base.ipTimezone ?? enriched.ipTimezone,
        isp: enriched.isp,
        asn: enriched.asn,
        org: enriched.org,
        isVpnOrProxy: enriched.isVpnOrProxy,
        source: enriched.source,
      }
    : base;

  if (!merged.city) {
    const baseline = await lookupIpApi(ip);
    if (baseline) {
      merged = {
        ...merged,
        city: merged.city ?? baseline.city,
        region: merged.region ?? baseline.region,
        country: merged.country ?? baseline.country,
        postal: merged.postal ?? baseline.postal,
        latitude: merged.latitude ?? baseline.latitude,
        longitude: merged.longitude ?? baseline.longitude,
        isp: merged.isp ?? baseline.isp,
        org: merged.org ?? baseline.org,
        asn: merged.asn ?? baseline.asn,
        ipTimezone: merged.ipTimezone ?? baseline.ipTimezone,
        source: merged.source === "unknown" ? "ip-api" : merged.source,
      };
    }
  }

  if (merged.latitude != null && merged.longitude != null) {
    const fine = await reverseGeocode(merged.latitude, merged.longitude);
    if (fine) {
      merged.district = fine.district ?? merged.district;
      merged.postal = merged.postal ?? fine.postal;
    }
  }

  cache.set(ip, { value: merged, expiresAt: Date.now() + CACHE_TTL_MS });
  return merged;
}

// ------------------------------------------------------------------- distance

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres, or null when either point is unknown. */
export function haversineKm(
  a: { latitude?: number | null; longitude?: number | null },
  b: { latitude?: number | null; longitude?: number | null },
): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) {
    return null;
  }
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude));
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Implied travel speed between two logins, used to flag impossible travel. */
export function impliedSpeedKmh(distanceKm: number, elapsedMs: number): number {
  const hours = elapsedMs / 3_600_000;
  return hours <= 0 ? Infinity : distanceKm / hours;
}
