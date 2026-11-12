import type { TemplateJson, TemplateStore } from "../lib-types.ts";
import {
  validateFieldTemplate,
  validateListingTemplate,
  withUrlPattern,
  type DomainStore,
  type ListingTemplateArtifact,
  type ReuseDiscoveryResult,
  type ReuseWarning,
  type TemplateMatchCandidate,
} from "./domain-store.ts";
import type { ExtractionTemplate, ListingTemplate } from "./templating/types.ts";
import type { StartCrawlDependencies } from "./crawl-run.ts";

// Where crawl-run reads and writes templates. The path of a candidate is the template's ref.
export type TemplateRepository = {
  listTemplates(): Promise<ReuseDiscoveryResult<TemplateMatchCandidate>>;
  listListingTemplates(): Promise<ReuseDiscoveryResult<ListingTemplateArtifact>>;
  saveTemplate(template: ExtractionTemplate): Promise<string>;
  saveListingTemplate(template: ListingTemplate): Promise<string>;
  addPattern(ref: string, url: string): Promise<void>;
  addListingPattern(ref: string, url: string): Promise<void>;
};

type FileTemplateFunctions = Pick<
  StartCrawlDependencies,
  "listTemplatesForDomain" | "listListingTemplates" | "saveTemplate" | "saveListingTemplate" | "addPatternToTemplate"
>;

export function fileTemplateRepository(store: DomainStore, files: FileTemplateFunctions): TemplateRepository {
  const addPattern = (ref: string, url: string) => files.addPatternToTemplate(ref, url);
  return {
    listTemplates: () => files.listTemplatesForDomain(store),
    listListingTemplates: () => files.listListingTemplates(store),
    saveTemplate: async template => (await files.saveTemplate(store, template)).path,
    saveListingTemplate: async template => (await files.saveListingTemplate(store, template)).path,
    addPattern,
    addListingPattern: addPattern,
  };
}

export function storeTemplateRepository(store: TemplateStore, domain: string): TemplateRepository {
  const addPattern = (call: string, ref: string, url: string) => (template: TemplateJson): TemplateJson => {
    if (typeof template !== "object" || template === null || Array.isArray(template)) {
      throw new Error(`store.${call} called update without a template for ref ${JSON.stringify(ref)}. Give update the stored template JSON, or reject when the ref no longer exists.`);
    }
    return (withUrlPattern(template, url) as TemplateJson | null) ?? template;
  };
  return {
    listTemplates: async () => validated(await store.listTemplates(domain), "listTemplates", "template", (value, ref, warnings) =>
      validateFieldTemplate(value, domain, ref, warnings)),
    listListingTemplates: async () => validated(await store.listListingTemplates(domain), "listListingTemplates", "listing template", (value, ref, warnings) =>
      validateListingTemplate(value, domain, ref, warnings)),
    saveTemplate: async template => checkedRef(await store.saveTemplate(template as unknown as TemplateJson), "saveTemplate"),
    saveListingTemplate: async template => checkedRef(await store.saveListingTemplate(template as unknown as TemplateJson), "saveListingTemplate"),
    addPattern: (ref, url) => store.updateTemplate(ref, addPattern("updateTemplate", ref, url)),
    addListingPattern: (ref, url) => store.updateListingTemplate(ref, addPattern("updateListingTemplate", ref, url)),
  };
}

function validated<T>(
  entries: unknown,
  call: string,
  label: string,
  validate: (value: unknown, ref: string, warnings: ReuseWarning[]) => T | null,
): ReuseDiscoveryResult<{ path: string; template: T }> {
  const warnings: ReuseWarning[] = [];
  const candidates: Array<{ path: string; template: T }> = [];
  if (!Array.isArray(entries)) {
    throw new Error(`store.${call} must resolve to an array of { ref, template }, not ${entries === null ? "null" : typeof entries}.`);
  }
  for (const entry of entries) {
    const ref = typeof entry?.ref === "string" ? entry.ref : null;
    if (ref === null) {
      warnings.push({ operation: "template-validation", path: "", message: `The store gave a ${label} without a string ref; it was ignored.`, recoverable: true });
      continue;
    }
    const found: ReuseWarning[] = [];
    const template = validate(entry.template, ref, found);
    if (template !== null) candidates.push({ path: ref, template });
    warnings.push(...found.map(warning => ({ ...warning, message: `The ${label} ${ref} from the store was ignored: ${warning.message}` })));
  }
  return { candidates, warnings };
}

function checkedRef(ref: unknown, call: string): string {
  if (typeof ref !== "string" || ref === "") {
    throw new Error(`store.${call} must resolve to the ref of the saved template, a non-empty string.`);
  }
  return ref;
}
