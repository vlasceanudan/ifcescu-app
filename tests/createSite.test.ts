import { describe, it, expect } from "vitest";
import { IfcAPI, IFCRELAGGREGATES } from "web-ifc";
import { IfcEditor } from "../src/ifc/editor";

// Minimal, self-contained IFC4 model: an IfcProject with a geometric context
// and units, but deliberately NO IfcSite. Exercises the "add IfcSite" path
// that unblocks files which would otherwise fail with "Nu s-a găsit niciun
// IfcSite în model.".
const NO_SITE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('no-site.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Test',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#3=IFCUNITASSIGNMENT((#5));
#4=IFCAXIS2PLACEMENT3D(#6,$,$);
#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
`;

describe("IfcEditor.createSite", () => {
  it("adds an IfcSite to a site-less model; it survives export+reopen and edits", async () => {
    const api = new IfcAPI();
    await api.Init();

    const bytes = new TextEncoder().encode(NO_SITE_IFC);
    const ed = IfcEditor.open(api, bytes);

    expect(ed.getProject()).toBeTruthy();
    expect(ed.getSites().length).toBe(0);

    const created = ed.createSite("Teren");
    expect(created).toBeTruthy();
    expect(created!.name).toBe("Teren");

    // The new site is now visible and editable in-memory.
    const sites = ed.getSites();
    expect(sites.length).toBe(1);
    ed.setPsetValue(sites[0].expressID, "PSet_LandRegistration", "LandTitleID", "CF-777");

    const out = ed.export();
    ed.close();

    // Reopen the exported file: the site, its GlobalId, and the pset persist.
    const ed2 = IfcEditor.open(api, out);
    const sites2 = ed2.getSites();
    expect(sites2.length).toBe(1);
    expect(sites2[0].name).toBe("Teren");
    expect(sites2[0].globalId).toBe(created!.globalId);
    expect(ed2.getPsetValue(sites2[0].expressID, "PSet_LandRegistration", "LandTitleID")).toBe(
      "CF-777",
    );

    // The site is wired into the spatial tree via IfcProject -> IfcRelAggregates.
    const rels = api.GetLineIDsWithType(ed2.modelID, IFCRELAGGREGATES);
    let linked = false;
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(ed2.modelID, rels.get(i));
      const related: Array<{ value: number }> = rel.RelatedObjects ?? [];
      if (
        rel.RelatingObject?.value === ed2.getProject()!.expressID &&
        related.some((h) => h.value === sites2[0].expressID)
      ) {
        linked = true;
      }
    }
    expect(linked).toBe(true);

    ed2.close();
  });
});
