import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asRecord } from "../unknown.js";

const piPackage = "@earendil-works/pi-coding-agent";

export interface PiLaunch {
  command: string;
  args: string[];
  shell: boolean;
  packageRoot?: string;
}

export const defaultPiCommand = (): string =>
  platform() === "win32" ? "pi.cmd" : "pi";

export const getPiCommand = (override?: string): string =>
  override ?? defaultPiCommand();

export const shouldUseShellForPiCommand = (cmd: string): boolean => {
  if (platform() !== "win32") {
    return false;
  }

  const normalized = cmd.trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
};

export const resolvePiLaunch = (override?: string): PiLaunch => {
  if (override !== undefined) {
    return {
      args: [],
      command: override,
      shell: shouldUseShellForPiCommand(override),
    };
  }

  try {
    const entry = fileURLToPath(import.meta.resolve(piPackage));
    const root = path.dirname(path.dirname(entry));
    const manifest = asRecord(
      JSON.parse(
        readFileSync(path.join(root, "package.json"), "utf-8")
      ) as unknown
    );
    const bin = asRecord(manifest?.bin);
    if (manifest?.name !== piPackage || typeof bin?.pi !== "string") {
      throw new Error("invalid Pi package manifest");
    }
    const cli = path.resolve(root, bin.pi);
    if (!cli.startsWith(`${root}${path.sep}`) || !existsSync(cli)) {
      throw new Error("Pi CLI is missing or outside its package");
    }
    return {
      args: [cli],
      command: process.execPath,
      packageRoot: root,
      shell: false,
    };
  } catch (error) {
    throw new Error(
      `Packaged Pi is missing or unusable. Reinstall magpi-acp (dependency: ${piPackage}).`,
      { cause: error }
    );
  }
};
