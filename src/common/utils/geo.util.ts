export interface LatLng {
  lat: number;
  lng: number;
}

/** A GeoJSON Polygon as stored on Zone.boundary. */
export interface GeoPolygon {
  type: "Polygon";
  coordinates: [number, number][][];
}

/**
 * Ray-casting point-in-polygon. Runs server-side only — a device never decides
 * which zone it is standing in.
 */
export function pointInPolygon(point: LatLng, polygon: GeoPolygon): boolean {
  const ring = polygon?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceMetres(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
}

/**
 * Whether a point is inside the boundary, or within `toleranceM` of its centre.
 * The tolerance exists because a GPS fix on a phone at the kerb is routinely
 * 10–20 m out, and refusing those readings would block honest attendants.
 */
export function withinZone(
  point: LatLng,
  boundary: GeoPolygon | null,
  centre: LatLng,
  toleranceM: number,
): boolean {
  if (boundary && pointInPolygon(point, boundary)) return true;
  return distanceMetres(point, centre) <= toleranceM;
}

/** Bounding box for a radius search, used to pre-filter before exact distance. */
export function boundingBox(centre: LatLng, radiusM: number) {
  const latDelta = radiusM / 111_320;
  const lngDelta = radiusM / (111_320 * Math.cos((centre.lat * Math.PI) / 180) || 1);
  return {
    minLat: centre.lat - latDelta,
    maxLat: centre.lat + latDelta,
    minLng: centre.lng - lngDelta,
    maxLng: centre.lng + lngDelta,
  };
}
