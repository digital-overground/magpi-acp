import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import type { AgentClientConnection } from "../../src/acp/connection.js";
import { PiRpcProcess } from "../../src/pi-rpc/process.js";

export { FakePiRpcProcess } from "./fake-pi-rpc-process.js";

export type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asRecord = (value: unknown): UnknownRecord => {
  if (!isRecord(value)) {
    throw new TypeError("Expected an object");
  }
  return value;
};

export const asArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected an array");
  }
  return value;
};

export const replaceProperty = (
  target: object,
  property: PropertyKey,
  value: unknown
): void => {
  Object.defineProperty(target, property, {
    configurable: true,
    value,
    writable: true,
  });
};

export const mockPiSpawn = (spawn: typeof PiRpcProcess.spawn): (() => void) => {
  const originalSpawn = PiRpcProcess.spawn.bind(PiRpcProcess);
  PiRpcProcess.spawn = spawn;
  return () => {
    PiRpcProcess.spawn = originalSpawn;
  };
};

export class FakeAgentSideConnection implements AgentClientConnection {
  readonly updates: SessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly elicitationRequests: CreateElicitationRequest[] = [];
  nextPermissionResponse: RequestPermissionResponse = {
    outcome: { optionId: "allow", outcome: "selected" },
  };
  nextElicitationResponse: CreateElicitationResponse = { action: "cancel" };

  async sessionUpdate(msg: SessionNotification): Promise<void> {
    await Promise.resolve();
    this.updates.push(msg);
  }

  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    await Promise.resolve();
    this.permissionRequests.push(params);
    return this.nextPermissionResponse;
  }

  async createElicitation(
    params: CreateElicitationRequest
  ): Promise<CreateElicitationResponse> {
    await Promise.resolve();
    this.elicitationRequests.push(params);
    return this.nextElicitationResponse;
  }
}

export const asAgentConn = (
  conn: FakeAgentSideConnection
): AgentClientConnection => conn;
