// Pasul 0 — smoke test: confirm the REAL @ifc-lite API surface (the docs were
// summarised by a small model, so we verify empirically before the heavy tests).
// Also discovers the big unknown: does @ifc-lite/geometry's WASM init+process
// run headless in Node? (If not, only the geometry bench moves to a browser page.)
import { describe, it, expect } from "vitest";
import { IfcParser, extractGeoreferencingOnDemand } from "@ifc-lite/parser";
import { GeometryProcessor } from "@ifc-lite/geometry";
import { PLAN_SAMPLE, hasPlan, readArrayBuffer, readBytes } from "./samples";
import { ensureIfcLiteWasm } from "./wasm-init";

describe.runIf(hasPlan)("@ifc-lite smoke", () => {
  it("parseColumnar parses the plan model and exposes the expected store shape", async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(readArrayBuffer(PLAN_SAMPLE));

    // Store shape we rely on downstream.
    expect(store).toBeTruthy();
    expect(store.entityIndex?.byType).toBeInstanceOf(Map);
    const types = [...store.entityIndex.byType.keys()];
    console.log("[smoke] schema entity types present:", types.length);
    console.log("[smoke] has IFCMAPCONVERSION:", store.entityIndex.byType.has("IFCMAPCONVERSION"));
    console.log("[smoke] parseTime(ms):", (store as any).parseTime);

    // Georef extractor returns something for this georeferenced file.
    const georef = extractGeoreferencingOnDemand(store);
    console.log("[smoke] georef:", JSON.stringify(georef));
    expect(georef?.hasGeoreference).toBe(true);
    expect(georef?.mapConversion).toBeTruthy();
  });

  it("GeometryProcessor init()+process() runs headless in Node (or reports why not)", async () => {
    const proc = new GeometryProcessor();
    let initOk = false;
    try {
      await ensureIfcLiteWasm(); // headless WASM bootstrap (see wasm-init.ts)
      await proc.init();
      initOk = true;
      const result = await proc.process(readBytes(PLAN_SAMPLE));
      console.log(
        "[smoke] geometry OK — meshes:",
        result.meshes.length,
        "triangles:",
        result.totalTriangles,
        "vertices:",
        result.totalVertices,
      );
      expect(result.totalTriangles).toBeGreaterThan(0);
    } catch (err) {
      // Don't hard-fail the suite: this test's JOB is to report headless
      // viability. A failure here just routes the geometry bench to a browser page.
      console.warn(
        `[smoke] geometry headless NOT viable (init=${initOk}):`,
        (err as Error)?.message ?? err,
      );
      expect.soft(initOk, "WASM init reached process()").toBe(true);
    } finally {
      proc.dispose?.();
    }
  });
});
