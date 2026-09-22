import { MAGPI_ACP_NAVIGATE_TREE_COMMAND, type TreeNavigationOptions } from '../pi-rpc/tree-command.js'

type TreeCommandContext = {
  waitForIdle(): Promise<void>
  navigateTree(targetId: string, options: TreeNavigationOptions): Promise<{ cancelled: boolean }>
}

type PiExtensionApi = {
  registerCommand(
    name: string,
    command: {
      description: string
      handler(args: string, context: TreeCommandContext): Promise<void>
    }
  ): void
}

export default function registerMagPiAcpTree(pi: PiExtensionApi): void {
  pi.registerCommand(MAGPI_ACP_NAVIGATE_TREE_COMMAND, {
    description: 'Internal magpi-acp native tree navigation bridge',
    handler: async (args, ctx) => {
      const payload: unknown = JSON.parse(args)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Invalid tree navigation payload.')
      }

      const { entryId, summarize, customInstructions } = payload as Record<string, unknown>
      if (typeof entryId !== 'string' || !entryId.trim()) throw new Error('Missing Pi entry ID.')
      if (typeof summarize !== 'boolean') throw new Error('Invalid summarize option.')
      if (customInstructions !== undefined && typeof customInstructions !== 'string') {
        throw new Error('Invalid customInstructions option.')
      }

      await ctx.waitForIdle()
      const result = await ctx.navigateTree(entryId, { summarize, customInstructions })
      if (result.cancelled) throw new Error('Pi cancelled tree navigation.')
    }
  })
}
