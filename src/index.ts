import { once } from "node:events";

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

import { MagPiAcpAgent } from "./acp/agent.js";
import { getPiCommand, shouldUseShellForPiCommand } from "./pi-rpc/command.js";
import {
  MAGPI_ACP_FORK_MESSAGES_METHOD,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
  MAGPI_ACP_TREE_METHOD,
} from "./pi-rpc/tree-command.js";
import { asRecord } from "./unknown.js";

// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes("--terminal-login")) {
  const { spawnSync } = await import("node:child_process");
  const cmd = getPiCommand(process.env.MAGPI_ACP_PI_COMMAND);
  const res = spawnSync(cmd, [], {
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd),
    stdio: "inherit",
  });

  if (asRecord(res.error)?.code === "ENOENT") {
    process.stderr.write(
      `magpi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    );
    process.exit(1);
  }

  process.exit(typeof res.status === "number" ? res.status : 1);
}

const input = new WritableStream<Uint8Array>({
  async write(chunk) {
    if (process.stdout.destroyed || !process.stdout.writable) {
      return;
    }

    try {
      if (!process.stdout.write(chunk)) {
        await once(process.stdout, "drain");
      }
    } catch {
      // Common: ERR_STREAM_DESTROYED ("Cannot call write after a stream was destroyed").
    }
  },
});

const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (chunk: Buffer) => {
      controller.enqueue(new Uint8Array(chunk));
    });
    process.stdin.on("end", () => {
      controller.close();
    });
    process.stdin.on("error", (error) => {
      controller.error(error);
    });
  },
});

const stream = ndJsonStream(input, output);

let magPiAgent: MagPiAcpAgent | undefined;
const getAgent = (): MagPiAcpAgent => {
  if (magPiAgent === undefined) {
    throw new Error("ACP connection is not initialized.");
  }
  return magPiAgent;
};

const parseExtensionParams = (value: unknown): Record<string, unknown> =>
  asRecord(value) ?? {};

const app = agent({ name: "magpi-acp" });
app.onConnect((connection) => {
  const { client } = connection;
  magPiAgent = new MagPiAcpAgent({
    createElicitation: async (params) =>
      await client.request(methods.client.elicitation.create, params),
    requestPermission: async (params) =>
      await client.request(methods.client.session.requestPermission, params),
    sessionUpdate: async (params) => {
      await client.notify(methods.client.session.update, params);
    },
  });
});

app.onRequest(
  methods.agent.initialize,
  async ({ params }) => await getAgent().initialize(params)
);
app.onRequest(
  methods.agent.session.new,
  async ({ params }) => await getAgent().newSession(params)
);
app.onRequest(
  methods.agent.session.load,
  async ({ params }) => await getAgent().loadSession(params)
);
app.onRequest(
  methods.agent.session.fork,
  async ({ params }) => await getAgent().unstable_forkSession(params)
);
app.onRequest(
  methods.agent.session.list,
  async ({ params }) => await getAgent().listSessions(params)
);
app.onRequest(
  methods.agent.session.setMode,
  async ({ params }) => await getAgent().setSessionMode(params)
);
app.onRequest(
  methods.agent.session.setConfigOption,
  async ({ params }) => await getAgent().setSessionConfigOption(params)
);
app.onRequest(
  methods.agent.session.prompt,
  async ({ params }) => await getAgent().prompt(params)
);
app.onRequest(methods.agent.authenticate, async ({ params }) => {
  await getAgent().authenticate(params);
});
app.onNotification(methods.agent.session.cancel, async ({ params }) => {
  await getAgent().cancel(params);
});

for (const method of [
  MAGPI_ACP_FORK_MESSAGES_METHOD,
  MAGPI_ACP_TREE_METHOD,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
]) {
  app.onRequest(
    method,
    parseExtensionParams,
    async ({ params }) => await getAgent().extMethod(method, params)
  );
}

const agentConnection = app.connect(stream);

const shutdown = (): void => {
  // Keep the connection alive until shutdown.
  void agentConnection;
  try {
    // Best-effort: dispose session subprocesses when the client disconnects.
    magPiAgent?.dispose();
  } catch {
    // ignore
  }
  try {
    process.exit(0);
  } catch {
    // ignore
  }
};

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

process.stdin.resume();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Avoid crashing if the client closes stdout early.
process.stdout.on("error", () => {
  try {
    process.exit(0);
  } catch {
    // ignore
  }
});
