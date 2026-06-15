import { useEffect, useMemo, useState } from "react";
import type { IfcEditor, ProjectInfo, SiteInfo, BeneficiarInfo, GeorefInfo } from "../ifc/editor";
import { ROM_COUNTIES, PSET_LAND, PSET_ADDRESS, STEREO70, STEREO70_BOUNDS } from "../ifc/constants";

const JUDET_PROMPT = "--- Selectați județul ---";

interface Props {
  editor: IfcEditor;
  project: ProjectInfo;
  sites: SiteInfo[];
  beneficiar: BeneficiarInfo | null;
  fileName: string;
  onGeorefChange?: (g: GeorefInfo) => void;
}

type SummaryRow = [string, string];

export function EditorForm({ editor, project, sites, beneficiar, fileName, onGeorefChange }: Props) {
  const [projName, setProjName] = useState(project.name);
  const [projLong, setProjLong] = useState(project.longName);
  const [benIsOrg, setBenIsOrg] = useState(beneficiar?.isOrg ?? false);
  const [benName, setBenName] = useState(beneficiar?.name ?? "");

  const [siteIdx, setSiteIdx] = useState(0);
  const [landTitleId, setLandTitleId] = useState("");
  const [landId, setLandId] = useState("");
  const [street, setStreet] = useState("");
  const [town, setTown] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");

  // Georeferencing (Stereo 70). Kept as strings so the inputs can be empty.
  const georefSupported = useMemo(() => editor.supportsGeoref(), [editor]);
  const [eastings, setEastings] = useState("");
  const [northings, setNorthings] = useState("");
  const [height, setHeight] = useState("");
  const [rotationDeg, setRotationDeg] = useState("");
  const [scale, setScale] = useState("");

  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [exportError, setExportError] = useState<string | null>(null);

  const site = sites[siteIdx];

  // Prefill georeferencing once from any existing IfcMapConversion.
  useEffect(() => {
    if (!georefSupported) return;
    const g = editor.getGeoref();
    if (!g) return;
    setEastings(String(g.eastings));
    setNorthings(String(g.northings));
    setHeight(String(g.height));
    setRotationDeg(String(g.rotationDeg));
    setScale(String(g.scale));
  }, [editor, georefSupported]);

  // (Re)load the per-site fields whenever the selected site changes.
  useEffect(() => {
    if (!site) return;
    setLandTitleId(editor.getPsetValue(site.expressID, PSET_LAND, "LandTitleID"));
    setLandId(editor.getPsetValue(site.expressID, PSET_LAND, "LandId"));
    setStreet(editor.getPsetValue(site.expressID, PSET_ADDRESS, "Street"));
    setTown(editor.getPsetValue(site.expressID, PSET_ADDRESS, "Town"));
    setRegion(editor.getPsetValue(site.expressID, PSET_ADDRESS, "Region"));
    setPostalCode(editor.getPsetValue(site.expressID, PSET_ADDRESS, "PostalCode"));
  }, [editor, site]);

  const counties = useMemo(() => [JUDET_PROMPT, ...ROM_COUNTIES], []);

  const apply = () => {
    const warn: string[] = [];
    const pc = postalCode.trim();
    if (pc && !/^\d{6}$/.test(pc)) warn.push("Codul poștal românesc are de obicei 6 cifre.");
    if ((landId.trim() || street.trim() || town.trim()) && !landTitleId.trim())
      warn.push("Nr. Cărții funciare este gol, deși alte date sunt completate.");

    const rows: SummaryRow[] = [];
    editor.setProject(projName, projLong);
    rows.push(["Număr proiect", projName], ["Nume proiect", projLong]);

    if (benName.trim()) {
      editor.upsertBeneficiar(project.expressID, benName.trim(), benIsOrg);
      rows.push(["Beneficiar", `${benName.trim()} (${benIsOrg ? "juridică" : "fizică"})`]);
    }

    editor.setPsetValue(site.expressID, PSET_LAND, "LandTitleID", landTitleId);
    editor.setPsetValue(site.expressID, PSET_LAND, "LandId", landId);
    rows.push(["Nr. Cărții funciare", landTitleId], ["Nr. Cadastral", landId]);

    const regionVal = region === JUDET_PROMPT ? "" : region;
    const address: Record<string, string> = {
      Street: street,
      Town: town,
      Region: regionVal,
      PostalCode: postalCode,
      Country: "Romania",
    };
    for (const [k, v] of Object.entries(address))
      editor.setPsetValue(site.expressID, PSET_ADDRESS, k, v);
    rows.push(
      ["Stradă", street],
      ["Oraș", town],
      ["Județ", regionVal],
      ["Cod poștal", postalCode],
      ["Țară", "Romania"],
    );

    // Georeferencing: only write when the user supplied an origin (Est + Nord).
    if (georefSupported && eastings.trim() && northings.trim()) {
      const g: GeorefInfo = {
        crsName: STEREO70.name,
        eastings: Number(eastings),
        northings: Number(northings),
        height: Number(height) || 0,
        rotationDeg: Number(rotationDeg) || 0,
        scale: Number(scale) || 1,
      };
      const b = STEREO70_BOUNDS;
      if (g.eastings < b.eMin || g.eastings > b.eMax || g.northings < b.nMin || g.northings > b.nMax)
        warn.push("Coordonatele Stereo 70 par în afara intervalului uzual pentru România.");
      editor.setGeoref(g);
      onGeorefChange?.(g);
      rows.push(
        ["Sistem de coordonate", STEREO70.name + " (Stereo 70)"],
        ["Est (Y)", String(g.eastings)],
        ["Nord (X)", String(g.northings)],
        ["Cotă (H)", String(g.height)],
        ["Rotație la nord", g.rotationDeg + "°"],
        ["Scară", String(g.scale)],
      );
    }
    setWarnings([...warn]);

    let bytes: Uint8Array;
    try {
      bytes = editor.export();
    } catch (e: any) {
      // web-ifc 0.0.39 can fail to serialise very large models ("offset is out
      // of bounds"). The edits are applied in-memory; only the download fails.
      setExportError(
        "Modificările au fost aplicate, dar exportul a eșuat — modelul este probabil prea mare " +
          "pentru această versiune. " + (e?.message ? `(${e.message})` : ""),
      );
      setDownload(null);
      setSummary(rows);
      return;
    }
    setExportError(null);
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: "application/x-industry-foundation-classes",
    });
    if (download) URL.revokeObjectURL(download.url);
    setDownload({ url: URL.createObjectURL(blob), name: `+${fileName}` });
    setSummary(rows);
  };

  return (
    <div>
      <div className="card">
        <h3>Informații proiect</h3>
        <div className="row">
          <Field label="Număr proiect" value={projName} onChange={setProjName} />
          <Field label="Nume proiect" value={projLong} onChange={setProjLong} />
        </div>
      </div>

      <div className="card">
        <h3>Beneficiar</h3>
        <div className="radio-row field">
          <label>
            <input
              type="radio"
              checked={!benIsOrg}
              onChange={() => setBenIsOrg(false)}
            />
            Persoană fizică
          </label>
          <label>
            <input type="radio" checked={benIsOrg} onChange={() => setBenIsOrg(true)} />
            Persoană juridică
          </label>
        </div>
        <Field label="Nume beneficiar" value={benName} onChange={setBenName} />
      </div>

      <div className="card">
        <h3>Teren</h3>
        <div className="field">
          <label>IfcSite</label>
          <select value={siteIdx} onChange={(e) => setSiteIdx(Number(e.target.value))}>
            {sites.map((s, i) => (
              <option key={s.expressID} value={i}>
                {(s.name || "(Sit fără nume)") + " – " + s.globalId}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <Field label="Nr. Cărții funciare" value={landTitleId} onChange={setLandTitleId} />
          <Field label="Nr. Cadastral" value={landId} onChange={setLandId} />
        </div>
      </div>

      <div className="card">
        <h3>Adresă teren</h3>
        <div className="row">
          <Field label="Stradă" value={street} onChange={setStreet} />
          <Field label="Oraș" value={town} onChange={setTown} />
        </div>
        <div className="row">
          <div className="field">
            <label>Județ</label>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              {counties.map((c) => (
                <option key={c} value={c === JUDET_PROMPT ? "" : c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <Field label="Cod poștal" value={postalCode} onChange={setPostalCode} />
        </div>
      </div>

      <div className="card">
        <h3>Georeferențiere (Stereo 70)</h3>
        {georefSupported ? (
          <>
            <div className="field">
              <label>Sistem de coordonate</label>
              <input value={`${STEREO70.name} – Stereo 70`} readOnly disabled />
            </div>
            <div className="row">
              <Field label="Est (Y)" value={eastings} onChange={setEastings} />
              <Field label="Nord (X)" value={northings} onChange={setNorthings} />
            </div>
            <div className="row">
              <Field label="Cotă (H)" value={height} onChange={setHeight} />
              <Field label="Rotație la nord (°)" value={rotationDeg} onChange={setRotationDeg} />
              <Field label="Scară" value={scale} onChange={setScale} />
            </div>
          </>
        ) : (
          <div className="alert warn">
            ⚠️ Georeferențierea (IfcMapConversion) este disponibilă doar pentru fișiere IFC4. Acest
            model folosește o schemă IFC2x3.
          </div>
        )}
      </div>

      {warnings.map((w, i) => (
        <div className="alert warn" key={i}>
          ⚠️ {w}
        </div>
      ))}

      {exportError && <div className="alert error">⛔ {exportError}</div>}

      <button className="btn" onClick={apply} data-testid="apply-btn">
        Aplică modificările și generează descărcarea
      </button>

      {summary && download && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="alert success">Modificările au fost aplicate.</div>
          <h3>Rezumatul modificărilor</h3>
          <table className="summary">
            <tbody>
              {summary.map(([k, v], i) => (
                <tr key={i}>
                  <td className="k">{k}</td>
                  <td>{v.trim() ? v : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <a
            className="btn"
            style={{ display: "inline-block", marginTop: 12, textDecoration: "none" }}
            href={download.url}
            download={download.name}
            data-testid="download-link"
          >
            ⬇ Descarcă IFC îmbogățit
          </a>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
