import { once } from "node:events";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { MagPiAcpAgent } from "./acp/agent.js";
import { getPiCommand, shouldUseShellForPiCommand } from "./pi-rpc/command.js";
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes("--terminal-login")) {
  const { spawnSync } = await import("node:child_process");
  const cmd = getPiCommand(process.env.MAGPI_ACP_PI_COMMAND);
  const res = spawnSync(cmd, [], {
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd),
    stdio: "inherit",
  });

  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
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
    process.stdin.on("data", (chunk: Buffer) =>
      controller.enqueue(new Uint8Array(chunk))
    );
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (err) => controller.error(err));
  },
});

const stream = ndJsonStream(input, output);

let magPiAgent: MagPiAcpAgent | undefined;
const agentConnection = new AgentSideConnection((connection) => {
  magPiAgent = new MagPiAcpAgent(connection);
  return magPiAgent;
}, stream);

const shutdown = () => {
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
