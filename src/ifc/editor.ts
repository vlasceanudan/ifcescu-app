// Client-side IFC reader/editor/writer built on web-ifc.
//
// Reimplements the editing semantics of the original Python/ifcopenshell app
// entirely in the browser (or Node, for tests). web-ifc represents attribute
// values as { value, type } objects: type 1 = string, type 3 = enum, type 5 =
// entity reference (handle). IfcValue SELECT attributes (e.g. NominalValue) MUST
// be built with api.CreateIfcType(modelID, IFCLABEL, value) — a bare
// { value, type: 1 } serialises as an invalid OBJECT(...) and is lost on reopen.

import {
  IfcAPI,
  IFCPROJECT,
  IFCSITE,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELASSIGNSTOACTOR,
  IFCORGANIZATION,
  IFCPERSON,
  IFCLABEL,
} from "web-ifc";
import { newIfcGuid } from "./guid";
import { BENEFICIAR_REL_NAME } from "./constants";

const REF = 5;
const STR = 1;

export interface ProjectInfo {
  expressID: number;
  name: string;
  longName: string;
}
export interface SiteInfo {
  expressID: number;
  name: string;
  globalId: string;
}
export interface BeneficiarInfo {
  name: string;
  isOrg: boolean;
}

type Handle = { value: number; type: number };

/** Read the .value out of a web-ifc attribute object, defaulting to "". */
function val(attr: any): string {
  return attr && typeof attr === "object" && "value" in attr && attr.value != null
    ? String(attr.value)
    : "";
}

export class IfcEditor {
  private nextId: number;

  private constructor(
    private api: IfcAPI,
    public modelID: number,
  ) {
    this.nextId = api.GetMaxExpressID(modelID);
  }

  static open(api: IfcAPI, bytes: Uint8Array): IfcEditor {
    return new IfcEditor(api, api.OpenModel(bytes));
  }

  schema(): string {
    return this.api.GetModelSchema(this.modelID);
  }

  close(): void {
    this.api.CloseModel(this.modelID);
  }

  export(): Uint8Array {
    return this.api.ExportFileAsIFC(this.modelID);
  }

  // --- id / value helpers -------------------------------------------------
  private newId(): number {
    return ++this.nextId;
  }
  /**
   * Create a new entity and assign a fresh expressID. web-ifc's template
   * leaves every attribute `undefined`, and WriteLine OMITS undefined attrs
   * (shifting positions and corrupting the line). So normalise undefined → null
   * to force proper `$` placeholders.
   */
  private create(type: number): any {
    const e = this.api.CreateIfcEntity(this.modelID, type) as any;
    for (const k of Object.keys(e)) {
      if (k === "expressID" || k === "type") continue;
      if (e[k] === undefined) e[k] = null;
    }
    e.expressID = this.newId();
    return e;
  }
  private ref(expressID: number): Handle {
    return { value: expressID, type: REF };
  }
  private str(value: string): any {
    return { value, type: STR };
  }
  private label(value: string): any {
    return this.api.CreateIfcType(this.modelID, IFCLABEL, value);
  }
  private idsOfType(type: number): number[] {
    const vec = this.api.GetLineIDsWithType(this.modelID, type);
    const out: number[] = [];
    for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
    return out;
  }

  // --- project ------------------------------------------------------------
  getProject(): ProjectInfo | null {
    const ids = this.idsOfType(IFCPROJECT);
    if (!ids.length) return null;
    const line = this.api.GetLine(this.modelID, ids[0]);
    return { expressID: ids[0], name: val(line.Name), longName: val(line.LongName) };
  }

  setProject(name: string, longName: string): void {
    const ids = this.idsOfType(IFCPROJECT);
    if (!ids.length) return;
    const line = this.api.GetLine(this.modelID, ids[0]);
    line.Name = this.str(name);
    line.LongName = this.str(longName);
    this.api.WriteLine(this.modelID, line);
  }

  // --- sites --------------------------------------------------------------
  getSites(): SiteInfo[] {
    return this.idsOfType(IFCSITE).map((id) => {
      const line = this.api.GetLine(this.modelID, id);
      return { expressID: id, name: val(line.Name), globalId: val(line.GlobalId) };
    });
  }

  // --- property sets ------------------------------------------------------
  /** Find the IfcPropertySet of the given name attached to a product. */
  private findPset(productID: number, psetName: string): any | null {
    for (const relID of this.idsOfType(IFCRELDEFINESBYPROPERTIES)) {
      const rel = this.api.GetLine(this.modelID, relID);
      const related: Handle[] = rel.RelatedObjects ?? [];
      if (!related.some((h) => h && h.value === productID)) continue;
      const pdefHandle = rel.RelatingPropertyDefinition;
      if (!pdefHandle) continue;
      const pdef = this.api.GetLine(this.modelID, pdefHandle.value);
      if (pdef && pdef.type === IFCPROPERTYSET && val(pdef.Name) === psetName) return pdef;
    }
    return null;
  }

  getPsetValue(productID: number, psetName: string, prop: string): string {
    const pset = this.findPset(productID, psetName);
    if (!pset) return "";
    for (const h of pset.HasProperties ?? []) {
      const p = this.api.GetLine(this.modelID, h.value);
      if (p && p.type === IFCPROPERTYSINGLEVALUE && val(p.Name) === prop) {
        return val(p.NominalValue);
      }
    }
    return "";
  }

  /** Create or update a single IfcPropertySingleValue inside a named PSet. */
  setPsetValue(productID: number, psetName: string, prop: string, value: string): void {
    let pset = this.findPset(productID, psetName);

    if (pset) {
      // Update existing property if present.
      for (const h of pset.HasProperties ?? []) {
        const p = this.api.GetLine(this.modelID, h.value);
        if (p && p.type === IFCPROPERTYSINGLEVALUE && val(p.Name) === prop) {
          p.NominalValue = this.label(value);
          this.api.WriteLine(this.modelID, p);
          return;
        }
      }
      // Otherwise append a new property to the existing PSet.
      const psv = this.makePropertySingleValue(prop, value);
      pset.HasProperties = [...(pset.HasProperties ?? []), this.ref(psv.expressID)];
      this.api.WriteLine(this.modelID, pset);
      return;
    }

    // No PSet yet: create property + set + relationship.
    const psv = this.makePropertySingleValue(prop, value);
    pset = this.create(IFCPROPERTYSET);
    pset.GlobalId = this.str(newIfcGuid());
    pset.Name = this.str(psetName);
    pset.HasProperties = [this.ref(psv.expressID)];
    this.api.WriteLine(this.modelID, pset);

    const rel = this.create(IFCRELDEFINESBYPROPERTIES);
    rel.GlobalId = this.str(newIfcGuid());
    rel.RelatedObjects = [this.ref(productID)];
    rel.RelatingPropertyDefinition = this.ref(pset.expressID);
    this.api.WriteLine(this.modelID, rel);
  }

  private makePropertySingleValue(prop: string, value: string): any {
    const psv = this.create(IFCPROPERTYSINGLEVALUE);
    psv.Name = this.str(prop);
    psv.NominalValue = this.label(value);
    this.api.WriteLine(this.modelID, psv);
    return psv;
  }

  // --- beneficiary --------------------------------------------------------
  private findBeneficiarRel(): any | null {
    for (const relID of this.idsOfType(IFCRELASSIGNSTOACTOR)) {
      const rel = this.api.GetLine(this.modelID, relID);
      if (val(rel.Name) === BENEFICIAR_REL_NAME) return rel;
    }
    return null;
  }

  getBeneficiar(): BeneficiarInfo | null {
    const rel = this.findBeneficiarRel();
    if (!rel || !rel.RelatingActor) return null;
    const actor = this.api.GetLine(this.modelID, rel.RelatingActor.value);
    if (!actor) return null;
    if (actor.type === IFCORGANIZATION) return { name: val(actor.Name), isOrg: true };
    if (actor.type === IFCPERSON) {
      const name = [val(actor.GivenName), val(actor.FamilyName)].filter(Boolean).join(" ");
      return { name, isOrg: false };
    }
    return null;
  }

  /**
   * Set the project's beneficiary without creating duplicates. Updates the
   * existing "Beneficiar" assignment in place (web-ifc 0.0.39 has no DeleteLine,
   * so a replaced actor is left orphaned, which is valid IFC).
   */
  upsertBeneficiar(projectID: number, name: string, isOrg: boolean): void {
    const actor = this.makeActor(name, isOrg);
    const existing = this.findBeneficiarRel();
    if (existing) {
      existing.RelatingActor = this.ref(actor.expressID);
      this.api.WriteLine(this.modelID, existing);
      return;
    }
    const rel = this.create(IFCRELASSIGNSTOACTOR);
    rel.GlobalId = this.str(newIfcGuid());
    rel.Name = this.str(BENEFICIAR_REL_NAME);
    rel.RelatedObjects = [this.ref(projectID)];
    rel.RelatingActor = this.ref(actor.expressID);
    this.api.WriteLine(this.modelID, rel);
  }

  private makeActor(name: string, isOrg: boolean): any {
    if (isOrg) {
      const org = this.create(IFCORGANIZATION);
      org.Name = this.str(name);
      this.api.WriteLine(this.modelID, org);
      return org;
    }
    const parts = name.split(/\s+/).filter(Boolean);
    const given = parts.shift() ?? "";
    const family = parts.join(" ");
    const person = this.create(IFCPERSON);
    if (given) person.GivenName = this.str(given);
    if (family) person.FamilyName = this.str(family);
    this.api.WriteLine(this.modelID, person);
    return person;
  }
}
