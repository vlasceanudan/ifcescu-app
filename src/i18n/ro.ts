// Romanian dictionary — the structural source of truth for the app's i18n.
// `en.ts` is typed against `typeof ro`, so adding a key here forces an English
// counterpart (a missing/extra key is a TypeScript error under strict mode).
//
// Keys are semantic dot-paths grouped by area. Interpolation uses {name} tokens
// resolved by `t(key, params)` in ./index.ts. Do NOT put IFC technical terms here
// (class names, Pset_*/Qto_*, property names, schema strings, Stereo 70, EPSG…) —
// those stay verbatim in both languages.
export const ro = {
  common: {
    save: "Salvează",
    cancel: "Anulează",
    apply: "Aplică",
    close: "Închide",
    remove: "Elimină",
    up: "Sus",
    down: "Jos",
    loading: "Se încarcă…",
    optional: "Opțional",
  },
  app: {
    tabView: "3D",
    tabGlobe: "Glob 3D",
    download: "Descarcă",
    downloadTitle: "Descarcă IFC-ul cu modificările aplicate",
    editedSuffix: "editat",
    processing: "Se procesează fișierul…",
    invalidIfc: "Nu am putut citi fișierul ca IFC valid. {detail}",
    themeLight: "Mod luminos",
    themeDark: "Mod întunecat",
    langToggleTitle: "Schimbă limba (RO/EN)",
  },
};
