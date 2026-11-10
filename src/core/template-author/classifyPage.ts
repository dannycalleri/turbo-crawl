import type { Page } from "playwright";
import { normalizeDomain } from "../domain-store";
import type { LinkGroup } from "../extraction/links";
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
    type ClassifyResponse,
    type ListingPatternFailures,
} from "./listingPrompt";
import { checkItemUrlPattern, checkPageUrlPattern } from "./checkUrlPattern";
import {
    LINK_ROLES,
    MIN_ITEM_LINKS,
    readListingLinks,
    validateLinkSelectors,
    type LinkRole,
    type LinkSelectorValidation,
    type ListingLinks,
} from "./validateListingSelectors";

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

export async function classifyPage(input: ClassifyPageInput): Promise<PageClassification> {
    const finalUrl = input.pagePacket.finalUrl || input.pagePacket.url;
    const { provider } = input;
    const progress = input.onProgress ?? (() => { });
    const maxRepairs = Math.max(0, input.maxRepairs ?? DEFAULT_MAX_REPAIRS);
    const pageContext = { url: finalUrl, skeleton: input.skeleton, pagePacket: input.pagePacket };

    const passing: Partial<Record<LinkRole, LinkSelectorValidation[]>> = {};
    const calls: ListingAgentCall[] = [];
    let failures: Partial<Record<LinkRole, LinkSelectorValidation[]>> = {};
    let patternFailures: ListingPatternFailures = {};
    let previous: ClassifyResponse | null = null;
    let itemPattern: string | null = null;
    let pagePattern: string | null = null;

    for (let round = 0; round <= maxRepairs; round += 1) {
        const pending = [...Object.keys(failures), ...Object.keys(patternFailures)];
        progress(round === 0
            ? `Asking ${provider.name} if this page is a listing…`
            : `Repair round ${round}: asking ${provider.name} to fix ${pending.join(", ")}…`);

        const messages = round === 0 || !previous
            ? buildClassifyMessages({ page: pageContext, groups: input.groups })
            : buildListingRepairMessages({ page: pageContext, groups: input.groups, previous, failures, patternFailures });
        const response = await provider.completeStructured({
            model: input.model ?? "",
            messages,
            jsonSchema: buildClassifyResponseSchema(),
            temperature: 0,
            timeoutMs: input.timeoutMs,
        });
        const answer = parseClassifyResponse(response.parsed);
        previous = answer;

        if (round === 0 && answer.pageKind === "detail") {
            calls.push({ round, messages, response: response.raw, validations: {} });
            return { kind: "detail", calls };
        }

        patternFailures = {};
        const candidateItemPattern: string = itemPattern ?? answer.itemUrlPattern;
        const itemPatternFailure = itemPattern === null ? checkItemUrlPattern(candidateItemPattern, finalUrl) : null;

        const roles = round === 0 ? LINK_ROLES : (Object.keys(failures) as LinkRole[]);
        const validations: Partial<Record<LinkRole, LinkSelectorValidation[]>> = {};
        failures = {};
        for (const role of roles) {
            if (answer[role].length === 0 && role !== "itemLinks") continue;
            const results = role === "itemLinks" && itemPatternFailure !== null
                ? answer.itemLinks.map(selector => ({ selector, passed: false, links: [], reason: "not checked, because the itemUrlPattern failed a check" }))
                : await validateLinkSelectors(input.page, role, answer[role], [candidateItemPattern]);
            validations[role] = results;
            const passed = results.filter(result => result.passed);
            if (passed.length > 0) passing[role] = passed;
            else failures[role] = results;
        }

        const paginationUrls = [...(passing.nextPage ?? []), ...(passing.pageLinks ?? [])].flatMap(result => result.links.map(link => link.url));
        const paginationFailure = passing.itemLinks ? checkItemUrlPattern(candidateItemPattern, finalUrl, paginationUrls) : null;
        if (passing.itemLinks && paginationFailure !== null) {
            failures.itemLinks = passing.itemLinks.map(result => ({ ...result, passed: false, reason: "not kept, because the itemUrlPattern failed a check" }));
            delete passing.itemLinks;
            itemPattern = null;
        }

        if (passing.itemLinks) itemPattern = candidateItemPattern;
        else patternFailures.itemUrlPattern = paginationFailure ?? itemPatternFailure ?? `no itemLinks selector gave ${MIN_ITEM_LINKS} or more links that match ${candidateItemPattern}`;

        if (passing.itemLinks) {
            const itemUrls = passing.itemLinks[0]!.links.map(link => link.url);
            const check = (pattern: string) => checkPageUrlPattern(pattern, finalUrl, paginationUrls, itemUrls);
            if (pagePattern === null || check(pagePattern) !== null) {
                const reason = check(answer.pageUrlPattern);
                pagePattern = reason === null ? answer.pageUrlPattern : null;
                if (reason !== null) patternFailures.pageUrlPattern = reason;
            }
        }
        calls.push({ round, messages, response: response.raw, validations });

        if (Object.keys(failures).length === 0 && Object.keys(patternFailures).length === 0 && pagePattern !== null) break;
    }

    if (!passing.itemLinks || itemPattern === null) {
        const reasons = [patternFailures.itemUrlPattern, ...(failures.itemLinks ?? []).map(failure => failure.reason)].filter(Boolean);
        throw new Error(`The agent said ${finalUrl} is a listing, but none of its item link selectors worked after ${maxRepairs} repair round(s): ${reasons.join("; ") || "no selectors were given"}. Run again with a higher --max-repairs, or crawl the item pages directly.`);
    }

    const listingPattern = pagePattern ?? inferUrlPattern(finalUrl);
    const warnings = [
        ...Object.keys(failures).map(role =>
            `No working ${role} selector found after ${maxRepairs} repair round(s); the listing template has none.`),
        ...(pagePattern === null
            ? [`No listing page pattern from ${provider.name} passed the checks after ${maxRepairs} repair round(s) (${patternFailures.pageUrlPattern ?? "no pageUrlPattern was given"}); the listing template uses ${listingPattern}.`]
            : []),
    ];
    const domain = normalizeDomain(finalUrl);
    const template: ListingTemplate = {
        id: createListingTemplateId(domain, listingPattern),
        kind: "listing",
        domain,
        urlPatterns: [listingPattern],
        itemLinks: selectorsOf(passing.itemLinks),
        nextPage: selectorsOf(passing.nextPage),
        pageLinks: selectorsOf(passing.pageLinks),
        itemUrlPatterns: [itemPattern],
        createdFromUrl: finalUrl,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
    };

    const links = await readListingLinks(input.page, template);
    return { kind: "listing", template, calls, provider: provider.name, warnings, ...links! };
}

function selectorsOf(results: LinkSelectorValidation[] | undefined): string[] {
    return (results ?? []).map(result => result.selector);
}
