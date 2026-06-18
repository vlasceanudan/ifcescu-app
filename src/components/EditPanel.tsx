import { useEffect, useMemo, useState } from "react";
import { getPropertySets, getInheritanceChain, findEntity, PropertyValueType, QuantityType } from "@ifc-lite/data";
import type { IfcPropertySetInfo, IfcPropertyInfo, IfcSchemaVersion } from "@ifc-lite/data";
import type { IfcEditor, SelectionDetail } from "../ifc/editor";

interface Props {
  /** The model's editor (per-model overlay) and the local express id being edited. */
  editor: IfcEditor;
  id: number;
  /** Structured, view-aware snapshot of the element (from editor.getSelection). */
  detail: SelectionDetail;
  schema: IfcSchemaVersion;
  /** Called after a successful save so the viewer refreshes + flags the model dirty. */
  onSaved: () => void;
  onCancel: () => void;
}

interface Row {
  name: string;
  value: string;
  propType?: PropertyValueType;
  qtyType?: QuantityType;
  readonly?: boolean;
  isEnum?: boolean;
  orig: string;
  isNew?: boolean;
}
interface Group {
  kind: "attribute" | "pset" | "quantity";
  name: string;
  rows: Row[];
  isNew?: boolean;
}

// Property-type options offered for pset rows (covers the common IFC value types).
const TYPE_OPTS: { v: PropertyValueType; label: string }[] = [
  { v: PropertyValueType.Text, label: "Text" },
  { v: PropertyValueType.Label, label: "Label" },
  { v: PropertyValueType.Identifier, label: "Identifier" },
  { v: PropertyValueType.Real, label: "Real" },
  { v: PropertyValueType.Integer, label: "Integer" },
  { v: PropertyValueType.Boolean, label: "Boolean" },
];

/** Best-effort map from a standard pset property's declared type to a value type. */
function kindToType(p: IfcPropertyInfo): PropertyValueType {
  if (p.kind === "enumeration") return PropertyValueType.Enum;
  const d = (p.dataType ?? "").toLowerCase();
  if (d.includes("boolean") || d.includes("logical")) return PropertyValueType.Boolean;
  if (d.includes("integer") || d.includes("count")) return PropertyValueType.Integer;
  if (d.includes("identifier")) return PropertyValueType.Identifier;
  if (d.includes("text")) return PropertyValueType.Text;
  if (d.includes("label")) return PropertyValueType.Label;
  if (/real|measure|length|area|volume|ratio|number|positive|thermal|power|mass/.test(d)) return PropertyValueType.Real;
  return PropertyValueType.Text;
}

const fromDetail = (detail: SelectionDetail): Group[] =>
  detail.groups.map((g) => ({
    kind: g.kind,
    name: g.name,
    rows: g.rows.map((r) => ({ ...r, orig: r.value })),
  }));

/**
 * In-place editor for one selected element: edit IfcRoot attributes, existing
 * property/quantity values, add properties, or add a whole property set (standard
 * class pset or custom). Save applies the diffs to the model's MutablePropertyView.
 */
export function EditPanel({ editor, id, detail, schema, onSaved, onCancel }: Props) {
  const [groups, setGroups] = useState<Group[]>(() => fromDetail(detail));
  const [adding, setAdding] = useState(false);
  const [stdPsets, setStdPsets] = useState<readonly IfcPropertySetInfo[] | null>(null);
  const [customName, setCustomName] = useState("");
  // Allowed PredefinedType enum values for this element's class (schema lookup).
  const [predefValues, setPredefValues] = useState<string[]>([]);

  // Reset the form whenever the selected element (or its snapshot) changes.
  useEffect(() => {
    setGroups(fromDetail(detail));
    setAdding(false);
    setCustomName("");
  }, [detail]);

  // Load the class's PredefinedType enum values (for the dropdown).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ent = await findEntity(schema, detail.ifcClass);
        if (!cancelled) setPredefValues(ent?.predefinedTypes ? [...ent.predefinedTypes] : []);
      } catch {
        if (!cancelled) setPredefValues([]);
      }
    })();
    return () => { cancelled = true; };
  }, [schema, detail.ifcClass]);

  // Every set already on the element (pset OR quantity) — so the picker never
  // offers a duplicate, and a custom name can't collide with an existing set.
  const existingNames = useMemo(
    () => new Set(groups.filter((g) => g.kind !== "attribute").map((g) => g.name)),
    [groups],
  );

  // Standard psets applicable to this element's class + its supertypes.
  useEffect(() => {
    if (!adding || stdPsets) return;
    let cancelled = false;
    (async () => {
      try {
        const [all, chain] = await Promise.all([
          getPropertySets(schema),
          getInheritanceChain(schema, detail.ifcClass),
        ]);
        const names = new Set<string>([detail.ifcClass.toUpperCase(), ...chain.map((e) => e.name.toUpperCase())]);
        // Only true property sets — getPropertySets also returns Qto_* sets, which
        // are quantities (computed), not something to add by hand.
        const applicable = all.filter(
          (p) => !p.name.startsWith("Qto_") && p.applicableEntities.some((a) => names.has(a.toUpperCase())),
        );
        if (!cancelled) setStdPsets(applicable);
      } catch {
        if (!cancelled) setStdPsets([]);
      }
    })();
    return () => { cancelled = true; };
  }, [adding, stdPsets, schema, detail.ifcClass]);

  const setRow = (gi: number, ri: number, patch: Partial<Row>) =>
    setGroups((gs) => gs.map((g, i) => (i !== gi ? g : { ...g, rows: g.rows.map((r, j) => (j !== ri ? r : { ...r, ...patch })) })));

  const addRow = (gi: number) =>
    setGroups((gs) => gs.map((g, i) => (i !== gi ? g : { ...g, rows: [...g.rows, { name: "", value: "", propType: PropertyValueType.Text, orig: "", isNew: true }] })));

  const addPset = (name: string, props: IfcPropertyInfo[] = []) => {
    if (!name || existingNames.has(name)) { setAdding(false); return; }
    const rows: Row[] = props.length
      ? props.map((p) => ({ name: p.name, value: "", propType: kindToType(p), orig: "", isNew: true }))
      : [{ name: "", value: "", propType: PropertyValueType.Text, orig: "", isNew: true }];
    setGroups((gs) => [...gs, { kind: "pset", name, rows, isNew: true }]);
    setAdding(false);
    setCustomName("");
  };

  const save = () => {
    for (const g of groups) {
      for (const r of g.rows) {
        if (r.readonly || !r.name) continue;
        const changed = r.isNew ? r.value.trim() !== "" : r.value !== r.orig;
        if (!changed) continue;
        if (g.kind === "attribute") {
          // Enum attributes (PredefinedType) must serialize as `.VALUE.`.
          const out = r.isEnum ? (r.value ? `.${r.value}.` : "") : r.value;
          editor.setRootAttribute(id, r.name, out);
        } else if (g.kind === "pset") {
          editor.setProperty(id, g.name, r.name, r.value, r.propType ?? PropertyValueType.Text);
        } else {
          const num = Number(r.value.replace(",", "."));
          if (Number.isFinite(num)) editor.setQuantity(id, g.name, r.name, num, r.qtyType ?? QuantityType.Length);
        }
      }
    }
    onSaved();
  };

  return (
    <div className="edit-panel">
      {groups.map((g, gi) => (
        <div className="edit-group" key={`${g.kind}:${g.name}:${gi}`}>
          <div className="edit-group-head">
            <span className="edit-group-name">{g.name}</span>
            {g.kind === "pset" && (
              <button className="edit-mini" title="Adaugă proprietate" onClick={() => addRow(gi)}>+ proprietate</button>
            )}
          </div>
          {g.rows.map((r, ri) => (
            <div className="edit-row" key={ri}>
              {g.kind === "attribute" || !r.isNew ? (
                <span className="edit-k" title={r.name}>{r.name}</span>
              ) : (
                <input
                  className="edit-k-input"
                  placeholder="nume"
                  value={r.name}
                  onChange={(e) => setRow(gi, ri, { name: e.target.value })}
                />
              )}
              {r.isEnum ? (
                <select
                  className="edit-v"
                  value={r.value}
                  onChange={(e) => setRow(gi, ri, { value: e.target.value })}
                  title="PredefinedType"
                >
                  <option value="">(nedefinit)</option>
                  {[...new Set([...predefValues, ...(r.value ? [r.value] : [])].filter(Boolean))].map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="edit-v"
                  value={r.value}
                  disabled={r.readonly}
                  onChange={(e) => setRow(gi, ri, { value: e.target.value })}
                />
              )}
              {g.kind === "pset" && (
                <select
                  className="edit-type"
                  value={r.propType ?? PropertyValueType.Text}
                  onChange={(e) => setRow(gi, ri, { propType: Number(e.target.value) as PropertyValueType })}
                  title="Tipul valorii"
                >
                  {TYPE_OPTS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              )}
            </div>
          ))}
        </div>
      ))}

      {adding ? (
        <div className="edit-add">
          <div className="edit-add-head">Adaugă set de proprietăți</div>
          <div className="edit-add-custom">
            <input
              className="edit-k-input"
              placeholder="Nume set custom (ex. Pset_Custom)"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
            />
            <button className="edit-mini" disabled={!customName.trim()} onClick={() => addPset(customName.trim())}>Adaugă</button>
            <button className="edit-mini ghost" onClick={() => setAdding(false)}>Renunță</button>
          </div>
          <div className="edit-add-std">
            {stdPsets == null ? (
              <div className="edit-hint">Se încarcă seturile standard…</div>
            ) : stdPsets.length === 0 ? (
              <div className="edit-hint">Niciun set standard pentru această clasă.</div>
            ) : (
              stdPsets
                .filter((p) => !existingNames.has(p.name))
                .map((p) => (
                  <button key={p.name} className="edit-std-item" title={`${p.properties.length} proprietăți`} onClick={() => addPset(p.name, [...p.properties])}>
                    {p.name} <span className="edit-std-count">({p.properties.length})</span>
                  </button>
                ))
            )}
          </div>
        </div>
      ) : (
        <button className="edit-add-btn" onClick={() => setAdding(true)}>+ Adaugă set de proprietăți</button>
      )}

      <div className="edit-actions">
        <button className="btn" onClick={save}>Salvează</button>
        <button className="btn secondary" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}
