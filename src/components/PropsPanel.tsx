import { useState } from "react";

export interface PropRow {
  k: string;
  v: string;
}
export interface PropGroup {
  name: string;
  rows: PropRow[];
}

/** Collapsible accordion: one section per property set (+ an "Atribute" section). */
export function PropAccordion({ groups }: { groups: PropGroup[] }) {
  // Default: first group (Atribute) open, the rest collapsed.
  const [open, setOpen] = useState<Set<string>>(() => new Set(groups[0] ? [groups[0].name] : []));
  const toggle = (n: string) =>
    setOpen((s) => {
      const x = new Set(s);
      x.has(n) ? x.delete(n) : x.add(n);
      return x;
    });

  return (
    <div>
      {groups.map((g) => {
        const isOpen = open.has(g.name);
        return (
          <div className="pacc" key={g.name}>
            <button className="pacc-head" onClick={() => toggle(g.name)}>
              <span className="pacc-caret">{isOpen ? "▾" : "▸"}</span>
              <span className="pacc-name" title={g.name}>
                {g.name}
              </span>
              <span className="pacc-count">{g.rows.length}</span>
            </button>
            {isOpen && (
              <table className="pacc-table">
                <tbody>
                  {g.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="k">{r.k}</td>
                      <td>{r.v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
