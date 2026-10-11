import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { ClaudeCliProvider } from "./ClaudeCliProvider";
import { CodexCliProvider } from "./CodexCliProvider";
import { LMStudioProvider } from "./LMStudioProvider";
import { PROVIDER_NAMES, type LLMProvider, type ProviderName } from "./LLMProvider";

export const DEFAULT_LMSTUDIO_MODEL = "qwen/qwen3-30b-a3b-2507@4bit";

export type ProviderChoice = ProviderName | "auto";

export type ResolvedProvider = {
    name: ProviderName;
    model: string | null;
    create(): LLMProvider;
};

export class ProviderSelectionError extends Error {
    constructor(message: string, readonly usageError: boolean) {
        super(message);
        this.name = "ProviderSelectionError";
    }
}

export function resolveProvider(input: {
    provider?: string;
    model?: string;
    env?: NodeJS.ProcessEnv;
    isOnPath?: (command: string) => boolean;
}): ResolvedProvider {
    const env = input.env ?? process.env;
    const claudeCommand = env.TURBO_CRAWL_CLAUDE_BIN || "claude";
    const codexCommand = env.TURBO_CRAWL_CODEX_BIN || "codex";
    const isOnPath = input.isOnPath ?? ((command: string) => commandExists(command, env));
    const requested = (input.provider || env.TURBO_CRAWL_PROVIDER || "auto").trim().toLowerCase();

    if (requested !== "auto" && !(PROVIDER_NAMES as readonly string[]).includes(requested)) {
        throw new ProviderSelectionError(
            `Unknown provider "${requested}". Use one of: auto, ${PROVIDER_NAMES.join(", ")}.`,
            true,
        );
    }

    let name: ProviderName;
    if (requested === "auto") {
        if (isOnPath(claudeCommand)) {
            name = "claude";
        } else if (isOnPath(codexCommand)) {
            name = "codex";
        } else {
            throw new ProviderSelectionError(
                "No coding agent found: install and log in to Claude Code (`claude`) or Codex (`codex`), or pass --provider lmstudio to use a local LM Studio server.",
                false,
            );
        }
    } else {
        name = requested as ProviderName;
    }

    const configuredModel = input.model || env.TURBO_CRAWL_MODEL || null;
    const model = name === "lmstudio" ? configuredModel ?? DEFAULT_LMSTUDIO_MODEL : configuredModel;

    return {
        name,
        model,
        create: () => {
            switch (name) {
                case "claude":
                    return new ClaudeCliProvider({ command: claudeCommand });
                case "codex":
                    return new CodexCliProvider({ command: codexCommand });
                case "lmstudio":
                    return new LMStudioProvider(env.TURBO_CRAWL_LMSTUDIO_URL || undefined);
            }
        },
    };
}

export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (command.includes("/") || command.includes("\\")) {
        try {
            accessSync(command, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const dir of (env.PATH ?? "").split(delimiter)) {
        if (!dir) continue;
        for (const extension of extensions) {
            try {
                accessSync(join(dir, command + extension), constants.X_OK);
                return true;
            } catch {
                // keep looking
            }
        }
    }
    return false;
}
