import { useRef, useState } from "react";
import type { IfcDataStore } from "@ifc-lite/parser";
import type { ViewerEngine } from "../viewer/engine";
import type { BCFProject, BCFTopic } from "../ifc/bcf";
import {
  createBCFProject,
  createBCFTopic,
  createViewpoint,
  extractViewpointState,
  addViewpointToTopic,
  addTopicToProject,
  readBCF,
  downloadBcf,
  expressIdsToGlobalIds,
  globalIdsToExpressIds,
} from "../ifc/bcf";

const DEFAULT_AUTHOR = "viewer@ifc-lite";

interface Props {
  engine: ViewerEngine | null;
  store: IfcDataStore | null;
  fileName: string;
  /** Current selection (expressIDs) to embed in a new topic's viewpoint. */
  selectedIds: number[];
  /** Apply a viewpoint's selection back into the viewer. */
  onApplySelection: (ids: number[]) => void;
  bcfProject: BCFProject | null;
  onBcfProject: (p: BCFProject) => void;
  onClose: () => void;
}

/**
 * Docked BCF panel (lives in the 3D viewer, alongside the IDS panel — the user
 * switches between them from the toolbar). Create a topic from the live camera +
 * selection + snapshot, re-open a topic's viewpoint, and import/export .bcfzip.
 */
export function BcfPanel({
  engine,
  store,
  fileName,
  selectedIds,
  onApplySelection,
  bcfProject,
  onBcfProject,
  onClose,
}: Props) {
  const importRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState(DEFAULT_AUTHOR);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topics = bcfProject ? [...bcfProject.topics.values()] : [];

  const createTopic = async () => {
    if (!engine || !store || !title.trim()) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const camera = engine.getCameraState();
      const bounds = engine.getModelBoundsState() ?? undefined;
      const selectedGuids = expressIdsToGlobalIds(store, selectedIds);
      const snapshot = await engine.screenshot();
      const viewpoint = createViewpoint({ camera, bounds, selectedGuids, snapshot: snapshot ?? undefined });
      const topic = createBCFTopic({
        title: title.trim(),
        description: description.trim() || undefined,
        author: author.trim() || DEFAULT_AUTHOR,
        topicType: "Issue",
        topicStatus: "Open",
      });
      addViewpointToTopic(topic, viewpoint);
      const project = bcfProject ?? createBCFProject({ name: fileName, version: "2.1" });
      addTopicToProject(project, topic);
      onBcfProject({ ...project });
      setTitle("");
      setDescription("");
      setNote("Topic creat.");
    } catch (e: any) {
      setError("Eroare la crearea topicului. " + (e?.message ?? ""));
    } finally {
      setBusy(false);
    }
  };

  const openTopic = (topic: BCFTopic) => {
    if (!engine || !store) return;
    const vp = topic.viewpoints[0];
    if (!vp) return;
    const bounds = engine.getModelBoundsState() ?? undefined;
    const state = extractViewpointState(vp, bounds);
    if (state.camera) engine.applyCameraState(state.camera);
    if (state.selectedGuids.length) onApplySelection(globalIdsToExpressIds(store, state.selectedGuids));
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const imported = await readBCF(file);
      if (bcfProject) {
        for (const t of imported.topics.values()) addTopicToProject(bcfProject, t);
        onBcfProject({ ...bcfProject });
      } else {
        onBcfProject(imported);
      }
      setNote(`${imported.topics.size} topic(uri) importate.`);
    } catch (e: any) {
      setError("Nu am putut citi fișierul BCF. " + (e?.message ?? ""));
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    if (!bcfProject) return;
    setBusy(true);
    setError(null);
    try {
      await downloadBcf(bcfProject, `${fileName.replace(/\.ifc$/i, "")}.bcfzip`);
    } catch (e: any) {
      setError("Exportul BCF a eșuat. " + (e?.message ?? ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ids-panel">
      <div className="ids-head">
        <span className="ids-head-title">💬 Colaborare BCF</span>
        <div className="ids-head-actions">
          <button className="ids-icon" title="Importă .bcfzip" onClick={() => importRef.current?.click()} disabled={busy}>
            ⤓
          </button>
          <button className="ids-icon" title="Exportă .bcfzip" onClick={onExport} disabled={busy || topics.length === 0}>
            📦
          </button>
          <button className="ids-icon" title="Închide" onClick={onClose}>
            ×
          </button>
        </div>
      </div>

      <input
        ref={importRef}
        type="file"
        accept=".bcfzip,.bcf,application/zip"
        style={{ display: "none" }}
        onChange={(e) => {
          onImport(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div className="ids-panel-body">
        <div className="bcf-form">
          <label className="bcf-label">Titlu</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titlul problemei" />
          <label className="bcf-label">Descriere</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Opțional"
          />
          <label className="bcf-label">Autor</label>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
          <button className="btn" onClick={createTopic} disabled={busy || !title.trim() || !engine}>
            ➕ Topic nou din vederea curentă
          </button>
          <div className="bcf-hint">
            {selectedIds.length
              ? `${selectedIds.length} element(e) selectat(e) vor fi incluse.`
              : "Nimic selectat — topicul va salva doar vederea."}
          </div>
          {note && <div className="bcf-note">{note}</div>}
          {error && <div className="alert error">⛔ {error}</div>}
        </div>

        <div className="bcf-topics">
          <div className="bcf-topics-head">Topicuri ({topics.length})</div>
          {topics.length === 0 ? (
            <div className="bcf-empty">Niciun topic încă.</div>
          ) : (
            <ul>
              {topics.map((t) => (
                <li key={t.guid} className="bcf-topic">
                  <div className="bcf-topic-info">
                    <div className="bcf-topic-title">{t.title}</div>
                    <div className="bcf-topic-meta">
                      {[t.topicType, t.topicStatus].filter(Boolean).join(" · ")}
                      {` · ${t.comments.length} com. · ${t.viewpoints.length} vederi`}
                    </div>
                  </div>
                  {t.viewpoints.length > 0 && (
                    <button className="bcf-open" onClick={() => openTopic(t)} title="Deschide vederea">
                      ↗ 3D
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
