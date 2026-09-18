import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from "../pi-rpc/tree-command.js";

interface TreeCommandContext {
  waitForIdle: () => Promise<void>;
  navigateTree: (
    targetId: string,
    options: { summarize: false }
  ) => Promise<{ cancelled: boolean }>;
}

interface PiExtensionApi {
  registerCommand: (
    name: string,
    command: {
      description: string;
      handler: (args: string, context: TreeCommandContext) => Promise<void>;
    }
  ) => void;
}

export default function registerMagPiAcpTree(pi: PiExtensionApi): void {
  pi.registerCommand(MAGPI_ACP_NAVIGATE_TREE_COMMAND, {
    description: "Internal magpi-acp native tree navigation bridge",
    handler: async (args, ctx) => {
      const entryId = args.trim();
      if (!entryId) {
        throw new Error("Missing Pi entry ID.");
      }

      await ctx.waitForIdle();
      const result = await ctx.navigateTree(entryId, { summarize: false });
      if (result.cancelled) {
        throw new Error("Pi cancelled tree navigation.");
      }
    },
  });
}
