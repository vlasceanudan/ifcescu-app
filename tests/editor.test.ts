import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { IfcAPI, IFCRELASSIGNSTOACTOR } from "web-ifc";
import { IfcEditor } from "../src/ifc/editor";

// Uses a real IFC so the model is valid; skips gracefully if absent so the
// suite is portable. Override with IFC_SAMPLE=<path>.
const SAMPLE =
  process.env.IFC_SAMPLE ?? "C:/Users/Dannyx/Downloads/+NZEB_Expo_2026_Romexpo_B2.ifc";
const hasSample = fs.existsSync(SAMPLE);

function countBeneficiarRels(api: IfcAPI, modelID: number): number {
  const vec = api.GetLineIDsWithType(modelID, IFCRELASSIGNSTOACTOR);
  let n = 0;
  for (let i = 0; i < vec.size(); i++) {
    const rel = api.GetLine(modelID, vec.get(i));
    if (rel?.Name?.value === "Beneficiar") n++;
  }
  return n;
}

describe.runIf(hasSample)("IfcEditor round-trip", () => {
  it("edits project, psets and beneficiary; values survive export+reopen", async () => {
    const api = new IfcAPI();
    await api.Init();

    const ed = IfcEditor.open(api, new Uint8Array(fs.readFileSync(SAMPLE)));
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

    const out = ed.export();
    ed.close();

    const ed2 = IfcEditor.open(api, out);
    const proj2 = ed2.getProject()!;
    const site2 = ed2.getSites()[0];

    expect(proj2.name).toBe("NR-123");
    expect(proj2.longName).toBe("Proiect Test");
    expect(ed2.getPsetValue(site2.expressID, "PSet_LandRegistration", "LandTitleID")).toBe("CF-555");
    expect(ed2.getPsetValue(site2.expressID, "PSet_LandRegistration", "LandId")).toBe("CAD-999");
    expect(ed2.getPsetValue(site2.expressID, "PSet_Address", "Town")).toBe("Cluj-Napoca");
    expect(ed2.getPsetValue(site2.expressID, "PSet_Address", "Country")).toBe("Romania");

    expect(countBeneficiarRels(api, ed2.modelID)).toBe(1);
    const ben = ed2.getBeneficiar();
    expect(ben?.name).toBe("Ion Popescu");
    expect(ben?.isOrg).toBe(false);

    ed2.close();
  });
});
