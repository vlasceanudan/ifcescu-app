// Thin wrapper around @ifc-lite/ids — IDS (Information Delivery Specification)
// validation. Parses an IDS XML, then validates the currently loaded model's
// columnar store against it. The store is obtained via parseStore (cached by
// bytes identity, so this reuses the same parse the viewer/editor already did).
//
// IDS rule/failure descriptions are produced in English by the package's
// translation service; our surrounding UI labels stay Romanian.
import { parseIDS, validateIDS, createTranslationService } from "@ifc-lite/ids";
import type { IDSDocument, IDSValidationReport, ValidationProgress } from "@ifc-lite/ids";
// The store→accessor bridge lives ONLY on the /bridge subpath, not the root.
import { createDataAccessor, narrowSchemaVersion } from "@ifc-lite/ids/bridge";
import { parseStore, detectSchema } from "./store";

export type {
  IDSDocument,
  IDSValidationReport,
  IDSSpecificationResult,
  IDSEntityResult,
  IDSRequirementResult,
} from "@ifc-lite/ids";

/** Parse buildingSMART IDS XML text into a document. Throws IDSParseError on malformed input. */
export function parseIdsXml(xml: string): IDSDocument {
  return parseIDS(xml);
}

/**
 * Validate the model (parsed from `bytes`) against an IDS document.
 * `fileName` is used as the report's modelId. `onProgress` surfaces validator
 * progress so the UI can show a bar on large documents.
 */
export async function runIdsValidation(
  bytes: Uint8Array,
  idsDoc: IDSDocument,
  fileName: string,
  onProgress?: (p: ValidationProgress) => void,
): Promise<IDSValidationReport> {
  const store = await parseStore(bytes);
  const accessor = createDataAccessor(store);
  const modelInfo = {
    modelId: fileName,
    schemaVersion: narrowSchemaVersion(detectSchema(bytes)),
    entityCount: store.entityIndex.byId.size,
  };
  return validateIDS(idsDoc, accessor, modelInfo, {
    translator: createTranslationService("en"),
    onProgress,
    includePassingEntities: false,
  });
}
