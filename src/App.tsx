import { useState } from "react";
import { useTheme } from "./hooks/useTheme";
import { getIfcApi } from "./ifc/api";
import { IfcEditor } from "./ifc/editor";
import type { ProjectInfo, SiteInfo, BeneficiarInfo, GeorefInfo } from "./ifc/editor";
import { Header } from "./components/Header";
import { UploadPanel } from "./components/UploadPanel";
import { EditorForm } from "./components/EditorForm";
import { Viewer } from "./components/Viewer";
import { GlobeViewer } from "./components/GlobeViewer";

interface Loaded {
  editor: IfcEditor;
  project: ProjectInfo;
  sites: SiteInfo[];
  beneficiar: BeneficiarInfo | null;
  georef: GeorefInfo | null;
  bytes: Uint8Array;
  fileName: string;
}

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"edit" | "view" | "globe">("edit");
  // Favorited property names for the 3D viewer's property panel. Owned here so a
  // new import resets them (they belong to the currently loaded model).
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
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
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const api = await getIfcApi();
      const editor = IfcEditor.open(api, bytes);
      const project = editor.getProject();
      if (!project) throw new Error("Nu există niciun IfcProject în model.");
      // A missing IfcSite no longer blocks loading — the user can add one from
      // the editor (the "Teren" card offers an "Adaugă IfcSite" button).
      const sites = editor.getSites();
      setLoaded({
        editor,
        project,
        sites,
        beneficiar: editor.getBeneficiar(),
        georef: editor.getGeoref(),
        bytes,
        fileName: file.name,
      });
      setTab("edit");
    } catch (e: any) {
      setError("Nu am putut citi fișierul ca IFC valid. " + (e?.message ? `(${e.message})` : ""));
    } finally {
      setBusy(false);
    }
  };

  const addSite = () => {
    if (!loaded) return;
    const site = loaded.editor.createSite();
    if (!site) return;
    setLoaded({ ...loaded, sites: [...loaded.sites, site] });
  };

  const themeBtn = (
    <button className="toggle" onClick={toggleTheme} title="Comută tema">
      {theme === "dark" ? "☀️ Mod luminos" : "🌙 Mod întunecat"}
    </button>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <Header />

        {loaded && (
          <nav className="tabs topbar-tabs">
            <button className={"tab" + (tab === "edit" ? " active" : "")} onClick={() => setTab("edit")}>
              📝 Editare date
            </button>
            <button className={"tab" + (tab === "view" ? " active" : "")} onClick={() => setTab("view")}>
              🧊 Vizualizare 3D
            </button>
            <button className={"tab" + (tab === "globe" ? " active" : "")} onClick={() => setTab("globe")}>
              🌍 Glob 3D
            </button>
          </nav>
        )}

        <div className="spacer" />

        {loaded && (
          <>
            <span className="filechip" title={loaded.fileName}>
              {loaded.fileName}
            </span>
            <UploadPanel onFile={onFile} variant="button" />
          </>
        )}
        {themeBtn}
      </header>

      <main className="main">
        {!loaded && (
          <div className="upload-empty">
            <div>
              <UploadPanel onFile={onFile} variant="drop" />
              {busy && <div className="alert">Se procesează fișierul…</div>}
              {error && <div className="alert error">{error}</div>}
            </div>
          </div>
        )}

        {loaded && tab === "edit" && (
          <div className="editor-scroll">
            <div className="editor-col">
              <EditorForm
                editor={loaded.editor}
                project={loaded.project}
                sites={loaded.sites}
                beneficiar={loaded.beneficiar}
                fileName={loaded.fileName}
                onAddSite={addSite}
                onGeorefChange={(georef) => setLoaded((prev) => (prev ? { ...prev, georef } : prev))}
              />
            </div>
          </div>
        )}

        {loaded && tab === "view" && (
          <Viewer
            bytes={loaded.bytes}
            fileName={loaded.fileName}
            theme={theme}
            georef={loaded.georef}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
          />
        )}

        {loaded && tab === "globe" && (
          <GlobeViewer editor={loaded.editor} georef={loaded.georef} theme={theme} />
        )}
      </main>
    </div>
  );
}
