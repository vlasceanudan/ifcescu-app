import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/react";
import { useSettings } from "../settings/react";
import { coordDecimals, formatArea } from "../settings/format";
import { ovc } from "../viewer/overlayColors";
import type { GeorefInfo } from "../ifc/editor";
import { fetchParcels, type Parcel } from "../geo/ancpi";
import type { ParcelInfo } from "../viewer/parcelLayer";
import { computeGeoref, type AlignMode } from "../geo/align";

interface V3 {
  x: number;
  y: number;
  z: number;
}

interface Props {
  /** Model points captured by the viewer's alignment tool (raw IFC coords). */
  modelA: V3 | null;
  modelB: V3 | null;
  /** Which model slot the viewer is currently capturing (for button highlight). */
  armedSlot: "A" | "B" | null;
  /** Arm the viewer to capture the next click into model slot A or B. */
  onArmModelPick: (slot: "A" | "B") => void;
  /** Parcel-corner targets (Stereo 70), owned by the viewer (3D snap or 2D map). */
  targetA: { e: number; n: number } | null;
  targetB: { e: number; n: number } | null;
  /** Which corner slot the viewer is currently capturing (for button highlight). */
  armedCorner: "A" | "B" | null;
  /** Arm corner capture for slot A/B (snap a parcel corner in the 3D scene). */
  onArmCornerPick: (slot: "A" | "B") => void;
  /** The model's current georef (CRS name + height carried into the result). */
  baseGeoref: GeorefInfo | null;
  /** The model's own Stereo 70 centre, when it has a real-world location — used to
   *  pre-fill the search point. Null for purely local models. */
  modelCenter: { e: number; n: number } | null;
  /** Notify the viewer of the current parcels so it can draw them in the 3D scene. */
  onParcelsChange?: (parcels: Parcel[]) => void;
  /** The parcel currently selected in the 3D scene (clicked), shown as a readout. */
  selectedParcel: ParcelInfo | null;
  /** Show every parcel number in 3D (off = only hovered/selected, to avoid clutter). */
  showAllLabels: boolean;
  onShowAllLabels: (on: boolean) => void;
  /** True when the schema can store an IfcMapConversion (IFC4 / IFC4x3). */
  supportsGeoref: boolean;
  /** Apply the georef live (viewer readouts + globe). */
  onApply: (g: GeorefInfo) => void;
  /** Apply live AND write the IfcMapConversion into the exported IFC. */
  onWriteIfc: (g: GeorefInfo) => void;
  onClose: () => void;
}

export function GeorefPanel({ modelA, modelB, armedSlot, onArmModelPick, targetA, targetB, armedCorner, onArmCornerPick, baseGeoref, modelCenter, onParcelsChange, selectedParcel, showAllLabels, onShowAllLabels, supportsGeoref, onApply, onWriteIfc, onClose }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const dp = settings.units.decimals;
  // A = accent (brand), B = secondary (teal) — same as the 3D alignment markers.
  const A_COLOR = ovc.accent();
  const B_COLOR = ovc.teal();
  // Search centre defaults to the model's own Stereo 70 location when known.
  const [east, setEast] = useState(modelCenter ? String(Math.round(modelCenter.e)) : "");
  const [north, setNorth] = useState(modelCenter ? String(Math.round(modelCenter.n)) : "");
  const [radius, setRadius] = useState("500");
  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "info" | "error" | "ok"; text: string } | null>(null);
  const [mode, setMode] = useState<AlignMode>("rigid");

  const queryPoint = useMemo(() => {
    const e = Number(east), n = Number(north);
    return east.trim() && north.trim() && Number.isFinite(e) && Number.isFinite(n) ? { e, n } : null;
  }, [east, north]);

  const doFetch = async () => {
    if (!queryPoint) {
      setMsg({ kind: "error", text: t("geo.badPoint") });
      return;
    }
    setBusy(true);
    setMsg({ kind: "info", text: t("geo.fetching") });
    try {
      const r = Number(radius) || 500;
      const list = await fetchParcels(queryPoint.e, queryPoint.n, r);
      setParcels(list);
      setMsg(list.length ? { kind: "ok", text: t("geo.fetched", { n: list.length }) } : { kind: "info", text: t("geo.noParcels") });
    } catch (e: any) {
      setMsg({ kind: "error", text: t("geo.fetchError", { detail: e?.message ?? String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  // Keep the viewer's 3D parcel layer in sync with what we've fetched.
  useEffect(() => {
    onParcelsChange?.(parcels);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcels]);

  const result = useMemo(() => {
    if (!modelA || !modelB || !targetA || !targetB) return null;
    return computeGeoref(
      { model: modelA, target: targetA },
      { model: modelB, target: targetB },
      baseGeoref,
      mode,
    );
  }, [modelA, modelB, targetA, targetB, baseGeoref, mode]);

  return (
    <div className="geo-panel">
      <div className="geo-head">
        <span className="geo-title">🛰️ {t("geo.title")}</span>
        <button className="ids-icon" onClick={onClose} title={t("common.close")}>×</button>
      </div>

      <div className="geo-body">
        {/* 1 — fetch parcels */}
        <div className="geo-section">
          <div className="geo-step">{t("geo.step1")}</div>
          <div className="geo-note">{modelCenter ? t("geo.centerFromModel") : t("geo.centerUnknown")}</div>
          <div className="geo-coords">
            <div className="field"><label>E</label><input value={east} onChange={(e) => setEast(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label>N</label><input value={north} onChange={(e) => setNorth(e.target.value)} inputMode="decimal" /></div>
            <div className="field"><label>{t("geo.radius")}</label><input value={radius} onChange={(e) => setRadius(e.target.value)} inputMode="numeric" /></div>
          </div>
          <div className="geo-actions">
            <button className="geo-btn" disabled={busy} onClick={doFetch}>{t("geo.fetch")}</button>
          </div>
          {msg && <div className={"geo-msg " + msg.kind}>{msg.text}</div>}
        </div>

        {parcels.length > 0 && (
          <>
            <label className="geo-check">
              <input type="checkbox" checked={showAllLabels} onChange={(e) => onShowAllLabels(e.target.checked)} />
              {t("geo.showAllLabels")}
            </label>
            <div className="geo-note" style={{ marginTop: 6 }}>{t("geo.selectHint")}</div>
            {selectedParcel && (
              <table className="geo-result" style={{ marginTop: 6 }}>
                <tbody>
                  <tr><td>{t("geo.parcelNo")}</td><td>{selectedParcel.label || "—"}</td></tr>
                  <tr><td>{t("geo.parcelRef")}</td><td>{selectedParcel.ref || "—"}</td></tr>
                  <tr><td>{t("geo.parcelArea")}</td><td>{selectedParcel.area != null ? formatArea(selectedParcel.area) : "—"}</td></tr>
                </tbody>
              </table>
            )}
          </>
        )}

        {/* 2 — pair A / B */}
        <div className="geo-section">
          <div className="geo-step">{t("geo.step2")}</div>
          <PairRow
            slot="A" color={A_COLOR}
            model={modelA} target={targetA}
            armedModel={armedSlot === "A"} armedCorner={armedCorner === "A"}
            onPickModel={() => onArmModelPick("A")} onPickCorner={() => onArmCornerPick("A")}
          />
          <PairRow
            slot="B" color={B_COLOR}
            model={modelB} target={targetB}
            armedModel={armedSlot === "B"} armedCorner={armedCorner === "B"}
            onPickModel={() => onArmModelPick("B")} onPickCorner={() => onArmCornerPick("B")}
          />
          <label className="geo-check">
            <input type="checkbox" checked={mode === "similarity"} onChange={(e) => setMode(e.target.checked ? "similarity" : "rigid")} />
            {t("geo.similarity")}
          </label>
        </div>

        {/* 3 — result + apply */}
        <div className="geo-section">
          <div className="geo-step">{t("geo.step3")}</div>
          {result ? (
            <table className="geo-result">
              <tbody>
                <tr><td>{t("geo.rotation")}</td><td>{result.georef.rotationDeg.toFixed(4)}°</td></tr>
                <tr><td>{t("geo.east")}</td><td>{result.georef.eastings.toFixed(dp)} m</td></tr>
                <tr><td>{t("geo.north")}</td><td>{result.georef.northings.toFixed(dp)} m</td></tr>
                {mode === "similarity" && <tr><td>{t("geo.scale")}</td><td>{result.georef.scale.toFixed(6)}</td></tr>}
                <tr><td>{t("geo.residual")}</td><td className={result.residual > 0.5 ? "warn" : ""}>{result.residual.toFixed(dp)} m</td></tr>
              </tbody>
            </table>
          ) : (
            <div className="geo-note">{t("geo.needAll")}</div>
          )}
          <div className="geo-actions">
            <button className="geo-btn secondary" disabled={!result} onClick={() => result && onApply(result.georef)}>{t("geo.apply")}</button>
            <button className="geo-btn" disabled={!result || !supportsGeoref} onClick={() => result && onWriteIfc(result.georef)} title={!supportsGeoref ? t("geo.unsupported") : undefined}>
              {t("geo.writeIfc")}
            </button>
          </div>
          {!supportsGeoref && <div className="geo-msg error">{t("geo.unsupported")}</div>}
        </div>
      </div>
    </div>
  );
}

function PairRow({
  slot, color, model, target, armedModel, armedCorner, onPickModel, onPickCorner,
}: {
  slot: "A" | "B";
  color: string;
  model: V3 | null;
  target: { e: number; n: number } | null;
  armedModel: boolean;
  armedCorner: boolean;
  onPickModel: () => void;
  onPickCorner: () => void;
}) {
  const { t } = useI18n();
  const dp = coordDecimals();
  return (
    <div className="geo-pair" style={{ borderLeftColor: color }}>
      <div className="geo-pair-title">{t("geo.pair", { slot })}</div>
      <div className="geo-pick">
        <button className={"geo-pick-btn" + (armedModel ? " armed" : "")} onClick={onPickModel}>{t("geo.snapModel")}</button>
        <span className="geo-pick-val">{model ? `x ${model.x.toFixed(dp)}  y ${model.y.toFixed(dp)}` : t("geo.notSet")}</span>
      </div>
      <div className="geo-pick">
        <button className={"geo-pick-btn" + (armedCorner ? " armed" : "")} onClick={onPickCorner}>{t("geo.pickCorner")}</button>
        <span className="geo-pick-val">{target ? `E ${target.e.toFixed(dp)}  N ${target.n.toFixed(dp)}` : t("geo.notSet")}</span>
      </div>
    </div>
  );
}
