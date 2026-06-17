import { type MouseEvent as ReactMouseEvent, useMemo, useState } from "react";
import { DataTableConfig } from "./DataTableConfig";
import {
  buildPivot,
  discoverFields,
  exportPivotCsv,
  type PivotConfig,
  type PivotModel,
  type PivotRow,
} from "../viewer/pivot";

interface Props {
  /** All federated models (the table aggregates across every loaded model). */
  models: PivotModel[];
  fileName: string;
  config: PivotConfig;
  onConfigChange: (config: PivotConfig) => void;
  /** Select the given GLOBAL ids in the 3D view (row/group click). */
  onSelectRows: (ids: number[]) => void;
  onClose: () => void;
}

const nf = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 2 });
const fmt = (v: number | null) => (v == null ? "—" : nf.format(v));

/** Bottom-docked data table (pivot): grouped rows + aggregated value columns,
 *  configured via a popup. Vertically resizable; coexists with the right dock. */
export function DataTablePanel({ models, fileName, config, onConfigChange, onSelectRows, onClose }: Props) {
  const [height, setHeight] = useState(300);
  const [showConfig, setShowConfig] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fields = useMemo(() => discoverFields(models), [models]);
  const result = useMemo(() => buildPivot(models, config), [models, config]);

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => setHeight(Math.min(window.innerHeight - 160, Math.max(140, window.innerHeight - ev.clientY - 16)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Flatten the visible (expanded) rows into <tr>s, depth-first.
  const renderRows = (rows: PivotRow[], path: string): JSX.Element[] => {
    const out: JSX.Element[] = [];
    for (const row of rows) {
      const key = path + "/" + row.label;
      const hasChildren = row.children.length > 0;
      const open = expanded.has(key);
      out.push(
        <tr key={key} className="datatable-row" onClick={() => onSelectRows(row.ids)} title="Selectează în 3D">
          <td>
            <span className="dt-cell" style={{ paddingLeft: row.depth * 16 }}>
              <span
                className="dt-caret"
                style={{ visibility: hasChildren ? "visible" : "hidden" }}
                onClick={(e) => { e.stopPropagation(); toggle(key); }}
              >
                {open ? "▾" : "▸"}
              </span>
              <span className="dt-label">{row.label}</span>
            </span>
          </td>
          <td className="dt-num">{nf.format(row.count)}</td>
          {row.values.map((v, i) => (
            <td key={i} className="dt-num">{fmt(v)}</td>
          ))}
        </tr>,
      );
      if (hasChildren && open) out.push(...renderRows(row.children, key));
    }
    return out;
  };

  return (
    <section className="datatable-panel" style={{ height }}>
      <div className="datatable-resize" onMouseDown={startResize} title="Trageți pentru redimensionare" />
      <div className="datatable-head">
        <span className="datatable-title">📊 Tabel de date</span>
        <div className="datatable-actions">
          <button className="ids-icon" title="Organizare (grupări și coloane)" onClick={() => setShowConfig(true)}>⚙</button>
          <button className="ids-icon" title="Export CSV" onClick={() => exportPivotCsv(result, config, fields, fileName)}>📄</button>
          <button className="ids-icon" title="Închide" onClick={onClose}>×</button>
        </div>
      </div>

      <div className="datatable-body">
        {result.rows.length === 0 ? (
          <div className="datatable-empty">Adăugați cel puțin un câmp de grupare din „⚙ Organizare".</div>
        ) : (
          <table className="datatable-table">
            <thead>
              <tr>
                <th>Grup</th>
                <th className="dt-num">Număr</th>
                {result.columns.map((c, i) => (
                  <th key={i} className="dt-num">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>{renderRows(result.rows, "")}</tbody>
            {config.showTotals && (
              <tfoot>
                <tr className="dt-total">
                  <td>Total</td>
                  <td className="dt-num">{nf.format(result.totals.count)}</td>
                  {result.totals.values.map((v, i) => (
                    <td key={i} className="dt-num">{fmt(v)}</td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>

      {showConfig && (
        <DataTableConfig
          fields={fields}
          config={config}
          onApply={(c) => { onConfigChange(c); setShowConfig(false); }}
          onClose={() => setShowConfig(false)}
        />
      )}
    </section>
  );
}
