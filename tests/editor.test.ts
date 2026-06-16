import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { IfcParser, getRawNamedAttributes } from "@ifc-lite/parser";
import { IfcEditor } from "../src/ifc/editor";

// Uses a real IFC so the model is valid; skips gracefully if absent so the
// suite is portable. Override with IFC_SAMPLE=<path>.
const SAMPLE =
  process.env.IFC_SAMPLE ?? "C:/Users/Dannyx/Downloads/+NZEB_Expo_2026_Romexpo_B2.ifc";
const hasSample = fs.existsSync(SAMPLE);

async function countBeneficiarRels(bytes: Uint8Array): Promise<number> {
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  let n = 0;
  for (const id of store.entityIndex.byType.get("IFCRELASSIGNSTOACTOR") ?? []) {
    const e = (store as any).getEntity(id);
    const name = getRawNamedAttributes(e).find((p) => p.name === "Name")?.raw;
    if (name === "Beneficiar") n++;
  }
  return n;
}

describe.runIf(hasSample)("IfcEditor round-trip", () => {
  it("edits project, psets and beneficiary; values survive export+reopen", async () => {
    const ed = await IfcEditor.open(new Uint8Array(fs.readFileSync(SAMPLE)));
    const proj = ed.getProject();
    expect(proj).toBeTruthy();
    const site = ed.getSites()[0];
    expect(site).toBeTruthy();

    ed.setProject("NR-123", "Proiect Test");
    ed.setPsetValue(site.expressID, "PSet_LandRegistration", "LandTitleID", "CF-555");
    ed.setPsetValue(site.expressID, "PSet_LandRegistration", "LandId", "CAD-999");
    ed.setPsetValue(site.expressID, "PSet_Address", "Town", "Cluj-Napoca");
    ed.setPsetValue(site.expressID, "PSet_Address", "Country", "Romania");
    // Apply beneficiary twice (org then person) — must NOT duplicate.
    ed.upsertBeneficiar(proj!.expressID, "ACME SRL", true);
    ed.upsertBeneficiar(proj!.expressID, "Ion Popescu", false);
    // Georeferencing (Stereo 70 / EPSG:3844). Apply twice to exercise the
    // upsert path (second call must update, not duplicate).
    const georefSupported = ed.supportsGeoref();
    if (georefSupported) {
      ed.setGeoref({
        crsName: "EPSG:3844", eastings: 1, northings: 2, height: 3, rotationDeg: 10, scale: 1,
      });
      ed.setGeoref({
        crsName: "EPSG:3844", eastings: 500123.45, northings: 412987.1, height: 120, rotationDeg: 0, scale: 1,
      });
    }

    const out = ed.export();
    ed.close();

    const ed2 = await IfcEditor.open(out);
    const proj2 = ed2.getProject()!;
    const site2 = ed2.getSites()[0];

    expect(proj2.name).toBe("NR-123");
    expect(proj2.longName).toBe("Proiect Test");
    expect(ed2.getPsetValue(site2.expressID, "PSet_LandRegistration", "LandTitleID")).toBe("CF-555");
    expect(ed2.getPsetValue(site2.expressID, "PSet_LandRegistration", "LandId")).toBe("CAD-999");
    expect(ed2.getPsetValue(site2.expressID, "PSet_Address", "Town")).toBe("Cluj-Napoca");
    expect(ed2.getPsetValue(site2.expressID, "PSet_Address", "Country")).toBe("Romania");

    expect(await countBeneficiarRels(out)).toBe(1);
    const ben = ed2.getBeneficiar();
    expect(ben?.name).toBe("Ion Popescu");
    expect(ben?.isOrg).toBe(false);

    if (georefSupported) {
      const g = ed2.getGeoref();
      expect(g).toBeTruthy();
      expect(g!.crsName).toBe("EPSG:3844");
      expect(g!.eastings).toBeCloseTo(500123.45, 2);
      expect(g!.northings).toBeCloseTo(412987.1, 2);
      expect(g!.height).toBeCloseTo(120, 2);
      expect(g!.rotationDeg).toBeCloseTo(0, 4);
      expect(g!.scale).toBeCloseTo(1, 4);
    }

    ed2.close();
  });
});
