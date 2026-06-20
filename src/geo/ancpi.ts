// Fetch cadastral parcels from the Romanian ANCPI INSPIRE geoportal (CP_View
// layer 1). We request geometry already in Stereo 70 (outSR=3844), so no
// reprojection is needed — parcel ring coordinates are [Est, Nord] in metres,
// the same frame the placement pipeline uses.
//
// CORS: geoportal.ancpi.ro does not send permissive CORS headers, so a direct
// browser fetch is blocked. In dev we go through the Vite proxy (/ancpi → the
// geoportal, see vite.config.ts). In production the direct URL is attempted and
// will likely fail — the panel offers a "paste GeoJSON" fallback for that case.

/** One cadastral parcel. `rings[0]` is the outer boundary; extras are holes. */
export interface Parcel {
  id: string;
  /** nationalCadastralRef, e.g. "AG.19249.80057" (may be empty). */
  ref: string;
  /** Short, human-readable parcel number, e.g. "80057" (the `label` field). */
  label: string;
  /** areaValue in m² when present. */
  area: number | null;
  /** Polygon rings: each ring is a list of [Est, Nord] pairs in Stereo 70. */
  rings: [number, number][][];
}

const SERVICE_PATH = "inspireview/rest/services/CP/CP_View/MapServer/1/query";
const PAGE_SIZE = 1000; // service hard cap per request

/** Base URL: dev goes through the Vite proxy to dodge CORS; prod hits the host. */
function baseUrl(): string {
  return import.meta.env.DEV ? "/ancpi" : "https://geoportal.ancpi.ro";
}

function queryUrl(eastings: number, northings: number, radius: number, offset: number): string {
  const p = new URLSearchParams({
    where: "1=1",
    geometry: `${eastings},${northings}`,
    geometryType: "esriGeometryPoint",
    inSR: "3844",
    outSR: "3844",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(radius),
    units: "esriSRUnit_Meter",
    // Field names per the ANCPI CP_View layer (validated): a wrong name makes the
    // service reject the whole query with "Failed to execute query."
    outFields: "OBJECTID,label,nationalCadastralRef,areaValue",
    returnGeometry: "true",
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(offset),
    f: "geojson",
  });
  return `${baseUrl()}/${SERVICE_PATH}?${p.toString()}`;
}

/** Read a numeric value from a GeoJSON property bag under any of several keys. */
function pickNum(props: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = props?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function pickStr(props: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = props?.[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** Convert a GeoJSON Polygon/MultiPolygon ring array to our [E,N][] rings. */
function toRings(geometry: any): [number, number][][] {
  if (!geometry) return [];
  const out: [number, number][][] = [];
  const pushPolygon = (poly: any) => {
    if (!Array.isArray(poly)) return;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      const pts = ring
        .filter((c: any) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        .map((c: any) => [c[0], c[1]] as [number, number]);
      if (pts.length >= 3) out.push(pts);
    }
  };
  if (geometry.type === "Polygon") pushPolygon(geometry.coordinates);
  else if (geometry.type === "MultiPolygon") for (const poly of geometry.coordinates ?? []) pushPolygon(poly);
  return out;
}

/** Parse a GeoJSON FeatureCollection (from a fetch or pasted by the user) into parcels. */
export function parseParcels(geojson: unknown): Parcel[] {
  const fc = geojson as any;
  const features: any[] = Array.isArray(fc?.features) ? fc.features : [];
  const parcels: Parcel[] = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const props = (f?.properties ?? {}) as Record<string, unknown>;
    const rings = toRings(f?.geometry);
    if (!rings.length) continue;
    const ref = pickStr(props, "nationalCadastralReference", "nationalCadastralRef");
    // Short label: the `label` field, else the last segment of the full ref.
    const label = pickStr(props, "label") || (ref.includes(".") ? ref.slice(ref.lastIndexOf(".") + 1) : ref);
    parcels.push({
      id: pickStr(props, "OBJECTID", "objectid") || ref || `parcel-${i}`,
      ref: ref || label,
      label,
      area: pickNum(props, "areaValue", "area"),
      rings,
    });
  }
  return parcels;
}

/**
 * Fetch every parcel intersecting a `radius`-metre disc around the Stereo 70
 * point (eastings, northings), following resultOffset pagination past the
 * 1000-feature cap. Throws on network/CORS failure (the caller offers a paste
 * fallback).
 */
export async function fetchParcels(eastings: number, northings: number, radius: number): Promise<Parcel[]> {
  const all: Parcel[] = [];
  let offset = 0;
  // Safety bound: 20 pages = 20k parcels, far beyond any realistic 500 m disc.
  for (let page = 0; page < 20; page++) {
    const res = await fetch(queryUrl(eastings, northings, radius, offset));
    if (!res.ok) throw new Error(`ANCPI ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json?.error) throw new Error(json.error?.message || "ANCPI service error");
    const batch = parseParcels(json);
    all.push(...batch);
    const returned = Array.isArray(json?.features) ? json.features.length : 0;
    if (returned < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}
