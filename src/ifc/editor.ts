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
  IFCRELAGGREGATES,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELASSIGNSTOACTOR,
  IFCORGANIZATION,
  IFCPERSON,
  IFCLABEL,
  IFCMAPCONVERSION,
  IFCPROJECTEDCRS,
  IFCGEOMETRICREPRESENTATIONCONTEXT,
  IFCLENGTHMEASURE,
  IFCREAL,
} from "web-ifc";
import { newIfcGuid } from "./guid";
import { resolveModelSchema } from "./api";
import { BENEFICIAR_REL_NAME, STEREO70 } from "./constants";

const REF = 5;
const STR = 1;
const ENUM = 3;

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
export interface GeorefInfo {
  /** Projected CRS name, e.g. "EPSG:3844". */
  crsName: string;
  /** Eastings (X / Est) of the model origin in the projected CRS. */
  eastings: number;
  /** Northings (Y / Nord) of the model origin in the projected CRS. */
  northings: number;
  /** Orthogonal height (cotă) of the model origin. */
  height: number;
  /** Grid rotation of the model X axis towards north, in degrees. */
  rotationDeg: number;
  /** Uniform scale from model units to the projected CRS. */
  scale: number;
}

type Handle = { value: number; type: number };

/** Read the .value out of a web-ifc attribute object, defaulting to "". */
function val(attr: any): string {
  return attr && typeof attr === "object" && "value" in attr && attr.value != null
    ? String(attr.value)
    : "";
}

/** Read a numeric .value out of a web-ifc attribute object, defaulting to `dflt`. */
function numAttr(attr: any, dflt = 0): number {
  const n =
    attr && typeof attr === "object" && "value" in attr ? Number(attr.value) : Number(attr);
  return Number.isFinite(n) ? n : dflt;
}

/** Render a number as a STEP-valid REAL literal (always has a decimal point). */
function stepReal(n: number): string {
  let s = String(n);
  if (!/[.eE]/.test(s)) s += ".";
  return s;
}

/** Decode bytes as latin1 so every byte maps 1:1 to a char code (round-trips). */
function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}
/** Inverse of decodeLatin1 — byte-perfect, so untouched original lines survive. */
function encodeLatin1(s: string): Uint8Array {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}

/** Repair web-ifc's malformed reals like "1.71646E+09." (invalid trailing dot). */
function sanitizeReals(s: string): string {
  return s.replace(/(E[+-]?\d+)\./gi, "$1");
}

/**
 * Split a STEP DATA-section body into `#id=…;` records, respecting single-quoted
 * strings (so a ';' inside a label doesn't end a record early). Returns records
 * in file order, each including its trailing ';'.
 */
function splitRecords(body: string): { id: number; text: string }[] {
  const recs: { id: number; text: string }[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n || body[i] !== "#") {
      i++;
      continue;
    }
    const start = i;
    let inStr = false;
    for (; i < n; i++) {
      const c = body[i];
      if (inStr) {
        if (c === "'") {
          if (body[i + 1] === "'") i++; // escaped quote
          else inStr = false;
        }
      } else if (c === "'") {
        inStr = true;
      } else if (c === ";") {
        i++;
        break;
      }
    }
    const text = body.slice(start, i).trim();
    const m = /^#(\d+)=/.exec(text);
    if (m) recs.push({ id: Number(m[1]), text });
  }
  return recs;
}

/** Map expressID → record text for a STEP file's DATA section. */
function recordsMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const ds = text.indexOf("DATA;");
  const es = ds >= 0 ? text.indexOf("ENDSEC;", ds) : -1;
  if (ds < 0 || es < 0) return map;
  for (const r of splitRecords(text.slice(ds + 5, es))) map.set(r.id, r.text);
  return map;
}

/**
 * Rebuild a STEP file from the original text, replacing only the `touched`
 * existing records with their freshly-serialised versions and appending the
 * newly-created ones — leaving all other (geometry/placement/owner-history)
 * lines exactly as authored.
 */
function spliceRecords(
  originalText: string,
  touched: Set<number>,
  baseMaxId: number,
  out: Map<number, string>,
): string {
  const ds = originalText.indexOf("DATA;");
  const es = ds >= 0 ? originalText.indexOf("ENDSEC;", ds) : -1;
  if (ds < 0 || es < 0) return sanitizeReals(originalText); // not parseable — leave as is
  const head = originalText.slice(0, ds + 5);
  const body = originalText.slice(ds + 5, es);
  const foot = originalText.slice(es);

  const records = splitRecords(body);
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const r of records) {
    seen.add(r.id);
    if (touched.has(r.id) && out.has(r.id)) lines.push(sanitizeReals(out.get(r.id)!));
    else lines.push(r.text);
  }
  // Append created lines (ascending id) that weren't in the original.
  const created = [...touched].filter((id) => id > baseMaxId && !seen.has(id) && out.has(id));
  created.sort((a, b) => a - b);
  for (const id of created) lines.push(sanitizeReals(out.get(id)!));

  return head + "\n" + lines.join("\n") + "\n" + foot;
}

/** Re-inject full-precision georef into the (single) IfcMapConversion line. */
function patchMapConversionText(text: string, g: GeorefInfo): string {
  const re = /(#\d+=IFCMAPCONVERSION\()([^)]*)(\)\s*;)/i;
  const m = text.match(re);
  if (!m) return text;
  const args = m[2].split(",");
  if (args.length < 8) return text; // 2 refs + 6 reals expected
  const theta = (g.rotationDeg * Math.PI) / 180;
  args[2] = stepReal(g.eastings);
  args[3] = stepReal(g.northings);
  args[4] = stepReal(g.height);
  args[5] = stepReal(Math.cos(theta));
  args[6] = stepReal(Math.sin(theta));
  args[7] = stepReal(g.scale);
  return text.replace(re, `$1${args.join(",")}$3`);
}

export class IfcEditor {
  private nextId: number;
  /**
   * Exact georef values captured by setGeoref. web-ifc 0.0.39 serialises REALs
   * at only ~6 significant figures, which truncates Stereo 70 eastings/northings
   * (e.g. 500123.45 → 500123). We re-inject full precision into the exported
   * STEP text — see export().
   */
  private georefExact: GeorefInfo | null = null;

  /** The original file as STEP text (latin1) — kept verbatim on export. */
  private originalText: string;
  /** Max expressID present in the original file; anything above is a new line. */
  private baseMaxId: number;
  /** ExpressIDs we created or modified, so export only re-serialises those. */
  private touched = new Set<number>();

  private constructor(
    private api: IfcAPI,
    public modelID: number,
    bytes: Uint8Array,
  ) {
    this.nextId = api.GetMaxExpressID(modelID);
    this.baseMaxId = this.nextId;
    this.originalText = decodeLatin1(bytes);
  }

  static open(api: IfcAPI, bytes: Uint8Array): IfcEditor {
    const modelID = api.OpenModel(bytes);
    // web-ifc 0.0.39 can't map an "IFC4X3" header to its schema table; fix it
    // so GetLine works for IFC4X3 site/infrastructure files.
    resolveModelSchema(api, modelID, bytes);
    return new IfcEditor(api, modelID, bytes);
  }

  /** Write a line and remember its expressID so export() re-serialises it. */
  private writeLine(line: any): void {
    this.api.WriteLine(this.modelID, line);
    if (typeof line?.expressID === "number") this.touched.add(line.expressID);
  }

  schema(): string {
    return this.api.GetModelSchema(this.modelID);
  }

  close(): void {
    this.api.CloseModel(this.modelID);
  }

  /**
   * Export the enriched model. We do NOT round-trip the whole model through
   * web-ifc's serialiser — its 0.0.39 build writes large numbers with only ~6
   * significant figures AND an invalid trailing dot (e.g. 1716464774 →
   * "1.71646E+09."), which both distorts placement geometry and produces files
   * other viewers reject. Instead we keep every original line byte-for-byte and
   * splice in only the handful of lines we created/modified (taken from web-ifc's
   * output), then re-inject full georef precision.
   */
  export(): Uint8Array {
    let text = this.originalText;
    if (this.touched.size) {
      const outText = decodeLatin1(this.saveModel());
      const out = recordsMap(outText);
      text = spliceRecords(this.originalText, this.touched, this.baseMaxId, out);
    }
    if (this.georefExact) text = patchMapConversionText(text, this.georefExact);
    return encodeLatin1(text);
  }

  /**
   * Serialise the model to IFC bytes. web-ifc 0.0.39's SaveModel/ExportFileAsIFC
   * pre-sizes its output buffer from GetModelSize() + 512 bytes, but that count
   * is too small once we add lines (psets, georef, a new site …), so its internal
   * `dataBuffer.set(src)` throws "offset is out of bounds". We bypass that by
   * driving the WASM serializer directly and allocating exactly the bytes it
   * returns. Falls back to the library call if the internal module isn't exposed.
   */
  private saveModel(): Uint8Array {
    const wasm = (this.api as any).wasmModule;
    if (!wasm?.SaveModel || !wasm?.HEAPU8) return this.api.SaveModel(this.modelID);
    let out = new Uint8Array(0);
    wasm.SaveModel(this.modelID, (srcPtr: number, srcSize: number) => {
      out = new Uint8Array(srcSize);
      out.set(wasm.HEAPU8.subarray(srcPtr, srcPtr + srcSize), 0);
    });
    return out;
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
  private enumVal(value: string): any {
    return { value, type: ENUM };
  }
  private label(value: string): any {
    return this.api.CreateIfcType(this.modelID, IFCLABEL, value);
  }
  /** Build a typed numeric value (IfcLengthMeasure, IfcReal, …). */
  private num(typeCode: number, value: number): any {
    return this.api.CreateIfcType(this.modelID, typeCode, value);
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
    this.writeLine(line);
  }

  // --- sites --------------------------------------------------------------
  getSites(): SiteInfo[] {
    return this.idsOfType(IFCSITE).map((id) => {
      const line = this.api.GetLine(this.modelID, id);
      return { expressID: id, name: val(line.Name), globalId: val(line.GlobalId) };
    });
  }

  /**
   * Create a new IfcSite and aggregate it under the IfcProject. Used when a
   * model carries an IfcProject but no IfcSite — the editor needs a site to
   * attach land-registration / address property sets to (georeferencing is
   * context-level, so the site stays geometry-free). Returns null if there is
   * no IfcProject to aggregate under.
   */
  createSite(name = "Teren"): SiteInfo | null {
    const projectIDs = this.idsOfType(IFCPROJECT);
    if (!projectIDs.length) return null;

    const guid = newIfcGuid();
    const site = this.create(IFCSITE);
    site.GlobalId = this.str(guid);
    site.Name = this.str(name);
    // IfcElementCompositionEnum (type 3 = enum). "ELEMENT" is mandatory in
    // IFC2x3 and the conventional value for a leaf site in IFC4.
    site.CompositionType = this.enumVal("ELEMENT");
    this.writeLine(site);

    // Tie the site into the spatial hierarchy: IfcProject --aggregates--> IfcSite.
    const rel = this.create(IFCRELAGGREGATES);
    rel.GlobalId = this.str(newIfcGuid());
    rel.RelatingObject = this.ref(projectIDs[0]);
    rel.RelatedObjects = [this.ref(site.expressID)];
    this.writeLine(rel);

    return { expressID: site.expressID, name, globalId: guid };
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
          this.writeLine(p);
          return;
        }
      }
      // Otherwise append a new property to the existing PSet.
      const psv = this.makePropertySingleValue(prop, value);
      pset.HasProperties = [...(pset.HasProperties ?? []), this.ref(psv.expressID)];
      this.writeLine(pset);
      return;
    }

    // No PSet yet: create property + set + relationship.
    const psv = this.makePropertySingleValue(prop, value);
    pset = this.create(IFCPROPERTYSET);
    pset.GlobalId = this.str(newIfcGuid());
    pset.Name = this.str(psetName);
    pset.HasProperties = [this.ref(psv.expressID)];
    this.writeLine(pset);

    const rel = this.create(IFCRELDEFINESBYPROPERTIES);
    rel.GlobalId = this.str(newIfcGuid());
    rel.RelatedObjects = [this.ref(productID)];
    rel.RelatingPropertyDefinition = this.ref(pset.expressID);
    this.writeLine(rel);
  }

  private makePropertySingleValue(prop: string, value: string): any {
    const psv = this.create(IFCPROPERTYSINGLEVALUE);
    psv.Name = this.str(prop);
    psv.NominalValue = this.label(value);
    this.writeLine(psv);
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
      this.writeLine(existing);
      return;
    }
    const rel = this.create(IFCRELASSIGNSTOACTOR);
    rel.GlobalId = this.str(newIfcGuid());
    rel.Name = this.str(BENEFICIAR_REL_NAME);
    rel.RelatedObjects = [this.ref(projectID)];
    rel.RelatingActor = this.ref(actor.expressID);
    this.writeLine(rel);
  }

  private makeActor(name: string, isOrg: boolean): any {
    if (isOrg) {
      const org = this.create(IFCORGANIZATION);
      org.Name = this.str(name);
      this.writeLine(org);
      return org;
    }
    const parts = name.split(/\s+/).filter(Boolean);
    const given = parts.shift() ?? "";
    const family = parts.join(" ");
    const person = this.create(IFCPERSON);
    if (given) person.GivenName = this.str(given);
    if (family) person.FamilyName = this.str(family);
    this.writeLine(person);
    return person;
  }

  // --- georeferencing -----------------------------------------------------
  // IFC4 "Level 50" georeferencing: an IfcMapConversion ties the model's 3D
  // IfcGeometricRepresentationContext (SourceCRS) to an IfcProjectedCRS
  // (TargetCRS, e.g. EPSG:3844 / Stereo 70). Rotation is stored as the model
  // X-axis direction vector (XAxisAbscissa = cos θ, XAxisOrdinate = sin θ).

  /** True when the schema supports IfcMapConversion (IFC4 / IFC4x3, not IFC2x3). */
  supportsGeoref(): boolean {
    return !(this.schema() ?? "").toUpperCase().startsWith("IFC2X3");
  }

  private firstMapConversion(): any | null {
    const ids = this.idsOfType(IFCMAPCONVERSION);
    return ids.length ? this.api.GetLine(this.modelID, ids[0]) : null;
  }

  /** The model's 3D ("Model") geometric representation context, if any. */
  private modelContextID(): number | null {
    const ids = this.idsOfType(IFCGEOMETRICREPRESENTATIONCONTEXT);
    let fallback: number | null = null;
    for (const id of ids) {
      const ctx = this.api.GetLine(this.modelID, id);
      // Skip subcontexts (they carry their own type code, not this one).
      if (ctx.type !== IFCGEOMETRICREPRESENTATIONCONTEXT) continue;
      if (fallback == null) fallback = id;
      if (val(ctx.ContextType) === "Model") return id;
    }
    return fallback;
  }

  getGeoref(): GeorefInfo | null {
    const mc = this.firstMapConversion();
    if (!mc) return null;
    const ax = mc.XAxisAbscissa != null ? numAttr(mc.XAxisAbscissa, 1) : 1;
    const ay = mc.XAxisOrdinate != null ? numAttr(mc.XAxisOrdinate, 0) : 0;
    let crsName = "";
    if (mc.TargetCRS) {
      const crs = this.api.GetLine(this.modelID, mc.TargetCRS.value);
      crsName = val(crs?.Name);
    }
    return {
      crsName,
      eastings: numAttr(mc.Eastings),
      northings: numAttr(mc.Northings),
      height: numAttr(mc.OrthogonalHeight),
      rotationDeg: (Math.atan2(ay, ax) * 180) / Math.PI,
      scale: mc.Scale != null ? numAttr(mc.Scale, 1) : 1,
    };
  }

  /**
   * Create or update the model's IfcMapConversion (+ IfcProjectedCRS). Returns
   * false if the schema can't represent it (IFC2x3) or there is no 3D context.
   */
  setGeoref(info: GeorefInfo): boolean {
    if (!this.supportsGeoref()) return false;
    const contextID = this.modelContextID();
    if (contextID == null) return false;
    this.georefExact = { ...info };

    const theta = (info.rotationDeg * Math.PI) / 180;
    const abscissa = Math.cos(theta);
    const ordinate = Math.sin(theta);

    let mc = this.firstMapConversion();
    if (mc) {
      mc.Eastings = this.num(IFCLENGTHMEASURE, info.eastings);
      mc.Northings = this.num(IFCLENGTHMEASURE, info.northings);
      mc.OrthogonalHeight = this.num(IFCLENGTHMEASURE, info.height);
      mc.XAxisAbscissa = this.num(IFCREAL, abscissa);
      mc.XAxisOrdinate = this.num(IFCREAL, ordinate);
      mc.Scale = this.num(IFCREAL, info.scale);
      if (mc.TargetCRS) {
        const crs = this.api.GetLine(this.modelID, mc.TargetCRS.value);
        crs.Name = this.str(info.crsName || STEREO70.name);
        crs.Description = this.str(STEREO70.description);
        this.writeLine(crs);
      }
      this.writeLine(mc);
      return true;
    }

    const crs = this.create(IFCPROJECTEDCRS);
    crs.Name = this.str(info.crsName || STEREO70.name);
    crs.Description = this.str(STEREO70.description);
    crs.GeodeticDatum = this.str(STEREO70.geodeticDatum);
    crs.VerticalDatum = this.str(STEREO70.verticalDatum);
    crs.MapProjection = this.str(STEREO70.mapProjection);
    this.writeLine(crs);

    mc = this.create(IFCMAPCONVERSION);
    mc.SourceCRS = this.ref(contextID);
    mc.TargetCRS = this.ref(crs.expressID);
    mc.Eastings = this.num(IFCLENGTHMEASURE, info.eastings);
    mc.Northings = this.num(IFCLENGTHMEASURE, info.northings);
    mc.OrthogonalHeight = this.num(IFCLENGTHMEASURE, info.height);
    mc.XAxisAbscissa = this.num(IFCREAL, abscissa);
    mc.XAxisOrdinate = this.num(IFCREAL, ordinate);
    mc.Scale = this.num(IFCREAL, info.scale);
    this.writeLine(mc);
    return true;
  }
}
