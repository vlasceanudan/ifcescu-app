import { useRef } from "react";

interface ModelRow {
  id: string;
  fileName: string;
  primary: boolean;
  visible: boolean;
  schema: string;
}

interface Props {
  models: ModelRow[];
  busy?: boolean;
  onToggleVisible: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void; // not offered for the primary model in v1
  onAddModel: (file: File) => void;
  /** Fixed pixel height once the user has dragged the resizer; null = auto (CSS-capped). */
  height?: number | null;
}

/** "Modele" section at the top of the left panel: lists federated models with a
 *  visibility toggle and remove (×), plus an "Adaugă model" button. */
export function ModelsPanel({ models, busy, onToggleVisible, onRemove, onAddModel, height }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="models-panel"
      style={height != null ? { height, maxHeight: "none", flex: "0 0 auto" } : undefined}
    >
      <div className="models-head">
        <span>Modele ({models.length})</span>
        <button className="models-add" onClick={() => inputRef.current?.click()} disabled={busy} title="Adaugă un model IFC">
          ＋ Adaugă model
        </button>
      </div>
      <div className="models-list">
        {models.map((m) => (
          <div className="models-row" key={m.id}>
            <span className="models-status" title="Model încărcat" />
            <span
              className="models-eye"
              title={m.visible ? "Ascunde modelul" : "Afișează modelul"}
              onClick={() => onToggleVisible(m.id, !m.visible)}
            >
              {m.visible ? "👁" : "🚫"}
            </span>
            <span className="models-name" title={m.fileName}>
              {m.fileName}{m.primary ? " ★" : ""}
            </span>
            {m.schema && <span className="models-badge" title="Schemă IFC">{m.schema}</span>}
            {!m.primary && (
              <span className="models-rm" title="Elimină modelul" onClick={() => onRemove(m.id)}>×</span>
            )}
          </div>
        ))}
      </div>
      {busy && <div className="models-busy">Se încarcă…</div>}
      <input
        ref={inputRef}
        type="file"
        accept=".ifc"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onAddModel(f);
          e.currentTarget.value = ""; // allow re-adding the same file after removal
        }}
      />
    </div>
  );
}
