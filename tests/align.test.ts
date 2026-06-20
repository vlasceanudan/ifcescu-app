import { describe, it, expect } from "vitest";
import { computeGeoref, type AlignPair } from "../src/geo/align";
import type { GeorefInfo } from "../src/ifc/editor";

// Mirror of modelToStereo70() in src/geo/placement.ts — the transform the solved
// georef must satisfy. Re-projecting each model point must land on its target.
function modelToStereo70(g: GeorefInfo, x: number, y: number) {
  const t = (g.rotationDeg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return {
    e: g.eastings + g.scale * (x * c - y * s),
    n: g.northings + g.scale * (x * s + y * c),
  };
}

describe("computeGeoref (two-point alignment)", () => {
  it("recovers a known rotation + translation (rigid)", () => {
    // Ground truth: rotate model by 30°, translate to (465700, 407000).
    const truth: GeorefInfo = { crsName: "EPSG:3844", eastings: 465700, northings: 407000, height: 0, rotationDeg: 30, scale: 1 };
    const mkPair = (x: number, y: number): AlignPair => ({ model: { x, y, z: 0 }, target: modelToStereo70(truth, x, y) });
    const a = mkPair(0, 0);
    const b = mkPair(10, 0);

    const { georef, residual } = computeGeoref(a, b, null, "rigid");
    expect(georef.rotationDeg).toBeCloseTo(30, 6);
    expect(georef.eastings).toBeCloseTo(465700, 6);
    expect(georef.northings).toBeCloseTo(407000, 6);
    expect(georef.scale).toBe(1);
    expect(residual).toBeLessThan(1e-6);
  });

  it("re-projects both correspondences back onto their targets", () => {
    const a: AlignPair = { model: { x: 2, y: 5, z: 0 }, target: { e: 465712, n: 407018 } };
    const b: AlignPair = { model: { x: 18, y: 9, z: 0 }, target: { e: 465730, n: 407030 } };
    const { georef } = computeGeoref(a, b, null, "similarity");
    const pa = modelToStereo70(georef, a.model.x, a.model.y);
    const pb = modelToStereo70(georef, b.model.x, b.model.y);
    expect(pa.e).toBeCloseTo(a.target.e, 6);
    expect(pa.n).toBeCloseTo(a.target.n, 6);
    // similarity mode fits B exactly too (scale absorbs the length difference).
    expect(pb.e).toBeCloseTo(b.target.e, 6);
    expect(pb.n).toBeCloseTo(b.target.n, 6);
  });

  it("reports a non-zero residual when rigid mode can't match B's distance", () => {
    // Model A→B is 10 m; targets are 12 m apart → rigid (scale=1) leaves a 2 m gap.
    const a: AlignPair = { model: { x: 0, y: 0, z: 0 }, target: { e: 0, n: 0 } };
    const b: AlignPair = { model: { x: 10, y: 0, z: 0 }, target: { e: 12, n: 0 } };
    const { residual } = computeGeoref(a, b, null, "rigid");
    expect(residual).toBeCloseTo(2, 6);
  });

  it("carries CRS name and height from the base georef", () => {
    const base: GeorefInfo = { crsName: "EPSG:3844", eastings: 0, northings: 0, height: 87.5, rotationDeg: 0, scale: 1 };
    const a: AlignPair = { model: { x: 0, y: 0, z: 0 }, target: { e: 100, n: 200 } };
    const b: AlignPair = { model: { x: 1, y: 0, z: 0 }, target: { e: 101, n: 200 } };
    const { georef } = computeGeoref(a, b, base, "rigid");
    expect(georef.crsName).toBe("EPSG:3844");
    expect(georef.height).toBe(87.5);
  });
});
