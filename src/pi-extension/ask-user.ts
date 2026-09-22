type AskOption = { title: string; description?: string }
type AskResponse = { kind: 'selection'; selections: string[]; comment?: string } | { kind: 'freeform'; text: string }
type AskParams = {
  question: string
  context?: string
  options?: AskOption[]
  allowMultiple?: boolean
  allowFreeform?: boolean
  allowComment?: boolean
  timeout?: number
}
type DialogOptions = { timeout?: number; signal?: AbortSignal }
type AskContext = {
  hasUI: boolean
  ui: {
    select(title: string, options: string[], settings?: DialogOptions): Promise<string | undefined>
    input(title: string, placeholder?: string, settings?: DialogOptions): Promise<string | undefined>
  }
}
type AskResult = {
  content: Array<{ type: 'text'; text: string }>
  details: {
    question: string
    context?: string
    options: AskOption[]
    response: AskResponse | null
    cancelled: boolean
  }
}
type AskTool = {
  name: string
  label: string
  description: string
  promptSnippet: string
  promptGuidelines: string[]
  executionMode: 'sequential'
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: AskParams,
    signal: AbortSignal | undefined,
    onUpdate: ((result: AskResult) => void) | undefined,
    context: AskContext
  ): Promise<AskResult>
}
type PiExtensionApi = {
  getAllTools(): Array<{ name: string }>
  on(event: 'session_start', handler: () => void): void
  registerTool(tool: AskTool): void
}

const FREEFORM_OPTION = '✏️ Type custom response...'

function result(params: AskParams, response: AskResponse | null): AskResult {
  const context = params.context?.trim() || undefined
  const options = params.options ?? []
  return {
    content: [
      {
        type: 'text',
        text: response
          ? `User answered: ${response.kind === 'freeform' ? response.text : response.selections.join(', ')}${response.kind === 'selection' && response.comment ? ` — ${response.comment}` : ''}`
          : 'User cancelled the question'
      }
    ],
    details: {
      question: params.question,
      ...(context ? { context } : {}),
      options,
      response,
      cancelled: response === null
    }
  }
}

export default function registerMagPiAcpAskUser(pi: PiExtensionApi): void {
  const tool: AskTool = {
    name: 'ask_user',
    label: 'Ask User',
    description:
      'Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call.',
    promptSnippet: 'Ask the user one focused question with optional multiple-choice answers',
    promptGuidelines: [
      "Use ask_user when the user's intent is ambiguous, a decision requires explicit input, or multiple valid options exist.",
      'Ask exactly one focused question per ask_user call.'
    ],
    executionMode: 'sequential',
    parameters: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, description: 'The question to ask the user' },
        context: { type: 'string', description: 'Relevant context to show before the question' },
        options: {
          type: 'array',
          description: 'List of options for the user to choose from',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', minLength: 1, description: 'Short title for this option' },
              description: { type: 'string', description: 'Longer description explaining this option' }
            }
          }
        },
        allowMultiple: { type: 'boolean', description: 'Allow selecting multiple options. Default: false' },
        allowFreeform: { type: 'boolean', description: 'Add a freeform text option. Default: true' },
        allowComment: { type: 'boolean', description: 'Collect an optional comment after selection. Default: false' },
        timeout: { type: 'number', minimum: 1, description: 'Auto-cancel after this many milliseconds' }
      }
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted || !ctx.hasUI) return result(params, null)

      const options = params.options ?? []
      const prompt = params.context?.trim()
        ? `${params.question}\n\nContext:\n${params.context.trim()}`
        : params.question
      const dialogOptions =
        params.timeout || signal
          ? { ...(params.timeout ? { timeout: params.timeout } : {}), ...(signal ? { signal } : {}) }
          : undefined

      if (options.length === 0) {
        const answer = (await ctx.ui.input(prompt, 'Type your answer...', dialogOptions))?.trim()
        return result(params, answer ? { kind: 'freeform', text: answer } : null)
      }

      if (params.allowMultiple) {
        const choices = options
          .map(
            (option, index) => `${index + 1}. ${option.title}${option.description ? ` — ${option.description}` : ''}`
          )
          .join('\n')
        const answer = await ctx.ui.input(
          `${prompt}\n\nOptions (select one or more):\n${choices}`,
          'Type your selection(s)...',
          dialogOptions
        )
        const selections = answer
          ?.split(',')
          .map(selection => selection.trim())
          .filter(Boolean)
        if (!selections?.length) return result(params, null)

        const comment = params.allowComment
          ? (await ctx.ui.input(prompt, 'Optional comment (press Enter to skip)...', dialogOptions))?.trim()
          : undefined
        return result(params, {
          kind: 'selection',
          selections,
          ...(comment ? { comment } : {})
        })
      }

      const choices = options.map(option => option.title)
      if (params.allowFreeform !== false) choices.push(FREEFORM_OPTION)
      const selected = (await ctx.ui.select(prompt, choices, dialogOptions))?.trim()
      if (!selected) return result(params, null)

      if (selected === FREEFORM_OPTION) {
        const answer = (await ctx.ui.input(prompt, 'Type your answer...', dialogOptions))?.trim()
        return result(params, answer ? { kind: 'freeform', text: answer } : null)
      }

      const comment = params.allowComment
        ? (await ctx.ui.input(prompt, 'Optional comment (press Enter to skip)...', dialogOptions))?.trim()
        : undefined
      return result(params, {
        kind: 'selection',
        selections: [selected],
        ...(comment ? { comment } : {})
      })
    }
  }

  // Let an existing ask_user package win instead of failing Pi startup on a duplicate tool name.
  pi.on('session_start', () => {
    if (!pi.getAllTools().some(candidate => candidate.name === tool.name)) pi.registerTool(tool)
  })
}
