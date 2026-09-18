import { spawn } from "node:child_process";
import { once } from "node:events";

const cwd = process.cwd();

// Build first so source-style invocation (node dist/index.js) works.
const build = spawn("npm", ["run", "build"], { cwd, stdio: "inherit" });
const [buildExitCode] = await once(build, "exit");
if (buildExitCode !== 0) {
  throw new Error(`build failed: ${buildExitCode}`);
}

const child = spawn("node", ["dist/index.js"], {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

child.stdout.setEncoding("utf-8");
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

const send = (obj) => {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
};

// Standard ACP handshake, prompt, fork, and load. Simulate a generic client by
// stripping every private metadata field before processing agent messages.
const withoutMeta = (value) => {
  if (Array.isArray(value)) {
    return value.map(withoutMeta);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "_meta")
      .map(([key, item]) => [key, withoutMeta(item)])
  );
};
send({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: { protocolVersion: 1 },
});
send({
  id: 2,
  jsonrpc: "2.0",
  method: "session/new",
  params: { cwd, mcpServers: [] },
});

// We'll send prompt a moment later; sessionId is in response to id=2.
let sessionId = null;
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let msg;
    try {
      msg = withoutMeta(JSON.parse(line));
    } catch {
      continue;
    }

    if (msg?.id === 2 && msg?.result?.sessionId && !sessionId) {
      ({ sessionId } = msg.result);
      send({
        id: 3,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ text: "Say hello in one short sentence.", type: "text" }],
          sessionId,
        },
      });
    }

    if (msg?.id === 3) {
      send({
        id: 4,
        jsonrpc: "2.0",
        method: "session/fork",
        params: { cwd, mcpServers: [], sessionId },
      });
    }

    if (msg?.id === 4 && msg?.result?.sessionId) {
      send({
        id: 5,
        jsonrpc: "2.0",
        method: "session/load",
        params: { cwd, mcpServers: [], sessionId: msg.result.sessionId },
      });
    }

    if (msg?.id === 5) {
      setTimeout(() => child.kill("SIGTERM"), 50);
    }
  }
});
