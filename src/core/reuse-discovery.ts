import {
  createDomainStore,
  listSchemaPreviews,
  readTemplateCandidatesForPattern,
  type ReuseWarning,
  type SchemaPreview,
  type TemplateMatchCandidate,
} from "./domain-store.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import type { ExtractionTemplate } from "./templating/types.ts";

export type TemplateReuseDiscovery = (
  target: string,
) => Promise<ReuseDiscoveryOptions>;

export type ReuseDiscoveryOptions = {
  template: ExtractionTemplate | null;
  schemas: SchemaPreview[];
  warnings: ReuseWarning[];
  ambiguousTemplates: TemplateMatchCandidate[];
};

export async function discoverTemplateReuse(
  target: string,
  rootPath?: string,
): Promise<ReuseDiscoveryOptions> {
  const store = createDomainStore({ targetUrl: target, rootPath });
  const urlPattern = inferUrlPattern(target);
  const templateResult = await readTemplateCandidatesForPattern(store, urlPattern);

  if (templateResult.candidates.length === 1) {
    return {
      template: templateResult.candidates[0]?.template ?? null,
      schemas: [],
      warnings: templateResult.warnings,
      ambiguousTemplates: [],
    };
  }

  if (templateResult.candidates.length > 1) {
    return {
      template: null,
      schemas: [],
      warnings: templateResult.warnings,
      ambiguousTemplates: templateResult.candidates,
    };
  }

  const schemaResult = await listSchemaPreviews(store);

  return {
    template: null,
    schemas: schemaResult.candidates,
    warnings: [...templateResult.warnings, ...schemaResult.warnings],
    ambiguousTemplates: [],
  };
}
