import type { Page } from "playwright";
import { normalizeDomain } from "../domain-store";
import { cleanLinks, sameHostLinks } from "../extraction/links";
import type { ChatMessage, LLMProvider } from "../llm-extractor/providers/LLMProvider";
import type { UserSchema } from "../llm-extractor/types";
import { inferUrlPattern } from "../templating/inferUrlPattern";
import { createTemplateId } from "../templating/templateId";
import type { ExtractionTemplate, FieldTemplate } from "../templating/types";
import type { PagePacket } from "../types";
import {
    buildAuthorMessages,
    buildAuthorResponseSchema,
    buildRepairMessages,
    MAX_PROMPT_LINKS,
    parseAuthorResponse,
    type AuthorResponse,
    type PageContextForAgent,
} from "./authorPrompt";
import { checkUrlPattern } from "./checkUrlPattern";
import {
    createFieldTemplate,
    toSelectorCandidate,
    validateSelectors,
    type SelectorValidation,
} from "./validateSelectors";

export const DEFAULT_MAX_REPAIRS = 2;

export type AgentCall = {
    round: number;
    messages: ChatMessage[];
    response: unknown;
    validations: Record<string, SelectorValidation[]>;
};

export type AuthoredTemplateResult = {
    template: ExtractionTemplate;
    warnings: string[];
    provider: LLMProvider["name"];
    model: string | null;
    calls: AgentCall[];
};

export type AuthorTemplateInput = {
    schema: UserSchema;
    page: Page;
    pagePacket: PagePacket;
    skeleton: string;
    provider: LLMProvider;
    model?: string | null;
    maxRepairs?: number;
    timeoutMs?: number;
    now?: () => Date;
    onProgress?: (message: string) => void;
};

export async function authorTemplate(input: AuthorTemplateInput): Promise<AuthoredTemplateResult> {
    const finalUrl = input.pagePacket.finalUrl || input.pagePacket.url;
    const urlPattern = inferUrlPattern(finalUrl);
    const maxRepairs = Math.max(0, input.maxRepairs ?? DEFAULT_MAX_REPAIRS);
    const progress = input.onProgress ?? (() => { });
    const pageContext: PageContextForAgent = {
        url: finalUrl,
        skeleton: input.skeleton,
        pagePacket: input.pagePacket,
    };

    const links = sameHostLinks(cleanLinks(input.pagePacket.links.map(link => link.href), finalUrl), finalUrl)
        .slice(0, MAX_PROMPT_LINKS);
    const passing: Record<string, SelectorValidation[]> = {};
    const calls: AgentCall[] = [];
    let failures: Record<string, SelectorValidation[]> = {};
    let previous: AuthorResponse | null = null;
    let acceptedPattern: string | null = null;
    let patternFailure: string | null = null;

    for (let round = 0; round <= maxRepairs; round += 1) {
        const pendingSchema: UserSchema = round === 0
            ? input.schema
            : Object.fromEntries(Object.keys(failures).map(name => [name, input.schema[name]!]));
        const askPattern = acceptedPattern === null;

        const messages = round === 0 || !previous
            ? buildAuthorMessages({ schema: pendingSchema, page: pageContext, links })
            : buildRepairMessages({ schema: pendingSchema, page: pageContext, previous, failures, links, patternFailure });

        const pending = [...Object.keys(pendingSchema), ...(askPattern ? ["the URL pattern"] : [])];
        progress(round === 0
            ? `Asking ${input.provider.name} to write selectors for ${Object.keys(pendingSchema).length} fields…`
            : `Repair round ${round}: asking ${input.provider.name} to fix ${pending.join(", ")}…`);

        const response = await input.provider.completeStructured({
            model: input.model ?? "",
            messages,
            jsonSchema: buildAuthorResponseSchema(pendingSchema, askPattern),
            temperature: 0,
            timeoutMs: input.timeoutMs,
        });
        const answer = parseAuthorResponse(response.parsed, pendingSchema);
        if (askPattern) {
            patternFailure = checkUrlPattern(answer.pattern, finalUrl, links);
            if (patternFailure === null) acceptedPattern = answer.pattern!.urlPattern;
        }
        previous = answer;

        const validations: Record<string, SelectorValidation[]> = {};
        failures = {};

        for (const [fieldName, type] of Object.entries(pendingSchema)) {
            const results = await validateSelectors({
                page: input.page,
                pagePacket: input.pagePacket,
                fieldName,
                type,
                selectors: answer.fields[fieldName]?.selectors ?? [],
            });
            validations[fieldName] = results;

            const passed = results.filter(result => result.passed);
            if (passed.length > 0) {
                passing[fieldName] = passed;
            } else {
                failures[fieldName] = results;
            }
        }

        calls.push({ round, messages, response: response.raw, validations });

        if (Object.keys(failures).length === 0 && acceptedPattern !== null) {
            break;
        }
    }

    const templatePattern = acceptedPattern ?? urlPattern;
    const warnings = [
        ...Object.keys(failures).map(name =>
            `No working selector found for "${name}" after ${maxRepairs} repair round(s); the field will be null.`),
        ...(acceptedPattern === null
            ? [`No URL pattern from ${input.provider.name} passed the checks after ${maxRepairs} repair round(s) (${patternFailure}); the template uses ${urlPattern}.`]
            : []),
    ];

    const fields: Record<string, FieldTemplate> = {};
    for (const [fieldName, type] of Object.entries(input.schema)) {
        const passed = passing[fieldName] ?? [];
        const first = passed[0];
        fields[fieldName] = createFieldTemplate({
            fieldName,
            type,
            // Earlier selectors are the agent's preferred ones; keep that order in the scores.
            selectors: passed.map((result, index) => toSelectorCandidate(result.selector, 90 - index * 5)),
            rawValue: first?.rawValue ?? null,
            normalizedValue: first?.normalizedValue ?? null,
        });
    }

    const domain = normalizeDomain(finalUrl);
    const template: ExtractionTemplate = {
        id: createTemplateId(domain, templatePattern, input.schema),
        domain,
        urlPatterns: [templatePattern],
        schema: input.schema,
        createdFromUrl: finalUrl,
        createdAt: (input.now ?? (() => new Date()))().toISOString(),
        fields,
    };

    return {
        template,
        warnings,
        provider: input.provider.name,
        model: input.model ?? null,
        calls,
    };
}
