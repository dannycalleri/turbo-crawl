import {
  createDomainStore,
  readTemplateCandidatesForPattern,
  type ReuseWarning,
  type TemplateMatchCandidate,
} from "./domain-store.ts";
import { inferUrlPattern } from "./templating/inferUrlPattern.ts";
import type { ExtractionTemplate } from "./templating/types.ts";

export type ReuseDiscoveryOptions = {
  template: ExtractionTemplate | null;
  warnings: ReuseWarning[];
  ambiguousTemplates: TemplateMatchCandidate[];
};

export async function discoverTemplateReuse(
  target: string,
  rootPath?: string,
): Promise<ReuseDiscoveryOptions> {
  const store = createDomainStore({ targetUrl: target, rootPath });
  const urlPattern = inferUrlPattern(target);
  const { candidates, warnings } = await readTemplateCandidatesForPattern(store, urlPattern);

  return {
    template: candidates.length === 1 ? candidates[0]!.template : null,
    warnings,
    ambiguousTemplates: candidates.length > 1 ? candidates : [],
  };
}
