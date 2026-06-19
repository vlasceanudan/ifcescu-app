import { useMemo, useRef, useState } from "react";
import { useTheme } from "./hooks/useTheme";
import { useI18n } from "./i18n/react";
import { IfcEditor } from "./ifc/editor";
import type { GeorefInfo } from "./ifc/editor";
import { Header } from "./components/Header";
import { UploadPanel } from "./components/UploadPanel";
import { Viewer } from "./components/Viewer";
import { GlobeViewer } from "./components/GlobeViewer";
import type { IDSValidationReport } from "./ifc/ids";
import type { BCFProject } from "./ifc/bcf";

interface Loaded {
  editor: IfcEditor;
  georef: GeorefInfo | null;
  bytes: Uint8Array;
  fileName: string;
}

/** A federated (non-primary) model added in the 3D viewer. */
interface ExtraModel {
  id: string;
  bytes: Uint8Array;
  fileName: string;
}

/** Small line icons for the top-bar tabs. */
function TabIcon({ kind }: { kind: "view" | "globe" }) {
  const a = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "view") return <svg {...a}><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M12 12l9-5M12 12v10M12 12L3 7" /></svg>;
  return <svg {...a}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const { lang, setLang, t } = useI18n();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"view" | "globe">("view");
  // Number of edits made to the primary IFC (drives the top-bar download button).
  const [changeCount, setChangeCount] = useState(0);
  // Favorited property names for the 3D viewer's property panel. Owned here so a
  // new import resets them (they belong to the currently loaded model).
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  // IDS report + BCF project. Owned here (same per-model lifecycle as favorites)
  // so a new import resets them; both surface in the docked panels of the 3D viewer.
  const [idsReport, setIdsReport] = useState<IDSValidationReport | null>(null);
  const [bcfProject, setBcfProject] = useState<BCFProject | null>(null);
  // Federated models added in the 3D viewer (beyond the primary `loaded` one).
  const [extraModels, setExtraModels] = useState<ExtraModel[]>([]);
  const extraSeq = useRef(0);
  const toggleFavorite = (key: string) =>
    setFavorites((s) => {
      const x = new Set(s);
      x.has(key) ? x.delete(key) : x.add(key);
      return x;
    });

  const onFile = async (file: File) => {
    setError(null);
    setBusy(true);
    setLoaded(null);
    setFavorites(new Set()); // reset favorites for the new model
    setIdsReport(null);
    setBcfProject(null);
    setExtraModels([]); // federated models belonged to the previous session
    setChangeCount(0); // edits belonged to the previous model
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The primary model's editor lives here so edits + the download button
      // survive tab switches. The 3D viewer edits this same editor instance.
      const editor = await IfcEditor.open(bytes);
      setLoaded({ editor, georef: editor.getGeoref(), bytes, fileName: file.name });
      setTab("view");
    } catch (e: any) {
      setError(t("app.invalidIfc", { detail: e?.message ? `(${e.message})` : "" }));
    } finally {
      setBusy(false);
    }
  };

  // Federation: add/remove non-primary models (3D viewer only).
  const onAddModel = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setExtraModels((p) => [...p, { id: `extra-${++extraSeq.current}`, bytes, fileName: file.name }]);
  };
  const onRemoveModel = (id: string) => setExtraModels((p) => p.filter((m) => m.id !== id));

  // Download the primary model with its edits applied (non-destructive export).
  const downloadEdited = () => {
    if (!loaded) return;
    const out = loaded.editor.export();
    const base = loaded.fileName.replace(/\.ifc$/i, "");
    const blob = new Blob([out as BlobPart], { type: "application/x-step" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}-${t("app.editedSuffix")}.ifc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // The uniform model list the 3D viewer federates (primary first).
  const viewerModels = useMemo(
    () =>
      loaded
        ? [
            { id: "model-0", bytes: loaded.bytes, fileName: loaded.fileName, georef: loaded.georef, primary: true },
            ...extraModels.map((m) => ({ id: m.id, bytes: m.bytes, fileName: m.fileName, georef: null, primary: false })),
          ]
        : [],
    [loaded, extraModels],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <Header />

        {loaded && (
          <nav className="tabs topbar-tabs">
            <button className={"tab" + (tab === "view" ? " active" : "")} onClick={() => setTab("view")}>
              <TabIcon kind="view" /><span>{t("app.tabView")}</span>
            </button>
            <button className={"tab" + (tab === "globe" ? " active" : "")} onClick={() => setTab("globe")}>
              <TabIcon kind="globe" /><span>{t("app.tabGlobe")}</span>
            </button>
          </nav>
        )}

        <div className="topbar-right">
          {loaded && changeCount > 0 && (
            <button className="dl-btn" onClick={downloadEdited} title={t("app.downloadTitle")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
              <span>{t("app.download")}</span>
              <span className="dl-count">{changeCount}</span>
            </button>
          )}
          {loaded && <UploadPanel onFile={onFile} variant="button" />}
          <button
            className="lang-toggle"
            onClick={() => setLang(lang === "ro" ? "en" : "ro")}
            title={t("app.langToggleTitle")}
          >
            {lang === "ro" ? "EN" : "RO"}
          </button>
          <button className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? t("app.themeLight") : t("app.themeDark")}>
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></svg>
            )}
          </button>
        </div>
      </header>

      <main className="main">
        {!loaded && (
          <div className="upload-empty">
            <div>
              <UploadPanel onFile={onFile} variant="drop" />
              {busy && <div className="alert">{t("app.processing")}</div>}
              {error && <div className="alert error">{error}</div>}
            </div>
          </div>
        )}

        {loaded && tab === "view" && (
          <Viewer
            editor={loaded.editor}
            onChangeCount={setChangeCount}
            bytes={loaded.bytes}
            fileName={loaded.fileName}
            theme={theme}
            georef={loaded.georef}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            bcfProject={bcfProject}
            onBcfProject={setBcfProject}
            idsReport={idsReport}
            onIdsReport={setIdsReport}
            models={viewerModels}
            onAddModel={onAddModel}
            onRemoveModel={onRemoveModel}
          />
        )}

        {loaded && tab === "globe" && (
          <GlobeViewer bytes={loaded.bytes} georef={loaded.georef} theme={theme} />
        )}
      </main>
    </div>
  );
}
