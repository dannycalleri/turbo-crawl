import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILE_NAME = "turbo-crawl.json";

export const DEFAULT_USER_AGENT =
  `turbo-crawl/${process.env.TURBO_CRAWL_VERSION ?? "dev"} (+https://github.com/dannycalleri/turbo-crawl)`;

const configSchema = z.object({
  userAgent: z.string().trim().min(1).optional(),
});

export type TurboCrawlConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type ConfigLocations = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
};

export function defaultConfigLocations(): ConfigLocations {
  return { cwd: process.cwd(), env: process.env, home: homedir() };
}

export async function resolveUserAgent(
  option: string | undefined,
  locations: ConfigLocations = defaultConfigLocations(),
): Promise<string> {
  const configs: Array<TurboCrawlConfig | null> = [];
  // In priority order, so the error for two invalid files always names the nearest one.
  for (const file of await configFiles(locations)) configs.push(await readConfigFile(file));

  return option?.trim() || configs.find(config => config?.userAgent)?.userAgent || DEFAULT_USER_AGENT;
}

async function configFiles(locations: ConfigLocations): Promise<string[]> {
  const files: string[] = [];
  const repoConfig = await findRepoConfig(path.resolve(locations.cwd));
  if (repoConfig) files.push(repoConfig);

  const configHome = locations.env.XDG_CONFIG_HOME?.trim() || path.join(locations.home, ".config");
  files.push(path.join(configHome, "turbo-crawl", "config.json"));
  return files;
}

// Outside a git repository only the current folder counts, so a stray file in a parent
// folder (or the home folder) is never picked up as a repo config.
async function findRepoConfig(start: string): Promise<string | null> {
  const gitRoot = await findGitRoot(start);
  let dir = start;

  while (true) {
    const candidate = path.join(dir, CONFIG_FILE_NAME);
    if (await exists(candidate)) return candidate;
    if (!gitRoot || dir === gitRoot) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function findGitRoot(start: string): Promise<string | null> {
  let dir = start;
  while (true) {
    if (await exists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readConfigFile(file: string): Promise<TurboCrawlConfig | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`Cannot read the config file ${file}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`The config file ${file} is not valid JSON: ${(error as Error).message}. Fix or remove it.`);
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `The config file ${file} is not valid: ${issue?.path.join(".") || "(root)"}: ${issue?.message}. Fix or remove it.`,
    );
  }
  return parsed.data;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
