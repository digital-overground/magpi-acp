// Smoke test for ACP session/load in magpi-acp
//
// Runs:
// 1) initialize
// 2) session/new
// 3) session/prompt
// 4) new process: session/load for the created sessionId

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const spawnAgent = () => {
  const proc = spawn("node", ["dist/index.js"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  proc.stdout.setEncoding("utf-8");

  return {
    kill() {
      proc.kill("SIGTERM");
    },
    proc,
    send(obj) {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
    },
  };
};

const messagesFrom = async function* messagesFrom(agent) {
  const lines = createInterface({ input: agent.proc.stdout });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore non-JSON output.
    }
  }
};

const createAndPrompt = async () => {
  const agent = spawnAgent();
  let sessionId = null;

  agent.send({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  agent.send({
    id: 2,
    jsonrpc: "2.0",
    method: "session/new",
    params: { cwd: process.cwd(), mcpServers: [] },
  });

  for await (const message of messagesFrom(agent)) {
    if (message?.id === 2 && message?.result?.sessionId) {
      ({ sessionId } = message.result);
      agent.send({
        id: 3,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ text: "Hello", type: "text" }],
          sessionId,
        },
      });
    }

    if (message?.id === 3) {
      agent.kill();
      if (sessionId) {
        return sessionId;
      }
      throw new Error("No sessionId");
    }
  }

  throw new Error("Agent exited before creating and prompting a session");
};

const loadAndCountReplay = async (sessionId) => {
  const agent = spawnAgent();
  let updates = 0;

  agent.send({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  agent.send({
    id: 2,
    jsonrpc: "2.0",
    method: "session/load",
    params: { cwd: process.cwd(), mcpServers: [], sessionId },
  });

  for await (const message of messagesFrom(agent)) {
    if (message?.method === "session/update") {
      updates += 1;
    }

    if (message?.id === 2) {
      if (message?.result !== null) {
        throw new Error("Expected session/load result to be null");
      }
      agent.kill();
      return updates;
    }
  }

  throw new Error("Agent exited before loading the session");
};

const sessionId = await createAndPrompt();
const replayUpdates = await loadAndCountReplay(sessionId);
if (replayUpdates === 0) {
  throw new Error("Expected session/load to replay updates");
}
console.log("OK session/load smoke:", { replayUpdates, sessionId });
