import { useState } from "react";
import { Modal } from "./Modal";
import type { AggKind, FieldDef, PivotConfig, ValueColumn } from "../viewer/pivot";

interface Props {
  fields: FieldDef[];
  config: PivotConfig;
  onApply: (config: PivotConfig) => void;
  onClose: () => void;
}

const AGGS: { kind: AggKind; label: string }[] = [
  { kind: "sum", label: "Sumă" },
  { kind: "avg", label: "Medie" },
  { kind: "count", label: "Număr" },
  { kind: "min", label: "Minim" },
  { kind: "max", label: "Maxim" },
];

/** Popup to organise the pivot: nested group-by row fields and aggregated value
 *  columns. Edits a draft; only commits to the parent on "Aplică". */
export function DataTableConfig({ fields, config, onApply, onClose }: Props) {
  const [groupBy, setGroupBy] = useState<string[]>(config.groupBy);
  const [values, setValues] = useState<ValueColumn[]>(config.values);
  const [showTotals, setShowTotals] = useState<boolean>(config.showTotals);

  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const available = fields.filter((f) => !groupBy.includes(f.key));
  // Aggregations other than count need a numeric field.
  const numericFields = fields.filter((f) => f.kind === "numeric");

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= groupBy.length) return;
    const next = [...groupBy];
    [next[i], next[j]] = [next[j], next[i]];
    setGroupBy(next);
  };

  const apply = () => onApply({ groupBy, values, showTotals });

  return (
    <Modal
      title="Organizare tabel"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Anulează</button>
          <button className="btn" onClick={apply} disabled={!groupBy.length}>Aplică</button>
        </>
      }
    >
      <div className="dt-cfg-section">
        <div className="dt-cfg-title">Grupare pe rânduri</div>
        {groupBy.length === 0 && <div className="dt-cfg-hint">Adaugă cel puțin un câmp de grupare.</div>}
        {groupBy.map((key, i) => (
          <div className="dt-cfg-row" key={key}>
            <span className="dt-cfg-idx">{i + 1}.</span>
            <span className="dt-cfg-grow">{labelOf(key)}</span>
            <button className="dt-cfg-icon" title="Sus" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
            <button className="dt-cfg-icon" title="Jos" disabled={i === groupBy.length - 1} onClick={() => move(i, 1)}>▼</button>
            <button className="dt-cfg-icon" title="Elimină" onClick={() => setGroupBy(groupBy.filter((_, k) => k !== i))}>×</button>
          </div>
        ))}
        {available.length > 0 && (
          <select
            className="dt-cfg-add"
            value=""
            onChange={(e) => e.target.value && setGroupBy([...groupBy, e.target.value])}
          >
            <option value="">+ Adaugă câmp de grupare…</option>
            {available.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        )}
      </div>

      <div className="dt-cfg-section">
        <div className="dt-cfg-title">Coloane cu valori</div>
        {values.length === 0 && <div className="dt-cfg-hint">Nicio coloană (se afișează doar Număr).</div>}
        {values.map((col, i) => {
          const field = fields.find((f) => f.key === col.fieldKey);
          return (
            <div className="dt-cfg-row" key={i}>
              <select
                className="dt-cfg-grow"
                value={col.fieldKey}
                onChange={(e) => setValues(values.map((c, k) => (k === i ? { ...c, fieldKey: e.target.value } : c)))}
              >
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>{f.label}</option>
                ))}
              </select>
              <select
                value={col.agg}
                onChange={(e) => setValues(values.map((c, k) => (k === i ? { ...c, agg: e.target.value as AggKind } : c)))}
              >
                {AGGS.map((a) => (
                  // Non-count aggregations only make sense on numeric fields.
                  <option key={a.kind} value={a.kind} disabled={a.kind !== "count" && field?.kind !== "numeric"}>
                    {a.label}
                  </option>
                ))}
              </select>
              <button className="dt-cfg-icon" title="Elimină" onClick={() => setValues(values.filter((_, k) => k !== i))}>×</button>
            </div>
          );
        })}
        <button
          className="dt-cfg-addbtn"
          onClick={() => {
            const f = numericFields[0] ?? fields[0];
            setValues([...values, { fieldKey: f.key, agg: f.kind === "numeric" ? "sum" : "count" }]);
          }}
        >
          + Adaugă coloană
        </button>
      </div>

      <label className="dt-cfg-check">
        <input type="checkbox" checked={showTotals} onChange={(e) => setShowTotals(e.target.checked)} />
        Afișează rândul de total
      </label>
    </Modal>
  );
}
