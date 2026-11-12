import type { TemplateJson, TemplateStore } from "../../src/lib-types.ts";

// A TemplateStore that keeps templates in memory and runs the updates of one ref one after the other.
export function memoryStore(seed: { templates?: Record<string, unknown>; listings?: Record<string, unknown> } = {}) {
  const tables = {
    templates: new Map<string, unknown>(Object.entries(seed.templates ?? {})),
    listings: new Map<string, unknown>(Object.entries(seed.listings ?? {})),
  };
  const queues = new Map<string, Promise<void>>();
  const calls: string[] = [];

  const list = (table: Map<string, unknown>) => async (domain: string) =>
    [...table].filter(([, template]) => (template as TemplateJson | null)?.domain === domain).map(([ref, template]) => ({ ref, template }));
  const save = (table: Map<string, unknown>, prefix: string) => async (template: TemplateJson) => {
    const ref = `${prefix}:${template.id}`;
    table.set(ref, structuredClone(template));
    return ref;
  };
  const update = (table: Map<string, unknown>) => (ref: string, change: (template: TemplateJson) => TemplateJson) => {
    const next = (queues.get(ref) ?? Promise.resolve()).then(async () => {
      const current = structuredClone(table.get(ref)) as TemplateJson;
      await new Promise(resolve => setTimeout(resolve, 1));
      table.set(ref, change(current));
    });
    queues.set(ref, next);
    return next;
  };
  const logged = <A extends unknown[], R>(name: string, call: (...args: A) => R) => (...args: A): R => {
    calls.push(name);
    return call(...args);
  };

  const store: TemplateStore = {
    listTemplates: logged("listTemplates", list(tables.templates)),
    listListingTemplates: logged("listListingTemplates", list(tables.listings)),
    saveTemplate: logged("saveTemplate", save(tables.templates, "template")),
    saveListingTemplate: logged("saveListingTemplate", save(tables.listings, "listing")),
    updateTemplate: logged("updateTemplate", update(tables.templates)),
    updateListingTemplate: logged("updateListingTemplate", update(tables.listings)),
  };
  return { store, tables, calls };
}
