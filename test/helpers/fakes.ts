import type {
  AgentSideConnection,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";

export { FakePiRpcProcess } from "./fake-pi-rpc-process.js";

type SessionUpdateMsg = Parameters<AgentSideConnection["sessionUpdate"]>[0];

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = [];
  readonly permissionRequests: unknown[] = [];
  readonly elicitationRequests: unknown[] = [];
  nextPermissionResponse: {
    outcome:
      | { outcome: "selected"; optionId: string }
      | { outcome: "cancelled" };
  } = {
    outcome: { optionId: "allow", outcome: "selected" },
  };
  nextElicitationResponse: CreateElicitationResponse = { action: "cancel" };

  sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg);
    return Promise.resolve();
  }

  requestPermission(params: unknown): Promise<{
    outcome:
      | { outcome: "selected"; optionId: string }
      | { outcome: "cancelled" };
  }> {
    this.permissionRequests.push(params);
    return Promise.resolve(this.nextPermissionResponse);
  }

  createElicitation(params: unknown): Promise<CreateElicitationResponse> {
    this.elicitationRequests.push(params);
    return Promise.resolve(this.nextElicitationResponse);
  }
}

export const asAgentConn = (
  conn: FakeAgentSideConnection
): AgentSideConnection =>
  // We only implement the methods used by MagPiAcpSession in tests.
  conn as unknown as AgentSideConnection;
