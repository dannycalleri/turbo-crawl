import type {
    LLMProvider,
    StructuredLLMRequest,
    StructuredLLMResponse,
} from "./LLMProvider";
import { tmpdir } from "node:os";
import {
    describeProcessFailure,
    splitMessages,
    runProcess,
    type RunProcess,
} from "./runProcess";

const LABEL = "Claude Code";
const HINT = "Run `claude` once to install and log in, or pass --provider codex|lmstudio.";

export class ClaudeCliProvider implements LLMProvider {
    name = "claude" as const;

    constructor(
        private readonly options: {
            command?: string;
            defaultTimeoutMs?: number;
            run?: RunProcess;
        } = {},
    ) { }

    async completeStructured(
        request: StructuredLLMRequest
    ): Promise<StructuredLLMResponse> {
        const command = this.options.command ?? "claude";
        const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? 600_000;
        const run = this.options.run ?? runProcess;

        const result = await run({
            command,
            args: buildClaudeArgs(request),
            stdin: splitMessages(request.messages).prompt,
            timeoutMs,
            cwd: tmpdir(),
        });

        if (result.spawnError || result.timedOut || result.exitCode !== 0) {
            const envelopeError = readEnvelopeError(result.stdout);
            if (envelopeError && !result.spawnError && !result.timedOut) {
                throw new Error(`${LABEL} returned an error: ${envelopeError}. ${HINT}`);
            }
            throw new Error(describeProcessFailure(LABEL, command, result, timeoutMs, HINT));
        }

        return { parsed: parseClaudeEnvelope(result.stdout), raw: safeJson(result.stdout) };
    }
}

// Keeps the headless session minimal: no tools, MCP servers, skills, settings or
// session files, and our own system prompt instead of Claude Code's.
export function buildClaudeArgs(request: StructuredLLMRequest): string[] {
    const { system } = splitMessages(request.messages);
    const args = [
        "-p",
        "--output-format", "json",
        "--json-schema", JSON.stringify(request.jsonSchema),
        "--tools", "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--setting-sources", "",
        "--system-prompt", system || "Return only JSON matching the provided schema.",
    ];

    if (request.model) {
        args.push("--model", request.model);
    }

    return args;
}

export function parseClaudeEnvelope(stdout: string): unknown {
    const envelope = safeJson(stdout);

    if (!isRecord(envelope)) {
        throw new Error(`${LABEL} did not print a JSON result: ${stdout.trim().slice(0, 300)}`);
    }

    if (envelope.is_error === true || envelope.subtype === "error") {
        throw new Error(`${LABEL} returned an error: ${String(envelope.result ?? envelope.subtype)}. ${HINT}`);
    }

    if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
        return envelope.structured_output;
    }

    if (typeof envelope.result === "string") {
        const parsed = safeJson(stripFences(envelope.result));
        if (parsed !== undefined) {
            return parsed;
        }
    }

    throw new Error(`${LABEL} result did not contain structured output.`);
}

function readEnvelopeError(stdout: string): string | null {
    const envelope = safeJson(stdout);
    if (isRecord(envelope) && envelope.is_error === true) {
        return String(envelope.result ?? "unknown error");
    }
    return null;
}

function stripFences(text: string): string {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    return fenced?.[1] ?? trimmed;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
