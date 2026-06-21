import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { useI18n } from "../i18n/react";
import { IfcEditor } from "../ifc/editor";
import {
  listDictionaries,
  searchClasses,
  getClass,
  type BsddDictionary,
  type BsddClassHit,
  type BsddClass,
} from "../ifc/bsdd";

interface Props {
  editor: IfcEditor;
  /** Primary-model local ids the assignment applies to. */
  selectedLocalIds: number[];
  onApplied: () => void;
  onClose: () => void;
}

interface PropSel {
  checked: boolean;
  value: string;
}

/** bSDD classifier: pick a dictionary + class online and assign it (and optional
 *  bSDD-defined properties) to the selected elements. Experimental module. */
export function BsddModal({ editor, selectedLocalIds, onApplied, onClose }: Props) {
  const { t } = useI18n();
  const [dicts, setDicts] = useState<BsddDictionary[]>([]);
  const [dictUri, setDictUri] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BsddClassHit[]>([]);
  const [chosen, setChosen] = useState<{ hit: BsddClassHit; cls: BsddClass } | null>(null);
  const [assignClass, setAssignClass] = useState(true);
  const [propSel, setPropSel] = useState<Record<string, PropSel>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = selectedLocalIds.length;
  const errText = (e: any): string => {
    const m = e?.message ?? String(e);
    return m === "bSDD:RATE_LIMIT" ? t("bsdd.rateLimited") : m;
  };

  // Load dictionaries once.
  useEffect(() => {
    let live = true;
    setError(null);
    listDictionaries()
      .then((d) => live && setDicts(d))
      .catch((e) => live && setError(errText(e)));
    return () => { live = false; };
  }, []);

  const runSearch = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setChosen(null);
    try {
      setResults(await searchClasses(query, dictUri || undefined));
    } catch (e: any) {
      setError(errText(e));
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (hit: BsddClassHit) => {
    setBusy(true);
    setError(null);
    try {
      const cls = await getClass(hit.uri);
      setChosen({ hit, cls });
      const init: Record<string, PropSel> = {};
      for (const p of cls.classProperties) init[p.name] = { checked: false, value: "" };
      setPropSel(init);
      setAssignClass(true);
    } catch (e: any) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const setProp = (name: string, patch: Partial<PropSel>) =>
    setPropSel((s) => ({ ...s, [name]: { ...s[name], ...patch } }));

  const chosenProps = chosen?.cls.classProperties ?? [];
  const selectedProps = chosenProps.filter((p) => propSel[p.name]?.checked && propSel[p.name]?.value.trim());
  const canApply = n > 0 && !busy && !!chosen && (assignClass || selectedProps.length > 0);

  const apply = () => {
    if (!chosen || !n) return;
    if (assignClass) {
      editor.assignClassification(selectedLocalIds, {
        dictionaryUri: chosen.cls.dictionaryUri || chosen.hit.dictionaryUri,
        dictionaryName: chosen.hit.dictionaryName,
        classUri: chosen.cls.uri,
        code: chosen.cls.code || chosen.hit.code,
        name: chosen.cls.name || chosen.hit.name,
      });
    }
    if (selectedProps.length) {
      editor.applyBsddProperties(
        selectedLocalIds,
        selectedProps.map((p) => ({ pset: p.propertySet, name: p.name, value: propSel[p.name].value.trim(), dataType: p.dataType })),
      );
    }
    onApplied();
    onClose();
  };

  return (
    <Modal
      className="modal-wide"
      title={t("bsdd.title")}
      onClose={onClose}
      footer={
        <div className="idse-foot">
          {error && <span className="idse-issue error">{error}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn secondary" onClick={onClose}>{t("common.close")}</button>
          <button className="btn" disabled={!canApply} onClick={apply}>{t("bsdd.apply", { n })}</button>
        </div>
      }
    >
      <div className="bsdd-body">
        {n === 0 && <div className="bsdd-hint">{t("bsdd.noSelection")}</div>}

        <div className="bsdd-search">
          <select value={dictUri} onChange={(e) => setDictUri(e.target.value)}>
            <option value="">{t("bsdd.allDictionaries")}</option>
            {dicts.map((d) => (
              <option key={d.uri} value={d.uri}>{d.name}{d.version ? ` (${d.version})` : ""}</option>
            ))}
          </select>
          <input
            value={query}
            placeholder={t("bsdd.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
          />
          <button className="btn secondary" disabled={busy || !query.trim()} onClick={runSearch}>{t("bsdd.search")}</button>
        </div>

        {busy && <div className="bsdd-hint">{t("bsdd.searching")}</div>}

        {!chosen && !busy && results.length > 0 && (
          <div className="bsdd-results">
            {results.map((r) => (
              <div className="bsdd-result" key={r.uri} onClick={() => pick(r)}>
                <span className="bsdd-result-name">{r.name}</span>
                <span className="bsdd-result-meta">{r.code}{r.dictionaryName ? ` · ${r.dictionaryName}` : ""}</span>
              </div>
            ))}
          </div>
        )}
        {!chosen && !busy && query.trim() && results.length === 0 && !error && (
          <div className="bsdd-hint">{t("bsdd.noResults")}</div>
        )}

        {chosen && (
          <div className="bsdd-detail">
            <div className="bsdd-chosen">
              <div className="bsdd-chosen-name">{chosen.cls.name}</div>
              <div className="bsdd-chosen-meta">{chosen.cls.code} · {chosen.hit.dictionaryName}</div>
              <button className="bsdd-back" onClick={() => setChosen(null)}>← {t("bsdd.back")}</button>
            </div>

            <label className="set-toggle bsdd-assign">
              <input type="checkbox" checked={assignClass} onChange={(e) => setAssignClass(e.target.checked)} />
              <span className="set-toggle-text"><span className="set-toggle-label">{t("bsdd.assignClass")}</span></span>
            </label>

            <div className="bsdd-props-head">{t("bsdd.properties")}</div>
            {chosenProps.length === 0 ? (
              <div className="bsdd-hint">{t("bsdd.noProps")}</div>
            ) : (
              <div className="bsdd-props">
                {chosenProps.map((p) => (
                  <div className="bsdd-prop" key={p.name}>
                    <label className="bsdd-prop-check">
                      <input
                        type="checkbox"
                        checked={propSel[p.name]?.checked ?? false}
                        onChange={(e) => setProp(p.name, { checked: e.target.checked })}
                      />
                      <span className="bsdd-prop-name">{p.name}</span>
                      <span className="bsdd-prop-type">{p.dataType || "Text"}{p.unit ? ` · ${p.unit}` : ""}</span>
                    </label>
                    <input
                      className="bsdd-prop-value"
                      value={propSel[p.name]?.value ?? ""}
                      placeholder={t("bsdd.value")}
                      onChange={(e) => setProp(p.name, { value: e.target.value, checked: true })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default BsddModal;
