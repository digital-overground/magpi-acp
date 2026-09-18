import { PassThrough } from "node:stream";

import { PiRpcProcess } from "../../src/pi-rpc/process.js";
import type {
  PiForkMessage,
  PiRpcEvent,
  PiSessionTreeNode,
} from "../../src/pi-rpc/process.js";

const isExportResult = (value: unknown): value is { path: string } =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  typeof value.path === "string";

/**
 * A controllable PiRpcProcess backed by a real PiRpcProcess instance. Reflective
 * construction lets the tests provide inert streams while still preserving the
 * class's private-field brand and constructor initialization.
 */
export class FakePiRpcProcess {
  private handlers: ((event: PiRpcEvent) => void)[] = [];

  readonly process: PiRpcProcess;
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

  getState: () => unknown = () => this.state;
  getAvailableModels: () => unknown = () => this.availableModels;
  getMessages: () => unknown = () => this.messages;
  getSessionStats: () => unknown = () => this.sessionStats;
  getCommands: () => unknown = () => this.commands;
  setModel: (provider: string, modelId: string) => unknown = () => this.state;
  setThinkingLevel: (level: string) => unknown = () => this.state;
  setSteeringMode: (mode: string) => unknown = () => this.state;
  setFollowUpMode: (mode: string) => unknown = () => this.state;
  setSessionName: (name: string) => unknown = () => this.state;
  compact: (instructions?: string) => unknown = () => this.state;
  setAutoCompaction: (enabled: boolean) => unknown = () => this.state;
  exportHtml: (outputPath?: string) => unknown = (outputPath) => {
    void this.state;
    return { path: outputPath ?? "" };
  };
  getForkMessages: () => PiForkMessage[] | Promise<PiForkMessage[]> = () => {
    void this.messages;
    return [];
  };
  getTree: () =>
    | { tree: PiSessionTreeNode[]; leafId: string | null }
    | Promise<{ tree: PiSessionTreeNode[]; leafId: string | null }> = () => {
    void this.state;
    return { leafId: null, tree: [] };
  };
  navigateTree: (entryId: string) => unknown = () => this.state;
  fork: (entryId: string) => unknown = () => this.state;
  clone: () => unknown = () => this.state;

  constructor() {
    const child = new EventTarget();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, {
      kill: () => true,
      killed: false,
      on: () => child,
      stderr: new PassThrough(),
      stdin,
      stdout,
    });

    const instance: unknown = Reflect.construct(PiRpcProcess, [child]);
    if (!(instance instanceof PiRpcProcess)) {
      throw new TypeError("Could not construct fake Pi RPC process");
    }
    this.process = instance;

    instance.onEvent = (handler) => {
      this.handlers.push(handler);
      return () => {
        this.handlers = this.handlers.filter(
          (candidate) => candidate !== handler
        );
      };
    };
    instance.prompt = async (message, attachments) => {
      this.prompts.push({ attachments: attachments ?? [], message });
      await Promise.resolve();
    };
    instance.abort = async () => {
      this.abortCount += 1;
      await Promise.resolve();
    };
    instance.sendExtensionUiResponse = async (response) => {
      this.extensionUiResponses.push(response);
      await Promise.resolve();
    };
    instance.getState = async () => await Promise.resolve(this.getState());
    instance.getAvailableModels = async () =>
      await Promise.resolve(this.getAvailableModels());
    instance.getMessages = async () =>
      await Promise.resolve(this.getMessages());
    instance.getSessionStats = async () =>
      await Promise.resolve(this.getSessionStats());
    instance.getCommands = async () =>
      await Promise.resolve(this.getCommands());
    instance.setModel = async (provider, modelId) =>
      await Promise.resolve(this.setModel(provider, modelId));
    instance.setThinkingLevel = async (level) => {
      await Promise.resolve(this.setThinkingLevel(level));
    };
    instance.setSteeringMode = async (mode) => {
      await Promise.resolve(this.setSteeringMode(mode));
    };
    instance.setFollowUpMode = async (mode) => {
      await Promise.resolve(this.setFollowUpMode(mode));
    };
    instance.setSessionName = async (name) => {
      await Promise.resolve(this.setSessionName(name));
    };
    instance.compact = async (instructions) =>
      await Promise.resolve(this.compact(instructions));
    instance.setAutoCompaction = async (enabled) => {
      await Promise.resolve(this.setAutoCompaction(enabled));
    };
    instance.exportHtml = async (outputPath) => {
      const result = await Promise.resolve(this.exportHtml(outputPath));
      return isExportResult(result) ? result : { path: "" };
    };
    instance.getForkMessages = async () => await this.getForkMessages();
    instance.getTree = async () => await this.getTree();
    instance.navigateTree = async (entryId) => {
      await Promise.resolve(this.navigateTree(entryId));
    };
    instance.fork = async (entryId) => {
      await Promise.resolve(this.fork(entryId));
    };
    instance.clone = async () => {
      await Promise.resolve(this.clone());
    };
  }

  emit(event: PiRpcEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
