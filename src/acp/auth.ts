import type { AuthMethod } from "@agentclientprotocol/sdk";

export const PI_SETUP_METHOD_ID = "pi_terminal_login";

const terminalAuthLaunchSpec = (): { command: string; args: string[] } => {
  // If we were launched as `node /path/to/dist/index.js`, reuse that.
  // This is the most reliable path for local source configurations.
  const [argv0 = "node", argv1] = process.argv;
  if (argv1 && argv0.includes("node") && argv1.endsWith(".js")) {
    return { args: [argv1, "--terminal-login"], command: argv0 };
  }

  // Fallback: assume `magpi-acp` is on PATH.
  return { args: ["--terminal-login"], command: "magpi-acp" };
};

/**
 * Return standard Terminal Auth fields plus the optional metadata used by clients
 * that support launching authentication in an integrated terminal.
 */
export const getAuthMethods = (opts?: {
  supportsTerminalAuthMeta?: boolean;
}): AuthMethod[] => {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;

  const method: AuthMethod = {
    args: ["--terminal-login"],
    description:
      "Start pi in an interactive terminal to configure API keys or login",
    env: {},
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    type: "terminal",
  };

  if (supportsTerminalAuthMeta) {
    // Best-effort launch spec for clients with integrated terminal authentication.
    method._meta = {
      "terminal-auth": {
        ...terminalAuthLaunchSpec(),
        label: "Launch pi",
      },
    };
  }

  return [method];
};
