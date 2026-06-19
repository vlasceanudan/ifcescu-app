// English dictionary. Typed against `typeof ro` (see ./types) so it must mirror
// the Romanian keys exactly — keep them in sync when adding strings.
import type { Dict } from "./types";

export const en: Dict = {
  common: {
    save: "Save",
    cancel: "Cancel",
    apply: "Apply",
    close: "Close",
    remove: "Remove",
    up: "Up",
    down: "Down",
    loading: "Loading…",
    optional: "Optional",
  },
  app: {
    tabView: "3D",
    tabGlobe: "3D Globe",
    download: "Download",
    downloadTitle: "Download the IFC with your edits applied",
    editedSuffix: "edited",
    processing: "Processing file…",
    invalidIfc: "Could not read the file as valid IFC. {detail}",
    themeLight: "Light mode",
    themeDark: "Dark mode",
    langToggleTitle: "Change language (RO/EN)",
  },
};
