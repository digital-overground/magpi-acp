import type { PiRpcEvent } from "../../src/pi-rpc/process.js";

export class FakePiRpcProcess {
  private handlers: ((event: PiRpcEvent) => void)[] = [];

  readonly prompts: { message: string; attachments: unknown[] }[] = [];
  readonly extensionUiResponses: unknown[] = [];
  sessionStats: unknown = {};
  commands: unknown = { commands: [] };
  state: unknown = {};
  availableModels: unknown = {
    models: [{ id: "model", name: "model", provider: "test" }],
  };
  messages: unknown = { messages: [] };
  abortCount = 0;

  onEvent(handler: (event: PiRpcEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(
        (candidate) => candidate !== handler
      );
    };
  }

  emit(event: PiRpcEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ attachments, message });
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.abortCount += 1;
    return Promise.resolve();
  }

  sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response);
    return Promise.resolve();
  }

  getState = (): unknown => Promise.resolve(this.state);
  getAvailableModels = (): unknown => Promise.resolve(this.availableModels);
  getMessages = (): unknown => Promise.resolve(this.messages);
  getSessionStats = (): unknown => Promise.resolve(this.sessionStats);
  getCommands = (): unknown => Promise.resolve(this.commands);
  setSteeringMode: (mode: string) => unknown = () => this.state;
  setFollowUpMode: (mode: string) => unknown = () => this.state;
  setSessionName: (name: string) => unknown = () => this.state;
  getForkMessages: () => unknown = () => this.messages;
  getTree: () => unknown = () => this.state;
  navigateTree: (entryId: string) => unknown = () => this.state;
}
