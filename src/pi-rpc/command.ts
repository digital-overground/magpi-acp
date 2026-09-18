import { platform } from "node:os";

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
