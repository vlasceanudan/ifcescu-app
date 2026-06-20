// Two-point rigid/similarity georeferencing. Given two correspondences between
// IFC model points (x, y in the model plane) and real-world Stereo 70 targets
// (E, N), solve for the GeorefInfo (eastings, northings, rotationDeg, scale) that
// the existing placement pipeline consumes. This is the exact inverse of
// modelToStereo70() in ./placement.ts:
//   E = eastings  + scale·(x·cosθ − y·sinθ)
//   N = northings + scale·(x·sinθ + y·cosθ)
import type { GeorefInfo } from "../ifc/editor";

/** A model point in raw IFC coordinates (z is carried for the height term only). */
export interface ModelPoint {
  x: number;
  y: number;
  z: number;
}

/** A real-world target in projected Stereo 70 coordinates. */
export interface TargetPoint {
  e: number;
  n: number;
}

export interface AlignPair {
  model: ModelPoint;
  target: TargetPoint;
}

export type AlignMode = "rigid" | "similarity";

export interface AlignResult {
  georef: GeorefInfo;
  /** Distance (m) between the re-projected B model point and its B target — the fit quality. */
  residual: number;
}

/** Normalise an angle in degrees to (−180, 180]. */
function normDeg(d: number): number {
  let r = d % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r;
}

/**
 * Solve the georeferencing transform from two correspondences.
 *  - rotation comes from the bearing of A→B in the model vs A'→B' in Stereo 70,
 *  - translation lands model point A exactly on target A',
 *  - scale is 1 in "rigid" mode, or |A'B'|/|AB| in "similarity" mode.
 * `base` supplies the CRS name and the (2D-invisible) height term to carry over.
 */
export function computeGeoref(a: AlignPair, b: AlignPair, base: GeorefInfo | null, mode: AlignMode = "rigid"): AlignResult {
  const dmx = b.model.x - a.model.x;
  const dmy = b.model.y - a.model.y;
  const dtx = b.target.e - a.target.e;
  const dty = b.target.n - a.target.n;

  const modelLen = Math.hypot(dmx, dmy);
  const targetLen = Math.hypot(dtx, dty);

  const theta = Math.atan2(dty, dtx) - Math.atan2(dmy, dmx);
  const scale = mode === "similarity" && modelLen > 1e-9 ? targetLen / modelLen : 1;

  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const eastings = a.target.e - scale * (a.model.x * c - a.model.y * s);
  const northings = a.target.n - scale * (a.model.x * s + a.model.y * c);

  // Residual at B: how far the solved transform sends B model from its B target.
  const be = eastings + scale * (b.model.x * c - b.model.y * s);
  const bn = northings + scale * (b.model.x * s + b.model.y * c);
  const residual = Math.hypot(be - b.target.e, bn - b.target.n);

  return {
    georef: {
      crsName: base?.crsName || "EPSG:3844",
      eastings,
      northings,
      height: base?.height ?? 0,
      rotationDeg: normDeg((theta * 180) / Math.PI),
      scale,
    },
    residual,
  };
}
