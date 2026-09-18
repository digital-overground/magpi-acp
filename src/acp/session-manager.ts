import { RequestError } from "@agentclientprotocol/sdk";

import { PiRpcProcess, PiRpcSpawnError } from "../pi-rpc/process.js";
import { asRecord } from "../unknown.js";
import { MagPiAcpSession } from "./magpi-session.js";
import type { SessionCreateParams } from "./magpi-session.js";

export class SessionManager {
  private readonly sessions = new Map<string, MagPiAcpSession>();
  private readonly processFactory = {
    spawn: async (
      params: Parameters<typeof PiRpcProcess.spawn>[0]
    ): Promise<PiRpcProcess> => await PiRpcProcess.spawn(params),
  };

  disposeAll(): void {
    for (const id of this.sessions.keys()) {
      this.close(id);
    }
  }

  maybeGet(sessionId: string): MagPiAcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    try {
      session.proc.dispose();
    } catch {
      // Process cleanup is best effort.
    }
    this.sessions.delete(sessionId);
  }

  closeAllExcept(keepSessionId: string): void {
    for (const id of this.sessions.keys()) {
      if (id !== keepSessionId) {
        this.close(id);
      }
    }
  }

  readonly fork = async (params: {
    cwd: string;
    entryId?: string;
    piCommand?: string;
    sourceSessionFile: string;
  }): Promise<string> => {
    const proc = await this.processFactory.spawn({
      cwd: params.cwd,
      piCommand: params.piCommand,
      sessionPath: params.sourceSessionFile,
    });
    try {
      if (params.entryId === undefined) {
        await proc.clone();
      } else {
        const messages = await proc.getForkMessages();
        const forkable = messages.some(
          (message) => message.entryId === params.entryId
        );
        if (forkable) {
          await proc.fork(params.entryId);
        } else {
          throw RequestError.invalidParams(
            `Pi entry is not forkable: ${params.entryId}`
          );
        }
      }
      const state = asRecord(await proc.getState());
      if (
        typeof state?.sessionId !== "string" ||
        typeof state.sessionFile !== "string"
      ) {
        throw RequestError.internalError(
          {},
          "Pi did not return the forked session identity."
        );
      }
      return state.sessionId;
    } finally {
      proc.dispose();
    }
  };

  async create(params: SessionCreateParams): Promise<MagPiAcpSession> {
    let proc: PiRpcProcess;
    try {
      proc = await this.processFactory.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
      });
    } catch (error: unknown) {
      if (error instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: error.code }, error.message);
      }
      throw error instanceof Error ? error : new Error("Could not start Pi.");
    }

    let state: unknown;
    try {
      state = await proc.getState();
    } catch (error: unknown) {
      proc.dispose();
      throw error instanceof Error
        ? error
        : new Error("Could not read Pi session state.");
    }
    const sessionId = asRecord(state)?.sessionId;
    if (typeof sessionId !== "string") {
      proc.dispose();
      throw RequestError.internalError(
        {},
        "Pi did not return the new session identity."
      );
    }
    const session = new MagPiAcpSession({
      conn: params.conn,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      sessionId,
      supportsFormElicitation: params.supportsFormElicitation,
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): MagPiAcpSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`);
    }
    return session;
  }

  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & { proc: PiRpcProcess }
  ): MagPiAcpSession {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const session = new MagPiAcpSession({
      conn: params.conn,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      sessionId,
      supportsFormElicitation: params.supportsFormElicitation,
    });
    this.sessions.set(sessionId, session);
    return session;
  }
}
