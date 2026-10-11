import { spawn } from "node:child_process";

export type ProcessResult = {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnError: Error | null;
};

export type RunProcess = (input: {
    command: string;
    args: string[];
    stdin: string;
    timeoutMs: number;
    cwd?: string;
}) => Promise<ProcessResult>;

export const runProcess: RunProcess = ({ command, args, stdin, timeoutMs, cwd }) =>
    new Promise(resolve => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const child = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
            cwd,
        });

        const finish = (result: Omit<ProcessResult, "stdout" | "stderr" | "timedOut">) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ...result, stdout, stderr, timedOut });
        };

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", error => finish({ exitCode: null, spawnError: error }));
        child.on("close", code => finish({ exitCode: code, spawnError: null }));

        child.stdin.on("error", () => {
            // The process may exit before reading stdin; the close handler reports it.
        });
        child.stdin.end(stdin);
    });

export function describeProcessFailure(
    providerLabel: string,
    command: string,
    result: ProcessResult,
    timeoutMs: number,
    hint: string,
): string {
    if (result.spawnError) {
        const code = (result.spawnError as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return `${providerLabel}: \`${command}\` was not found on PATH. ${hint}`;
        }
        return `${providerLabel}: could not start \`${command}\`: ${result.spawnError.message}. ${hint}`;
    }

    if (result.timedOut) {
        return `${providerLabel}: no answer after ${timeoutMs}ms; the process was stopped. Raise TURBO_CRAWL_LLM_TIMEOUT_MS to wait longer.`;
    }

    const stderr = firstLines(result.stderr || result.stdout, 5);
    return `${providerLabel}: \`${command}\` exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}. ${hint}`;
}

export function splitMessages(messages: { role: string; content: string }[]): {
    system: string;
    prompt: string;
} {
    return {
        system: messages.filter(message => message.role === "system").map(message => message.content).join("\n\n"),
        prompt: messages
            .filter(message => message.role !== "system")
            .map(message => message.role === "user" ? message.content : `[${message.role}]\n${message.content}`)
            .join("\n\n"),
    };
}

function firstLines(text: string, count: number): string {
    return text.trim().split("\n").slice(0, count).join(" | ").slice(0, 600);
}
