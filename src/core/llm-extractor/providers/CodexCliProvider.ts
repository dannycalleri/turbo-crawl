import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    LLMProvider,
    StructuredLLMRequest,
    StructuredLLMResponse,
} from "./LLMProvider";
import {
    describeProcessFailure,
    runProcess,
    splitMessages,
    type RunProcess,
} from "./runProcess";

const LABEL = "Codex";
const HINT = "Run `codex login` once, or pass --provider claude|lmstudio.";

export class CodexCliProvider implements LLMProvider {
    name = "codex" as const;

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
        const command = this.options.command ?? "codex";
        const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? 600_000;
        const run = this.options.run ?? runProcess;
        const workDir = await mkdtemp(join(tmpdir(), "turbo-crawl-codex-"));
        const schemaPath = join(workDir, "schema.json");
        const outputPath = join(workDir, "output.json");

        try {
            await writeFile(schemaPath, JSON.stringify(request.jsonSchema), "utf8");

            const { system, prompt } = splitMessages(request.messages);
            const result = await run({
                command,
                args: buildCodexArgs({ schemaPath, outputPath, model: request.model, workDir }),
                stdin: system ? `${system}\n\n${prompt}` : prompt,
                timeoutMs,
                cwd: workDir,
            });

            if (result.spawnError || result.timedOut || result.exitCode !== 0) {
                throw new Error(describeProcessFailure(LABEL, command, result, timeoutMs, HINT));
            }

            const output = await readFile(outputPath, "utf8").catch(() => null);
            if (output === null) {
                throw new Error(`${LABEL} finished without writing its answer.`);
            }

            try {
                return { parsed: JSON.parse(output), raw: output };
            } catch {
                throw new Error(`${LABEL} answer was not JSON: ${output.trim().slice(0, 300)}`);
            }
        } finally {
            await rm(workDir, { recursive: true, force: true });
        }
    }
}

export function buildCodexArgs(input: {
    schemaPath: string;
    outputPath: string;
    model?: string;
    workDir: string;
}): string[] {
    const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--cd", input.workDir,
        "--output-schema", input.schemaPath,
        "--output-last-message", input.outputPath,
    ];

    if (input.model) {
        args.push("--model", input.model);
    }

    args.push("-");
    return args;
}
