// Client for the buildingSMART Data Dictionary (bSDD) REST API.
// https://api.bsdd.buildingsmart.org — public GET endpoints (no auth):
//   GET /api/Dictionary/v1                       → list dictionaries
//   GET /api/TextSearch/v1?SearchText=&...        → search classes across dictionaries
//   GET /api/Class/v1?Uri=...&IncludeClassProperties=true → class detail + properties
//
// CORS: bSDD only allows browser calls from allow-listed origins. Like ANCPI, in
// dev we go through the Vite proxy (/bsdd → api.bsdd.buildingsmart.org, see
// vite.config.ts); in production the direct URL is attempted and may be blocked
// unless the deployed domain is added to bSDD's CORS allow-list. Callers surface
// the error.

export interface BsddDictionary {
  uri: string;
  name: string;
  version: string;
  organization: string;
}
export interface BsddClassHit {
  uri: string;
  code: string;
  name: string;
  dictionaryUri: string;
  dictionaryName: string;
}
export interface BsddProp {
  /** Property name as it should appear in the IFC pset. */
  name: string;
  code: string;
  /** Target IfcPropertySet name (may be empty → caller defaults it). */
  propertySet: string;
  /** bSDD data type token (Boolean/Integer/Real/String/...); maps to PropertyValueType. */
  dataType: string;
  uri: string;
  unit: string;
}
export interface BsddClass {
  uri: string;
  code: string;
  name: string;
  dictionaryUri: string;
  classProperties: BsddProp[];
}

/** Base URL: dev goes through the Vite proxy to dodge CORS; prod hits the host. */
function baseUrl(): string {
  return import.meta.env.DEV ? "/bsdd" : "https://api.bsdd.buildingsmart.org";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any> {
  // bSDD rate-limits anonymous traffic (HTTP 429). Retry a few times with
  // backoff (honouring Retry-After) before surfacing a friendly message.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl()}${path}`);
    if (res.status === 429) {
      if (attempt >= 3) throw new Error("bSDD:RATE_LIMIT");
      const ra = Number(res.headers?.get?.("Retry-After"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`bSDD ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (json?.error) throw new Error(typeof json.error === "string" ? json.error : "bSDD service error");
    return json;
  }
}

const str = (v: unknown): string => (v == null ? "" : String(v));

// --- dictionaries (cached for the session) --------------------------------
let dictCache: BsddDictionary[] | null = null;

/** All active bSDD dictionaries (standards), sorted by name. Cached per session. */
export async function listDictionaries(): Promise<BsddDictionary[]> {
  if (dictCache) return dictCache;
  const json = await getJson(`/api/Dictionary/v1?Limit=1000`);
  const arr: any[] = Array.isArray(json?.dictionaries) ? json.dictionaries : Array.isArray(json) ? json : [];
  const out = arr
    .map((d) => ({
      uri: str(d?.uri),
      name: str(d?.name),
      version: str(d?.version),
      organization: str(d?.organizationCodeOwner ?? d?.organizationNameOwner ?? d?.organization),
    }))
    .filter((d) => d.uri && d.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  dictCache = out;
  return out;
}

// --- class search ----------------------------------------------------------
/** Search classes by free text, optionally limited to one dictionary. */
export async function searchClasses(text: string, dictionaryUri?: string): Promise<BsddClassHit[]> {
  const q = text.trim();
  if (!q) return [];
  const p = new URLSearchParams({ SearchText: q, TypeFilter: "Classes", Limit: "100" });
  if (dictionaryUri) p.set("DictionaryUris", dictionaryUri);
  const json = await getJson(`/api/TextSearch/v1?${p.toString()}`);

  const hits: BsddClassHit[] = [];
  // Two shapes seen in the wild: a flat `classes[]`, or `dictionaries[].classes[]`.
  const pushClass = (c: any, dictUri: string, dictName: string) => {
    const uri = str(c?.uri);
    if (!uri) return;
    hits.push({
      uri,
      code: str(c?.code ?? c?.referenceCode),
      name: str(c?.name),
      dictionaryUri: str(c?.dictionaryUri) || dictUri,
      dictionaryName: str(c?.dictionaryName) || dictName,
    });
  };
  if (Array.isArray(json?.classes)) {
    for (const c of json.classes) pushClass(c, str(c?.dictionaryUri), str(c?.dictionaryName));
  }
  for (const d of Array.isArray(json?.dictionaries) ? json.dictionaries : []) {
    for (const c of Array.isArray(d?.classes) ? d.classes : []) pushClass(c, str(d?.uri), str(d?.name));
  }
  return hits;
}

// --- class detail (with properties) ---------------------------------------
/** Full class with its bSDD-defined properties. */
export async function getClass(uri: string): Promise<BsddClass> {
  const p = new URLSearchParams({ Uri: uri, IncludeClassProperties: "true" });
  const json = await getJson(`/api/Class/v1?${p.toString()}`);
  const props: BsddProp[] = (Array.isArray(json?.classProperties) ? json.classProperties : [])
    .map((p2: any) => ({
      name: str(p2?.name ?? p2?.propertyCode ?? p2?.code),
      code: str(p2?.code ?? p2?.propertyCode),
      propertySet: str(p2?.propertySet),
      dataType: str(p2?.dataType),
      uri: str(p2?.uri ?? p2?.propertyUri),
      unit: str(p2?.unit ?? (Array.isArray(p2?.units) ? p2.units[0] : "")),
    }))
    .filter((p2: BsddProp) => p2.name);
  return {
    uri: str(json?.uri) || uri,
    code: str(json?.code),
    name: str(json?.name),
    dictionaryUri: str(json?.dictionaryUri),
    classProperties: props,
  };
}
