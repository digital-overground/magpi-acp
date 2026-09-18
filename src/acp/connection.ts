import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export interface AgentClientConnection {
  createElicitation: (
    params: CreateElicitationRequest
  ) => Promise<CreateElicitationResponse>;
  requestPermission: (
    params: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  sessionUpdate: (params: SessionNotification) => Promise<void>;
}
