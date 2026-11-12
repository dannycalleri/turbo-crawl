import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  createDomainStore,
  ensureDomainStoreDirectories,
  getPagePacketFolder,
  getTemplateArtifactPath,
  getUrlPathHash,
  listResults,
  normalizeDomain,
  addPatternToTemplate,
  listListingTemplates,
  listTemplatesForDomain,
  saveListingTemplate,
  readJsonFile,
  savePageArtifacts,
  saveTemplate,
  schemasMatch,
  writeJsonFile,
} from "../src/core/domain-store.ts";
import type { CompactPagePacket } from "../src/core/compactPagePacket.ts";
import type { LLMExtractionResult } from "../src/core/llm-extractor/types.ts";
import type { TemplateExtractionResult } from "../src/core/template-extractor/types.ts";
import type { ExtractionTemplate, ListingTemplate } from "../src/core/templating/types.ts";
import type { PagePacket } from "../src/core/types.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "turbo-crawl-domain-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createPagePacket(): PagePacket {
  return {
    url: "https://www.marketplace.example/products/example?ref=campaign",
    finalUrl: "https://marketplace.example/products/example?ref=campaign",
    fetchedAt: "2026-05-10T20:02:33.000Z",
    title: "Example",
    response: { status: 200, xRobotsTag: null, tdmReservation: null, tdmPolicy: null, retryAfter: null },
    metadata: {
      canonicalUrl: "https://marketplace.example/products/example",
      description: "Fixture",
      robots: "index,follow",
      openGraph: {},
      twitter: {},
      other: {},
    },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: {
      rawHtmlLength: 10,
      bodyTextLength: 10,
      visibleBlockCount: 0,
      jsonLdCount: 0,
      linkCount: 0,
      imageCount: 0,
      tableCount: 0,
    },
  };
}

function createCompactPagePacket(packet: PagePacket): CompactPagePacket {
  return {
    url: packet.url,
    finalUrl: packet.finalUrl,
    fetchedAt: packet.fetchedAt,
    title: packet.title,
    metadata: {
      canonicalUrl: packet.metadata.canonicalUrl,
      description: packet.metadata.description,
      robots: packet.metadata.robots,
      openGraph: {},
      twitter: {},
      other: {},
    },
    jsonLd: [],
    visibleBlocks: [],
    links: [],
    images: [],
    tables: [],
    stats: packet.stats,
    compaction: {
      structuredDataScore: 0,
      signals: [],
      retainedCounts: {
        jsonLd: 0,
        visibleBlocks: 0,
        links: 0,
        images: 0,
        tables: 0,
      },
      omittedCounts: {
        jsonLd: 0,
        visibleBlocks: 0,
        links: 0,
        images: 0,
        tables: 0,
      },
    },
  };
}

function createTemplate(): ExtractionTemplate {
  return {
    id: "template_fixture",
    domain: "marketplace.example",
    urlPatterns: ["/products/:slug"],
    schema: {
      title: "string",
    },
    createdFromUrl: "https://marketplace.example/products/example",
    createdAt: "2026-05-10T20:02:33.000Z",
    fields: {},
  };
}

function createLlmResult(): LLMExtractionResult {
  return {
    payload: { title: "Example" },
    evidence: {},
    fieldReports: {},
    provider: "lmstudio",
    model: "fixture-model",
    llmUsed: true,
    rawResponse: {},
    createdAt: "2026-05-10T20:02:33.000Z",
  };
}

function createTemplateExtractionResult(): TemplateExtractionResult {
  return {
    payload: { title: "Example" },
    fieldResults: {},
    confidence: 90,
    templateId: "template_fixture",
    usedTemplate: true,
    llmUsed: false,
    warnings: [],
  };
}

describe("domain store foundational helpers", () => {
  it("normalizes domains by lowercasing and removing a leading www prefix", () => {
    expect(normalizeDomain("https://WWW.Marketplace.example/products/example")).toBe(
      "marketplace.example",
    );
    expect(normalizeDomain("https://shop.marketplace.example/products/example")).toBe(
      "shop.marketplace.example",
    );
  });

  it("builds stable domain paths and hashes for URL paths", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://WWW.Marketplace.example/products/example?ref=campaign#details",
      rootPath,
    });

    expect(store).toEqual({
      rootPath,
      domain: "marketplace.example",
      domainPath: path.join(rootPath, "marketplace.example"),
      templatesPath: path.join(rootPath, "marketplace.example", "templates"),
      listingsPath: path.join(rootPath, "marketplace.example", "listings"),
      packetsPath: path.join(rootPath, "marketplace.example", "packets"),
    });

    expect(getUrlPathHash("https://marketplace.example/products/example?ref=one")).toBe(
      getUrlPathHash("https://marketplace.example/products/example?ref=two#details"),
    );
    expect(getUrlPathHash("https://marketplace.example/products/example")).not.toBe(
      getUrlPathHash("https://marketplace.example/products/other"),
    );
  });

  it("creates the required domain directories", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });

    await ensureDomainStoreDirectories(store);

    expect((await stat(store.templatesPath)).isDirectory()).toBe(true);
    expect((await stat(store.packetsPath)).isDirectory()).toBe(true);
  });

  it("writes and reads valid JSON with parent directory creation", async () => {
    const rootPath = await createTempDir();
    const filePath = path.join(rootPath, "nested", "artifact.json");

    await writeJsonFile(filePath, { title: "Fixture" });

    expect(await readJsonFile<{ title: string }>(filePath)).toEqual({
      title: "Fixture",
    });
    expect(await Bun.file(filePath).text()).toBe('{\n  "title": "Fixture"\n}');
  });

  it("keeps templates for different field sets on the same URL pattern side by side", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const first = await saveTemplate(store, createTemplate());
    const second = await saveTemplate(store, { ...createTemplate(), id: "template_other", schema: { title: "string", sku: "string" } });

    expect(first.path).not.toBe(second.path);
    const result = await listTemplatesForDomain(store);
    expect(result.candidates.map((candidate) => candidate.template.id).sort()).toEqual(["template_fixture", "template_other"]);
  });

  it("saves templates by URL pattern hash", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const template = createTemplate();

    const artifact = await saveTemplate(store, template);

    expect(artifact).toEqual({
      path: path.join(store.templatesPath, `${template.id.replace(/^template_/, "")}.json`),
      template,
    });
    expect(await readJsonFile<ExtractionTemplate>(artifact.path)).toEqual(template);
  });

  it("lists the domain's templates whatever their URL patterns, filtered by exact fields when given", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const template = createTemplate();
    const article = { ...createTemplate(), id: "template_00000000000000aa", urlPatterns: ["/articles/:slug"] };
    await saveTemplate(store, template);
    await saveTemplate(store, article);

    const all = (await listTemplatesForDomain(store)).candidates.map(candidate => candidate.template.id);
    expect(all.sort()).toEqual([article.id, template.id].sort());
  });

  it("matches a template schema only to the same field names and types", () => {
    expect(schemasMatch({ title: "string" }, { title: "string" })).toBe(true);
    expect(schemasMatch({ title: "string" }, { title: "text" })).toBe(false);
    expect(schemasMatch({ title: "string" }, { price: "number" })).toBe(false);
    expect(schemasMatch({ title: "string", price: "number" }, { price: "number", title: "string" })).toBe(true);
  });

  it("records the per-URL pattern of an uncovered page by rewriting the same file, and merges the list", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });
    const { path: templatePath } = await saveTemplate(store, createTemplate());

    await Promise.all([
      addPatternToTemplate(templatePath, "https://marketplace.example/p/rolex-daytona"),
      addPatternToTemplate(templatePath, "https://marketplace.example/2026/11/04/rolex-daytona"),
      addPatternToTemplate(templatePath, "https://marketplace.example/p/omega-speedmaster"),
    ]);

    const saved = await readJsonFile<ExtractionTemplate>(templatePath);
    expect(saved.urlPatterns).toEqual(["/:slug/:slug", "/:id/:id/:id/:slug"]);
    expect((await listTemplatesForDomain(store)).candidates).toHaveLength(1);
  });

  it("does not rewrite a template whose patterns cover the URL", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });
    const { path: templatePath } = await saveTemplate(store, { ...createTemplate(), urlPatterns: ["/:brand/:slug--id:id.htm"] });
    const before = (await stat(templatePath)).mtimeMs;

    await addPatternToTemplate(templatePath, "https://marketplace.example/omega/omega-speedmaster--id50011122.htm");

    expect((await stat(templatePath)).mtimeMs).toBe(before);
    expect((await readJsonFile<ExtractionTemplate>(templatePath)).urlPatterns).toEqual(["/:brand/:slug--id:id.htm"]);
  });

  it("keeps at most 2 patterns after 50 fits on listings of several brands", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://www.watches.example/rolex/rolex-daytona--id1.htm", rootPath });
    const { path: templatePath } = await saveTemplate(store, { ...createTemplate(), urlPatterns: ["/rolex/:slug"] });
    const brands = ["rolex", "omega", "tudor", "cartier", "seiko"];

    for (let index = 0; index < 50; index += 1) {
      const brand = brands[index % brands.length]!;
      await addPatternToTemplate(templatePath, `https://www.watches.example/${brand}/${brand}-model-${index}--id${50_000_000 + index}.htm`);
    }

    expect((await readJsonFile<ExtractionTemplate>(templatePath)).urlPatterns).toEqual(["/:slug/:slug"]);
  });

  it("loads a 0.3.0 template with per-listing paths as one merged pattern, and saves that list on the next write", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://www.watches.example/rolex/rolex-daytona--id1.htm", rootPath });
    const brands = ["rolex", "omega", "tudor"];
    const paths = Array.from({ length: 300 }, (_, index) => {
      const brand = brands[index % brands.length]!;
      return `/${brand}/${brand}-model-${index}--id${50_000_000 + index}`;
    });
    const templatePath = path.join(store.templatesPath, "old.json");
    await writeJsonFile(templatePath, { ...createTemplate(), domain: "watches.example", urlPatterns: paths });

    const [loaded] = (await listTemplatesForDomain(store)).candidates;
    expect(loaded?.template.urlPatterns).toEqual(["/:slug/:slug"]);

    await addPatternToTemplate(templatePath, "https://www.watches.example/search/watches/index.htm");
    expect((await readJsonFile<ExtractionTemplate>(templatePath)).urlPatterns).toEqual(["/:slug/:slug", "/search/watches/index.htm"]);
  });

  it("loads a 0.3.0 listing file with only itemUrlPattern, and writes both fields on save", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/category/clocks", rootPath });
    const listing: ListingTemplate = {
      id: "listing_0123456789abcdef",
      kind: "listing",
      domain: "marketplace.example",
      urlPatterns: ["/category/:slug"],
      itemLinks: ["ul.grid a"],
      nextPage: [],
      pageLinks: [],
      itemUrlPatterns: ["/products/:slug", "/p/:id"],
      createdFromUrl: "https://marketplace.example/category/clocks",
      createdAt: "2026-11-05T00:00:00.000Z",
    };
    const { itemUrlPatterns: _patterns, ...old } = listing;
    await writeJsonFile(path.join(store.listingsPath, "old.json"), { ...old, itemUrlPattern: "/products/:slug" });

    const [loaded] = (await listListingTemplates(store)).candidates;
    expect(loaded?.template).toEqual({ ...listing, itemUrlPatterns: ["/products/:slug"] });

    const saved = await saveListingTemplate(store, listing);
    expect(await readJsonFile<Record<string, unknown>>(saved.path)).toMatchObject({
      itemUrlPatterns: ["/products/:slug", "/p/:id"],
      itemUrlPattern: "/products/:slug",
    });
  });

  it("loads the urlPatterns of a listing template merged", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });
    await saveListingTemplate(store, {
      id: "listing_0123456789abcdef",
      kind: "listing",
      domain: "marketplace.example",
      urlPatterns: ["/category/men", "/category/women"],
      itemLinks: ["ul.grid a"],
      nextPage: [],
      pageLinks: [],
      itemUrlPatterns: ["/products/:slug"],
      createdFromUrl: "https://marketplace.example/category/men",
      createdAt: "2026-11-05T00:00:00.000Z",
    });

    const [loaded] = (await listListingTemplates(store)).candidates;
    expect(loaded?.template.urlPatterns).toEqual(["/category/:slug"]);
  });

  it("reads a template written with a single urlPattern as a one-entry urlPatterns list", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });
    const { urlPatterns: _patterns, ...current } = createTemplate();
    await writeJsonFile(path.join(store.templatesPath, "legacy.json"), { ...current, urlPattern: "/products/:slug" });

    const result = await listTemplatesForDomain(store);

    expect(result.warnings).toEqual([]);
    expect(result.candidates.map(candidate => candidate.template)).toEqual([createTemplate()]);
  });

  it("lists saved listing templates and skips invalid ones and other domains with a warning", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/category/clocks", rootPath });
    const listing: ListingTemplate = {
      id: "listing_0123456789abcdef",
      kind: "listing",
      domain: "marketplace.example",
      urlPatterns: ["/category/:slug"],
      itemLinks: ["ul.grid a"],
      nextPage: [],
      pageLinks: [],
      itemUrlPatterns: ["/products/:slug"],
      createdFromUrl: "https://marketplace.example/category/clocks",
      createdAt: "2026-11-05T00:00:00.000Z",
    };
    const saved = await saveListingTemplate(store, listing);
    await writeJsonFile(path.join(store.listingsPath, "no-items.json"), { ...listing, itemLinks: [] });
    await writeJsonFile(path.join(store.listingsPath, "other.json"), { ...listing, domain: "other.com" });

    const result = await listListingTemplates(store);

    expect(saved.path).toBe(path.join(store.listingsPath, "0123456789abcdef.json"));
    expect(result.candidates).toEqual([saved]);
    expect(result.warnings.map(warning => path.basename(warning.path)).sort()).toEqual(["no-items.json", "other.json"]);
  });

  it("removes an older file with the same template id when it saves a template", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });
    const legacyPath = path.join(store.templatesPath, "0123456789abcdef.json");
    const otherPath = path.join(store.templatesPath, "other.json");
    await writeJsonFile(legacyPath, { ...createTemplate(), schema: { title: "text" } });
    await writeJsonFile(otherPath, { ...createTemplate(), id: "template_other" });

    await saveTemplate(store, createTemplate());

    await expect(stat(legacyPath)).rejects.toThrow();
    expect((await stat(otherPath)).isFile()).toBe(true);
    expect((await listTemplatesForDomain(store)).candidates).toHaveLength(2);
  });

  it("names template files by template id, so field sets on one pattern sit side by side", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });

    const first = await saveTemplate(store, createTemplate());
    const second = await saveTemplate(store, { ...createTemplate(), id: "template_00000000000000ab", schema: { sku: "string" } });

    expect(path.basename(first.path)).toBe(`${createTemplate().id.replace(/^template_/, "")}.json`);
    expect(path.basename(second.path)).toBe("00000000000000ab.json");
    expect((await listTemplatesForDomain(store)).candidates).toHaveLength(2);
  });

  it("discovers a valid matching template candidate by domain and URL pattern", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const template = createTemplate();
    await saveTemplate(store, template);

    const result = await listTemplatesForDomain(store);

    expect(result).toEqual({
      candidates: [
        {
          path: getTemplateArtifactPath(store, template.id),
          template,
        },
      ],
      warnings: [],
    });
  });

  it("loads a template with a pairs field without a warning", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({ targetUrl: "https://marketplace.example/products/example", rootPath });
    await saveTemplate(store, { ...createTemplate(), schema: { price: "number", specs: "pairs" } });

    const result = await listTemplatesForDomain(store);

    expect(result.warnings).toEqual([]);
    expect(result.candidates[0]?.template.schema).toEqual({ price: "number", specs: "pairs" });
  });

  it("discovers a matching template whose embedded domain has a leading www prefix", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const template = {
      ...createTemplate(),
      domain: "www.marketplace.example",
    };
    await saveTemplate(store, template);

    const result = await listTemplatesForDomain(store);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.template).toEqual(template);
    expect(result.warnings).toEqual([]);
  });

  it("reports invalid matching template JSON as a recoverable reuse warning", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const artifactPath = path.join(store.templatesPath, "broken.json");

    await ensureDomainStoreDirectories(store);
    await writeFile(artifactPath, "{not-json");

    await expect(listTemplatesForDomain(store)).resolves.toEqual({
      candidates: [],
      warnings: [
        {
          operation: "read-json",
          path: artifactPath,
          message: expect.stringContaining("Unable to read template JSON"),
          recoverable: true,
        },
      ],
    });
  });

  it("discovers duplicate matching template candidates deterministically", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const template = createTemplate();
    await saveTemplate(store, template);
    const duplicatePath = path.join(store.templatesPath, "duplicate.json");
    await writeJsonFile(duplicatePath, {
      ...template,
      id: "template_duplicate",
    });

    const result = await listTemplatesForDomain(store);

    expect(result.warnings).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.path)).toEqual([
      duplicatePath,
      getTemplateArtifactPath(store, template.id),
    ].sort());
    expect(result.candidates.map((candidate) => candidate.template.id).sort()).toEqual([
      "template_duplicate",
      template.id,
    ].sort());
  });

  it("lists 501 templates without reading packet contents", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    await ensureDomainStoreDirectories(store);

    for (let index = 0; index < 500; index += 1) {
      await writeJsonFile(path.join(store.templatesPath, `other-${index}.json`), {
        ...createTemplate(),
        id: `template_other_${index}`,
        urlPatterns: [`/other/${index}`],
      });
    }

    const matchingTemplate = createTemplate();
    await saveTemplate(store, matchingTemplate);
    await writeFile(path.join(store.packetsPath, "broken-packet.json"), "{not-json");

    const templateResult = await listTemplatesForDomain(store);

    expect(templateResult.warnings).toEqual([]);
    expect(templateResult.candidates).toHaveLength(501);
  });

  it("saves page artifacts by URL path hash with optional LLM extraction", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const pagePacket = createPagePacket();
    const compactPacket = createCompactPagePacket(pagePacket);
    const llmResult = createLlmResult();
    const result = createTemplateExtractionResult();

    const folder = await savePageArtifacts(store, {
      pagePacket,
      compactPacket,
      llmResult,
      result,
    });

    expect(folder).toEqual(
      getPagePacketFolder(store, pagePacket.url, pagePacket.finalUrl),
    );
    expect(await readJsonFile<PagePacket>(folder.packetPath)).toEqual(pagePacket);
    expect(await readJsonFile<CompactPagePacket>(folder.compactPacketPath)).toEqual(
      compactPacket,
    );
    expect(await readJsonFile<LLMExtractionResult>(folder.llmPath)).toEqual(llmResult);
    expect(await readJsonFile<TemplateExtractionResult>(folder.resultPath)).toEqual(result);
  });

  it("saves non-LLM page artifacts without creating packet.llm.json", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const pagePacket = createPagePacket();
    const compactPacket = createCompactPagePacket(pagePacket);
    const result = createTemplateExtractionResult();

    const folder = await savePageArtifacts(store, {
      pagePacket,
      compactPacket,
      result,
    });

    expect(await readJsonFile<PagePacket>(folder.packetPath)).toEqual(pagePacket);
    expect(await readJsonFile<CompactPagePacket>(folder.compactPacketPath)).toEqual(
      compactPacket,
    );
    expect(await Bun.file(folder.llmPath).exists()).toBe(false);
    expect(await readJsonFile<TemplateExtractionResult>(folder.resultPath)).toEqual(result);
  });

  it("lists only result artifacts for the selected domain", async () => {
    const rootPath = await createTempDir();
    const marketplaceStore = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const otherStore = createDomainStore({
      targetUrl: "https://other-market.com/products/example",
      rootPath,
    });
    const firstPacket = createPagePacket();
    const secondPacket = {
      ...createPagePacket(),
      url: "https://marketplace.example/products/second",
      finalUrl: "https://marketplace.example/products/second",
    };
    const otherPacket = {
      ...createPagePacket(),
      url: "https://other-market.com/products/example",
      finalUrl: "https://other-market.com/products/example",
    };
    const result = createTemplateExtractionResult();

    const firstFolder = await savePageArtifacts(marketplaceStore, {
      pagePacket: firstPacket,
      result,
    });
    const secondFolder = await savePageArtifacts(marketplaceStore, {
      pagePacket: secondPacket,
      result: {
        ...result,
        payload: { title: "Second" },
      },
    });
    await savePageArtifacts(otherStore, {
      pagePacket: otherPacket,
      result: {
        ...result,
        payload: { title: "Other" },
      },
    });
    await writeJsonFile(path.join(marketplaceStore.packetsPath, "no-result", "packet.json"), {
      ignored: true,
    });

    const artifacts = await listResults(marketplaceStore);

    expect(artifacts.map(artifact => artifact.path).sort()).toEqual([
      firstFolder.resultPath,
      secondFolder.resultPath,
    ].sort());
    expect(artifacts.map(artifact => artifact.payload)).toEqual([
      { title: "Example" },
      { title: "Second" },
    ]);
  });

  it("discovers 1,000 result files without reading packet contents", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    await ensureDomainStoreDirectories(store);

    for (let index = 0; index < 1000; index += 1) {
      const packetDir = path.join(store.packetsPath, `packet-${index}`);
      await writeJsonFile(path.join(packetDir, "result.json"), {
        payload: { index },
        sourceUrl: `https://marketplace.example/products/${index}`,
        finalUrl: `https://marketplace.example/products/${index}`,
      });
      await writeFile(path.join(packetDir, "packet.json"), "{not-json");
    }

    const artifacts = await listResults(store);

    expect(artifacts).toHaveLength(1000);
    expect(artifacts[0]?.payload).toEqual({ index: 0 });
    expect(artifacts[999]?.payload).toEqual({ index: 999 });
  });

  it("reports invalid result JSON without failing unrelated packet folders", async () => {
    const rootPath = await createTempDir();
    const store = createDomainStore({
      targetUrl: "https://marketplace.example/products/example",
      rootPath,
    });
    const validFolder = await savePageArtifacts(store, {
      pagePacket: createPagePacket(),
      result: createTemplateExtractionResult(),
    });
    const invalidResultPath = path.join(store.packetsPath, "invalid", "result.json");
    const warnings: unknown[] = [];
    await mkdir(path.dirname(invalidResultPath), { recursive: true });
    await writeFile(invalidResultPath, "{not-json");

    const artifacts = await listResults(store, {
      onWarning(warning) {
        warnings.push(warning);
      },
    });

    expect(artifacts.map(artifact => artifact.path)).toEqual([validFolder.resultPath]);
    expect(warnings).toEqual([
      {
        operation: "read-json",
        path: invalidResultPath,
        message: expect.stringContaining("Unable to read result JSON"),
        recoverable: true,
      },
    ]);
  });
});
