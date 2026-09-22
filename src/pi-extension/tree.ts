import { MAGPI_ACP_NAVIGATE_TREE_COMMAND } from "../pi-rpc/tree-command.js";
import type { TreeNavigationOptions } from "../pi-rpc/tree-command.js";
import { asRecord } from "../unknown.js";

interface TreeCommandContext {
  waitForIdle: () => Promise<void>;
  navigateTree: (
    targetId: string,
    options: TreeNavigationOptions
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
      const payload = asRecord(JSON.parse(args) as unknown);
      if (payload === undefined) {
        throw new Error("Invalid tree navigation payload.");
      }

      const { entryId, summarize, customInstructions } = payload;
      if (typeof entryId !== "string" || entryId.trim().length === 0) {
        throw new Error("Missing Pi entry ID.");
      }
      if (typeof summarize !== "boolean") {
        throw new TypeError("Invalid summarize option.");
      }
      if (
        customInstructions !== undefined &&
        typeof customInstructions !== "string"
      ) {
        throw new Error("Invalid customInstructions option.");
      }

      await ctx.waitForIdle();
      const result = await ctx.navigateTree(entryId, {
        customInstructions,
        summarize,
      });
      if (result.cancelled) {
        throw new Error("Pi cancelled tree navigation.");
      }
    },
  });
}
