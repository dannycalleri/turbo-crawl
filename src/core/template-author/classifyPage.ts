import type { Page } from "playwright";
import { normalizeDomain } from "../domain-store";
import { groupLinks, type LinkGroup } from "../extraction/links";
import type { ChatMessage, LLMProvider } from "../llm-extractor/providers/LLMProvider";
import { inferUrlPattern } from "../templating/inferUrlPattern";
import { createListingTemplateId } from "../templating/templateId";
import type { ListingTemplate } from "../templating/types";
import type { PagePacket } from "../types";
import { DEFAULT_MAX_REPAIRS } from "./authorTemplate";
import {
    buildClassifyMessages,
    buildClassifyResponseSchema,
    buildListingRepairMessages,
    parseClassifyResponse,
} from "./listingPrompt";
import {
    LINK_ROLES,
    readListingLinks,
    validateLinkSelectors,
    type LinkRole,
    type LinkSelectorValidation,
    type ListingLinks,
} from "./validateListingSelectors";

export const MIN_LINK_GROUP = 4;

export type ListingAgentCall = {
    round: number;
    messages: ChatMessage[];
    response: unknown;
    validations: Partial<Record<LinkRole, LinkSelectorValidation[]>>;
};

export type PageClassification =
    | { kind: "detail"; calls: ListingAgentCall[] }
    | ({
        kind: "listing";
        template: ListingTemplate;
        calls: ListingAgentCall[];
        provider: LLMProvider["name"];
        warnings: string[];
    } & ListingLinks);

export type ClassifyPageInput = {
    page: Page;
    pagePacket: PagePacket;
    skeleton: string;
    groups: LinkGroup[];
    provider: LLMProvider;
    model?: string | null;
    maxRepairs?: number;
    timeoutMs?: number;
    now?: () => Date;
    onProgress?: (message: string) => void;
};

export function looksLikeListing(groups: LinkGroup[], pageUrl: string): boolean {
    const pagePattern = inferUrlPattern(pageUrl);
    return groups.some(group => group.count >= MIN_LINK_GROUP && group.urlPattern !== pagePattern);
}

export async function classifyPage(input: ClassifyPageInput): Promise<PageClassification> {
    const finalUrl = input.pagePacket.finalUrl || input.pagePacket.url;
    const { provider } = input;
    const progress = input.onProgress ?? (() => { });
    const maxRepairs = Math.max(0, input.maxRepairs ?? DEFAULT_MAX_REPAIRS);
    const urlPattern = inferUrlPattern(finalUrl);
    const pageContext = { url: finalUrl, urlPattern, skeleton: input.skeleton, pagePacket: input.pagePacket };

    const passing: Partial<Record<LinkRole, LinkSelectorValidation[]>> = {};
    const calls: ListingAgentCall[] = [];
    let failures: Partial<Record<LinkRole, LinkSelectorValidation[]>> = {};

    for (let round = 0; round <= maxRepairs; round += 1) {
        progress(round === 0
            ? `Asking ${provider.name} if this page is a listing…`
            : `Repair round ${round}: asking ${provider.name} to fix ${Object.keys(failures).join(", ")}…`);

        const messages = round === 0
            ? buildClassifyMessages({ page: pageContext, groups: input.groups })
            : buildListingRepairMessages({ page: pageContext, groups: input.groups, failures });
        const response = await provider.completeStructured({
            model: input.model ?? "",
            messages,
            jsonSchema: buildClassifyResponseSchema(),
            temperature: 0,
            timeoutMs: input.timeoutMs,
        });
        const answer = parseClassifyResponse(response.parsed);

        if (round === 0 && answer.pageKind === "detail") {
            calls.push({ round, messages, response: response.raw, validations: {} });
            return { kind: "detail", calls };
        }

        const roles = round === 0 ? LINK_ROLES : (Object.keys(failures) as LinkRole[]);
        const validations: Partial<Record<LinkRole, LinkSelectorValidation[]>> = {};
        failures = {};
        for (const role of roles) {
            if (answer[role].length === 0 && role !== "itemLinks") continue;
            const results = await validateLinkSelectors(input.page, role, answer[role]);
            validations[role] = results;
            const passed = results.filter(result => result.passed);
            if (passed.length > 0) passing[role] = passed;
            else failures[role] = results;
        }
        calls.push({ round, messages, response: response.raw, validations });

        if (Object.keys(failures).length === 0) break;
    }

    if (!passing.itemLinks) {
        throw new Error(`The agent said ${finalUrl} is a listing, but none of its item link selectors worked after ${maxRepairs} repair round(s): ${failures.itemLinks?.map(failure => failure.reason).join("; ") || "no selectors were given"}. Run again with a higher --max-repairs, or crawl the item pages directly.`);
    }

    const warnings = Object.keys(failures).map(role =>
        `No working ${role} selector found after ${maxRepairs} repair round(s); the listing template has none.`);
    const domain = normalizeDomain(finalUrl);
    const template: ListingTemplate = {
        id: createListingTemplateId(domain, urlPattern),
        kind: "listing",
        domain,
        urlPatterns: [urlPattern],
        itemLinks: selectorsOf(passing.itemLinks),
        nextPage: selectorsOf(passing.nextPage),
        pageLinks: selectorsOf(passing.pageLinks),
        itemUrlPattern: groupLinks(passing.itemLinks[0]!.links.map(link => link.url), finalUrl)[0]!.urlPattern,
        createdFromUrl: finalUrl,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
    };

    const links = await readListingLinks(input.page, template);
    return { kind: "listing", template, calls, provider: provider.name, warnings, ...links! };
}

function selectorsOf(results: LinkSelectorValidation[] | undefined): string[] {
    return (results ?? []).map(result => result.selector);
}
