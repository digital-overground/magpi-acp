import { spawn } from "node:child_process";
import { once } from "node:events";

const cwd = process.cwd();

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
child.stdout.on("data", (chunk) => process.stdout.write(chunk));

const send = (obj) => {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
};

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
      msg = JSON.parse(line);
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
          prompt: [{ text: "/export", type: "text" }],
          sessionId,
        },
      });
    }

    if (msg?.id === 3) {
      setTimeout(() => child.kill("SIGTERM"), 100);
    }
  }
});

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
