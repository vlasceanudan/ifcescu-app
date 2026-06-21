import { Modal } from "./Modal";
import { useI18n } from "../i18n/react";
import type { I18nKey } from "../i18n";

interface Props {
  onClose: () => void;
}

/** Collapsible guide sections. `open` seeds the first one expanded. */
const SECTIONS: { titleKey: I18nKey; bodyKey: I18nKey; open?: boolean }[] = [
  { titleKey: "help.quickStartTitle", bodyKey: "help.quickStartBody", open: true },
  { titleKey: "help.nav3dTitle", bodyKey: "help.nav3dBody" },
  { titleKey: "help.treeTitle", bodyKey: "help.treeBody" },
  { titleKey: "help.propertiesTitle", bodyKey: "help.propertiesBody" },
  { titleKey: "help.editingTitle", bodyKey: "help.editingBody" },
  { titleKey: "help.toolsTitle", bodyKey: "help.toolsBody" },
  { titleKey: "help.federationTitle", bodyKey: "help.federationBody" },
  { titleKey: "help.filterTitle", bodyKey: "help.filterBody" },
  { titleKey: "help.dataTableTitle", bodyKey: "help.dataTableBody" },
  { titleKey: "help.idsBcfTitle", bodyKey: "help.idsBcfBody" },
  { titleKey: "help.globeTitle", bodyKey: "help.globeBody" },
  { titleKey: "help.cadastreTitle", bodyKey: "help.cadastreBody" },
  { titleKey: "help.settingsTitle", bodyKey: "help.settingsBody" },
  { titleKey: "help.themeLangTitle", bodyKey: "help.themeLangBody" },
];

// Keyboard shortcuts — the key glyphs are universal; only the action is translated.
const SHORTCUTS: { keys: string; descKey: I18nKey }[] = [
  { keys: "1–6", descKey: "help.shortcut.views" },
  { keys: "Z", descKey: "help.shortcut.fitAll" },
  { keys: "F", descKey: "help.shortcut.frame" },
  { keys: "H", descKey: "help.shortcut.hide" },
  { keys: "I", descKey: "help.shortcut.isolate" },
  { keys: "S", descKey: "help.shortcut.section" },
  { keys: "E", descKey: "help.shortcut.edit" },
  { keys: "Esc", descKey: "help.shortcut.escape" },
  { keys: "Del", descKey: "help.shortcut.del" },
];

/** On-demand user guide. Reuses the shared Modal (Esc/backdrop/× close). */
export function HelpModal({ onClose }: Props) {
  const { t } = useI18n();
  return (
    <Modal
      title={t("help.title")}
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>{t("common.close")}</button>}
    >
      <p className="help-intro">{t("help.intro")}</p>

      {SECTIONS.map((s) => (
        <details className="help-section" key={s.titleKey} open={s.open}>
          <summary className="help-summary">{t(s.titleKey)}</summary>
          <div className="help-body">{t(s.bodyKey)}</div>
        </details>
      ))}

      <div className="help-shortcuts">
        <div className="help-shortcuts-title">{t("help.shortcutsTitle")}</div>
        <table className="help-kbd-table">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <td className="help-kbd-cell"><kbd className="vmenu-key">{s.keys}</kbd></td>
                <td>{t(s.descKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
