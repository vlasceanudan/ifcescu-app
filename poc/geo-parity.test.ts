// Sanity-check the @ifc-lite globe geometry reconstruction (Y-up→IFC Z-up + RTC).
// Expectation: the "real coords" model (SP4) bbox sits around its Stereo 70 origin
// (E≈4.7e5, N≈4.0e5); the georeferenced topo plan is local (small) coords.
import { describe, it, expect } from "vitest";
import { extractMergedMeshFromBytes } from "../src/geo/extractGeometry";
import { ensureIfcLiteWasm } from "./wasm-init";
import { PLAN_SAMPLE, LARGE_SAMPLE, hasPlan, hasLarge, readBytes } from "./samples";

describe("globe geometry reconstruction", () => {
  it.runIf(hasPlan)("plan model bbox", async () => {
    await ensureIfcLiteWasm();
    const m = await extractMergedMeshFromBytes(readBytes(PLAN_SAMPLE));
    console.log("[geo:plan] verts", m.vertexCount, "tris", m.triangleCount, "bbox", JSON.stringify(m.bbox));
    expect(m.vertexCount).toBeGreaterThan(0);
  }, 120_000);

  it.runIf(hasLarge)("large model bbox sits near Stereo 70 origin", async () => {
    await ensureIfcLiteWasm();
    const m = await extractMergedMeshFromBytes(readBytes(LARGE_SAMPLE));
    const cx = (m.bbox.minX + m.bbox.maxX) / 2;
    const cy = (m.bbox.minY + m.bbox.maxY) / 2;
    console.log("[geo:large] verts", m.vertexCount, "tris", m.triangleCount, "centerXY", cx.toFixed(1), cy.toFixed(1), "bbox", JSON.stringify(m.bbox));
    expect(m.vertexCount).toBeGreaterThan(0);
    // SP4 geometry is authored in real Stereo 70 metres → center in Romania range.
    expect(cx).toBeGreaterThan(100000);
    expect(cx).toBeLessThan(900000);
    expect(cy).toBeGreaterThan(200000);
    expect(cy).toBeLessThan(800000);
  }, 300_000);
});
