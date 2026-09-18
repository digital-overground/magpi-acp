import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const isObject = (x: unknown): x is Record<string, unknown> =>
  Boolean(x) && typeof x === "object" && !Array.isArray(x);

const deepMerge = (
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    out[k] = isObject(av) && isObject(v) ? deepMerge(av, v) : v;
  }
  return out;
};

const readJsonFile = (filePath: string): Record<string, unknown> => {
  try {
    if (!existsSync(filePath)) {
      return {};
    }
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
};

export const getAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(homedir(), ".pi", "agent");

const getMergedSettings = (cwd: string): Record<string, unknown> => {
  const globalSettingsPath = path.join(getAgentDir(), "settings.json");
  const projectSettingsPath = path.resolve(cwd, ".pi", "settings.json");

  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
};

export interface PiRole {
  id: string;
  model: string;
  thinkingLevel:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
}

export const getRoles = (): PiRole[] => {
  const roles = readJsonFile(path.join(getAgentDir(), "roles.json"));
  const thinkingLevels = new Set([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  return Object.entries(roles).flatMap(([id, value]) => {
    if (!isObject(value)) {
      return [];
    }
    const model = typeof value.model === "string" ? value.model.trim() : "";
    const thinkingLevel =
      typeof value.thinkingLevel === "string" ? value.thinkingLevel : "";
    if (!id || !model || !thinkingLevels.has(thinkingLevel)) {
      return [];
    }
    return [{ id, model, thinkingLevel } as PiRole];
  });
};

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export const getEnableSkillCommands = (cwd: string): boolean => {
  const merged = getMergedSettings(cwd);

  const direct = merged.enableSkillCommands;
  if (typeof direct === "boolean") {
    return direct;
  }

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills)
    ? merged.skills.enableSkillCommands
    : undefined;
  if (typeof nested === "boolean") {
    return nested;
  }

  return true;
};

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export const getQuietStartup = (cwd: string): boolean => {
  const merged = getMergedSettings(cwd);

  const direct = merged.quietStartup;
  if (typeof direct === "boolean") {
    return direct;
  }

  // Back-compat: some versions used quietStart
  const legacy = merged.quietStart;
  if (typeof legacy === "boolean") {
    return legacy;
  }

  return false;
};
