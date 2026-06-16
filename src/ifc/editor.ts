// Client-side IFC reader/editor/writer built on @ifc-lite (parser + mutations + export).
//
// Replaces the previous web-ifc 0.0.39 implementation. The public IfcEditor
// interface is unchanged so EditorForm/App keep working. Edits accumulate in an
// @ifc-lite MutablePropertyView overlay and materialise at export() via StepExporter,
// which is natively non-destructive (POC: 100% of untouched lines + full Stereo 70
// precision preserved, no malformed reals) — so the old "splice" hack is gone.
import {
  extractGeoreferencingOnDemand,
  extractRootAttributesFromEntity,
  getRawNamedAttributes,
  getAllAttributesForEntity,
  deterministicGlobalId,
  type IfcDataStore,
} from "@ifc-lite/parser";
import { MutablePropertyView } from "@ifc-lite/mutations";
import { StepExporter } from "@ifc-lite/export";
import { parseStore, detectSchema, type IfcSchema } from "./store";
import { STEREO70, BENEFICIAR_REL_NAME } from "./constants";

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

/** Zero-based index of a named attribute in an entity's STEP argument list. */
function attrIndex(type: string, name: string): number {
  return getAllAttributesForEntity(type).findIndex((a) => a.name === name);
}

/** Build a full positional STEP attribute array for a NEW entity, by attribute name. */
function buildAttrs(type: string, values: Record<string, unknown>): (string | number | boolean | null)[] {
  return getAllAttributesForEntity(type).map((a) =>
    a.name in values ? (values[a.name] as any) : null,
  );
}

/** Read a named raw attribute (entity refs come back as numbers, lists as number[]). */
function rawAttr(entity: any, name: string): unknown {
  const hit = getRawNamedAttributes(entity).find((p) => p.name === name);
  return hit ? hit.raw : null;
}

export class IfcEditor {
  private view: MutablePropertyView;
  private schemaName: IfcSchema;
  private georefExact: GeorefInfo | null = null;
  private beneficiarCache: BeneficiarInfo | null = null;
  /** Project Name/LongName edits, surfaced by getProject before re-export. */
  private projectAttrCache: { name?: string; longName?: string } = {};
  /** Sites created this session (overlay entities, not yet in the store index). */
  private createdSites: SiteInfo[] = [];

  private constructor(
    private store: IfcDataStore,
    bytes: Uint8Array,
  ) {
    this.schemaName = detectSchema(bytes);
    this.view = new MutablePropertyView(null, "0");
    this.view.setExpressIdWatermark(this.maxExpressId());
    // Wire base reads so getPropertyValue returns existing + mutated values.
    this.view.setOnDemandExtractor((id) => (this.store as any).getProperties(id) ?? []);
  }

  static async open(bytes: Uint8Array): Promise<IfcEditor> {
    const store = await parseStore(bytes);
    return new IfcEditor(store, bytes);
  }

  private idsOfType(type: string): number[] {
    return this.store.entityIndex.byType.get(type) ?? [];
  }
  private getEntity(id: number): any {
    return (this.store as any).getEntity(id);
  }
  private maxExpressId(): number {
    let m = 0;
    for (const k of this.store.entityIndex.byId.keys()) if (k > m) m = k;
    const def = (this.store as any).deferredEntityIndex;
    if (def) for (const k of def.keys()) if (k > m) m = k;
    return m;
  }

  schema(): string {
    return this.schemaName;
  }
  /** No-op kept for API compatibility (no web-ifc model handle to close). */
  close(): void {}

  // --- project ------------------------------------------------------------
  getProject(): ProjectInfo | null {
    const ids = this.idsOfType("IFCPROJECT");
    if (!ids.length) return null;
    const e = this.getEntity(ids[0]);
    const root = extractRootAttributesFromEntity(e);
    const longRaw = rawAttr(e, "LongName");
    return {
      expressID: ids[0],
      name: this.projectAttrCache.name ?? root.name ?? "",
      longName: this.projectAttrCache.longName ?? (longRaw != null ? String(longRaw) : ""),
    };
  }

  setProject(name: string, longName: string): void {
    const ids = this.idsOfType("IFCPROJECT");
    if (!ids.length) return;
    const projId = ids[0];
    this.view.setAttribute(projId, "Name", name);
    const li = attrIndex("IfcProject", "LongName");
    if (li >= 0) this.view.setPositionalAttribute(projId, li, longName);
    this.projectAttrCache = { name, longName };
  }

  // --- sites --------------------------------------------------------------
  getSites(): SiteInfo[] {
    const stored = this.idsOfType("IFCSITE").map((id) => {
      const root = extractRootAttributesFromEntity(this.getEntity(id));
      return { expressID: id, name: root.name ?? "", globalId: root.globalId ?? "" };
    });
    return [...stored, ...this.createdSites];
  }

  /**
   * Create a new IfcSite and aggregate it under the IfcProject (so land/address
   * psets have somewhere to attach). Allocated immediately so the caller can
   * attach property sets to the returned expressID; both materialise at export.
   */
  createSite(name = "Teren"): SiteInfo | null {
    const projIds = this.idsOfType("IFCPROJECT");
    if (!projIds.length) return null;

    const guid = deterministicGlobalId(`site:${name}:${projIds[0]}`);
    const site = this.view.createEntity(
      "IfcSite",
      buildAttrs("IfcSite", { GlobalId: guid, Name: name, CompositionType: ".ELEMENT." }),
    );
    const relGuid = deterministicGlobalId(`agg:${site.expressId}`);
    this.view.createEntity(
      "IfcRelAggregates",
      buildAttrs("IfcRelAggregates", {
        GlobalId: relGuid,
        RelatingObject: `#${projIds[0]}`,
        RelatedObjects: [`#${site.expressId}`],
      }),
    );
    const info = { expressID: site.expressId, name, globalId: guid };
    this.createdSites.push(info);
    return info;
  }

  // --- property sets ------------------------------------------------------
  getPsetValue(productID: number, psetName: string, prop: string): string {
    const v = this.view.getPropertyValue(productID, psetName, prop);
    return v == null ? "" : String(v);
  }

  /** Create or update a single property inside a named PSet (upsert). */
  setPsetValue(productID: number, psetName: string, prop: string, value: string): void {
    this.view.setProperty(productID, psetName, prop, value);
  }

  // --- beneficiary --------------------------------------------------------
  private findBeneficiarRel(): { id: number; entity: any } | null {
    for (const id of this.idsOfType("IFCRELASSIGNSTOACTOR")) {
      const e = this.getEntity(id);
      if (String(rawAttr(e, "Name") ?? "") === BENEFICIAR_REL_NAME) return { id, entity: e };
    }
    return null;
  }

  getBeneficiar(): BeneficiarInfo | null {
    if (this.beneficiarCache) return this.beneficiarCache;
    const rel = this.findBeneficiarRel();
    if (!rel) return null;
    const actorRef = rawAttr(rel.entity, "RelatingActor");
    if (typeof actorRef !== "number") return null;
    const actor = this.getEntity(actorRef);
    if (!actor) return null;
    if (actor.type === "IFCORGANIZATION") return { name: String(rawAttr(actor, "Name") ?? ""), isOrg: true };
    if (actor.type === "IFCPERSON") {
      const name = [rawAttr(actor, "GivenName"), rawAttr(actor, "FamilyName")]
        .filter((v) => v != null && v !== "")
        .join(" ");
      return { name, isOrg: false };
    }
    return null;
  }

  /**
   * Set the project's beneficiary. Cached now and materialised at export()
   * (create the actor; update an existing "Beneficiar" relationship in place, or
   * create one) — so repeated calls never duplicate the relationship.
   */
  upsertBeneficiar(_projectID: number, name: string, isOrg: boolean): void {
    this.beneficiarCache = { name, isOrg };
  }

  private materializeBeneficiar(): void {
    if (!this.beneficiarCache) return;
    const projIds = this.idsOfType("IFCPROJECT");
    if (!projIds.length) return;
    const { name, isOrg } = this.beneficiarCache;

    let actorId: number;
    if (isOrg) {
      actorId = this.view.createEntity("IfcOrganization", buildAttrs("IfcOrganization", { Name: name })).expressId;
    } else {
      const parts = name.split(/\s+/).filter(Boolean);
      const given = parts.shift() ?? "";
      const family = parts.join(" ");
      actorId = this.view.createEntity(
        "IfcPerson",
        buildAttrs("IfcPerson", { GivenName: given || null, FamilyName: family || null }),
      ).expressId;
    }

    const existing = this.findBeneficiarRel();
    if (existing) {
      const ai = attrIndex("IfcRelAssignsToActor", "RelatingActor");
      if (ai >= 0) this.view.setPositionalAttribute(existing.id, ai, `#${actorId}`);
      return;
    }
    this.view.createEntity(
      "IfcRelAssignsToActor",
      buildAttrs("IfcRelAssignsToActor", {
        GlobalId: deterministicGlobalId(`ben:${actorId}`),
        Name: BENEFICIAR_REL_NAME,
        RelatedObjects: [`#${projIds[0]}`],
        RelatingActor: `#${actorId}`,
      }),
    );
  }

  // --- georeferencing -----------------------------------------------------
  /** True when the schema supports IfcMapConversion (IFC4 / IFC4x3, not IFC2x3). */
  supportsGeoref(): boolean {
    return this.schemaName !== "IFC2X3";
  }

  getGeoref(): GeorefInfo | null {
    if (this.georefExact) return this.georefExact;
    const g = extractGeoreferencingOnDemand(this.store);
    if (!g?.mapConversion) return null;
    const mc = g.mapConversion;
    const ax = mc.xAxisAbscissa ?? 1;
    const ay = mc.xAxisOrdinate ?? 0;
    return {
      crsName: g.projectedCRS?.name ?? "",
      eastings: mc.eastings,
      northings: mc.northings,
      height: mc.orthogonalHeight,
      rotationDeg: (Math.atan2(ay, ax) * 180) / Math.PI,
      scale: mc.scale ?? 1,
    };
  }

  /** Capture georef; applied at export (edit existing IfcMapConversion or create one). */
  setGeoref(info: GeorefInfo): boolean {
    if (!this.supportsGeoref()) return false;
    this.georefExact = { ...info };
    return true;
  }

  private materializeGeorefIfAbsent(): void {
    if (!this.georefExact) return;
    if (extractGeoreferencingOnDemand(this.store)?.mapConversion) return; // exists → handled via georefMutations
    // No IfcMapConversion in the source: create IfcProjectedCRS + IfcMapConversion,
    // tied to the 3D geometric representation context as SourceCRS.
    const ctxId = this.modelContextID();
    if (ctxId == null) return;
    const g = this.georefExact;
    const theta = (g.rotationDeg * Math.PI) / 180;
    const crsId = this.view.createEntity(
      "IfcProjectedCRS",
      buildAttrs("IfcProjectedCRS", {
        Name: g.crsName || STEREO70.name,
        Description: STEREO70.description,
        GeodeticDatum: STEREO70.geodeticDatum,
        VerticalDatum: STEREO70.verticalDatum,
        MapProjection: STEREO70.mapProjection,
      }),
    ).expressId;
    this.view.createEntity(
      "IfcMapConversion",
      buildAttrs("IfcMapConversion", {
        SourceCRS: `#${ctxId}`,
        TargetCRS: `#${crsId}`,
        Eastings: g.eastings,
        Northings: g.northings,
        OrthogonalHeight: g.height,
        XAxisAbscissa: Math.cos(theta),
        XAxisOrdinate: Math.sin(theta),
        Scale: g.scale,
      }),
    );
  }

  private modelContextID(): number | null {
    const ids = this.idsOfType("IFCGEOMETRICREPRESENTATIONCONTEXT");
    let fallback: number | null = null;
    for (const id of ids) {
      const e = this.getEntity(id);
      if (e?.type !== "IFCGEOMETRICREPRESENTATIONCONTEXT") continue; // skip subcontexts
      if (fallback == null) fallback = id;
      if (String(rawAttr(e, "ContextType") ?? "") === "Model") return id;
    }
    return fallback;
  }

  // --- export -------------------------------------------------------------
  /**
   * Export the enriched model via @ifc-lite/export (non-destructive: untouched
   * STEP lines preserved, full numeric precision, no malformed reals — proven by
   * the POC). Mutations (attributes, psets, new site/beneficiary, georef) apply here.
   */
  export(): Uint8Array {
    this.materializeBeneficiar();
    this.materializeGeorefIfAbsent();

    const hasExistingGeoref = !!extractGeoreferencingOnDemand(this.store)?.mapConversion;
    const g = this.georefExact;
    const theta = g ? (g.rotationDeg * Math.PI) / 180 : 0;
    const georefMutations =
      g && hasExistingGeoref
        ? {
            projectedCRS: {
              name: g.crsName || STEREO70.name,
              description: STEREO70.description,
              geodeticDatum: STEREO70.geodeticDatum,
              verticalDatum: STEREO70.verticalDatum,
              mapProjection: STEREO70.mapProjection,
            },
            mapConversion: {
              eastings: g.eastings,
              northings: g.northings,
              orthogonalHeight: g.height,
              xAxisAbscissa: Math.cos(theta),
              xAxisOrdinate: Math.sin(theta),
              scale: g.scale,
            },
          }
        : undefined;

    const result = new StepExporter(this.store, this.view).export({
      schema: this.schemaName,
      includeGeometry: true,
      includeProperties: true,
      includeQuantities: true,
      includeRelationships: true,
      applyMutations: true,
      georefMutations,
    });
    return result.content;
  }
}
