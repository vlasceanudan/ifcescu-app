import { describe, it, expect, vi, afterEach } from "vitest";
import { PropertyValueType } from "@ifc-lite/data";
import { IfcEditor } from "../src/ifc/editor";
import { listDictionaries, searchClasses, getClass } from "../src/ifc/bsdd";

// --- bSDD client parsing (fetch mocked) ----------------------------------
function mockFetch(map: (url: string) => any) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => map(String(url)),
  })));
}
afterEach(() => vi.unstubAllGlobals());

describe("bSDD client", () => {
  it("parses the dictionary list", async () => {
    mockFetch(() => ({
      dictionaries: [
        { uri: "u:ifc", name: "IFC", version: "4.3", organizationNameOwner: "bS" },
        { uri: "u:uni", name: "Uniclass 2015", version: "1.0", organizationCodeOwner: "NBS" },
      ],
    }));
    const d = await listDictionaries();
    expect(d.map((x) => x.name)).toEqual(["IFC", "Uniclass 2015"]);
    expect(d[0].uri).toBe("u:ifc");
  });

  it("flattens class search results from dictionaries[].classes[]", async () => {
    mockFetch(() => ({
      dictionaries: [
        { uri: "u:ifc", name: "IFC", classes: [{ uri: "c:wall", code: "IfcWall", name: "Wall" }] },
      ],
    }));
    const hits = await searchClasses("wall");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ uri: "c:wall", code: "IfcWall", name: "Wall", dictionaryName: "IFC" });
  });

  it("parses a class with its properties", async () => {
    mockFetch(() => ({
      uri: "c:wall", code: "Pr_20", name: "Wall", dictionaryUri: "u:uni",
      classProperties: [
        { name: "FireRating", code: "FR", propertySet: "Pset_WallCommon", dataType: "String", uri: "p:fr" },
        { name: "LoadBearing", propertySet: "Pset_WallCommon", dataType: "Boolean", uri: "p:lb" },
      ],
    }));
    const cls = await getClass("c:wall");
    expect(cls.name).toBe("Wall");
    expect(cls.classProperties).toHaveLength(2);
    expect(cls.classProperties[0]).toMatchObject({ name: "FireRating", propertySet: "Pset_WallCommon", dataType: "String" });
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, statusText: "err", json: async () => ({}) })));
    await expect(getClass("c:x")).rejects.toThrow(/bSDD 500/);
  });
});

describe("bsddTypeToPropType", () => {
  it("maps bSDD data types to PropertyValueType", () => {
    expect(IfcEditor.bsddTypeToPropType("Boolean")).toBe(PropertyValueType.Boolean);
    expect(IfcEditor.bsddTypeToPropType("Integer")).toBe(PropertyValueType.Integer);
    expect(IfcEditor.bsddTypeToPropType("Real")).toBe(PropertyValueType.Real);
    expect(IfcEditor.bsddTypeToPropType("String")).toBe(PropertyValueType.Text);
    expect(IfcEditor.bsddTypeToPropType(undefined)).toBe(PropertyValueType.Text);
  });
});

// --- editor: classification + properties survive export -------------------
const TINY_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('tiny.ifc','2026-01-01T00:00:00',(''),(''),'','','');
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

describe("IfcEditor bSDD assignment", () => {
  it("writes IfcClassificationReference + IfcRelAssociatesClassification and bSDD properties", async () => {
    const ed = await IfcEditor.open(new TextEncoder().encode(TINY_IFC));
    expect(ed.hasChanges()).toBe(false);

    ed.assignClassification([1], {
      dictionaryUri: "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3",
      dictionaryName: "IFC",
      classUri: "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall",
      code: "IfcWall",
      name: "Wall",
    });
    ed.applyBsddProperties([1], [{ pset: "Pset_WallCommon", name: "FireRating", value: "REI 90", dataType: "String" }]);

    expect(ed.hasChanges()).toBe(true);
    expect(ed.changeCount()).toBeGreaterThanOrEqual(2);

    const out = new TextDecoder().decode(ed.export());
    expect(out).toContain("IFCCLASSIFICATION(");
    expect(out).toContain("IFCCLASSIFICATIONREFERENCE(");
    expect(out).toContain("'IfcWall'");
    expect(out).toContain("IFCRELASSOCIATESCLASSIFICATION(");
    expect(out).toMatch(/IFCRELASSOCIATESCLASSIFICATION\([^;]*\(#1\)/); // related object = element #1

    // Reopens cleanly and the property is present.
    const ed2 = await IfcEditor.open(new TextEncoder().encode(out));
    const val = ed2.getSelection(1).groups.find((g) => g.name === "Pset_WallCommon")?.rows.find((r) => r.name === "FireRating")?.value;
    expect(val).toBe("REI 90");
  });
});
