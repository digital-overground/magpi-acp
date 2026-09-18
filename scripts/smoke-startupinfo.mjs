import { spawn } from "node:child_process";

const agent = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
agent.stdout.on("data", (d) => {
  buf += d.toString("utf-8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) {
      continue;
    }
    try {
      const msg = JSON.parse(line);
      if (msg.method === "session/update") {
        const up = msg.params?.update;
        if (
          up?.sessionUpdate === "agent_message_chunk" &&
          up?.content?.type === "text"
        ) {
          const t = String(up.content.text);
          if (
            t.includes("[Context]") &&
            t.includes("[Skills]") &&
            t.includes("[Extensions]")
          ) {
            console.log("OK: got startup info in agent_message_chunk");
            agent.kill("SIGTERM");
            process.exit(0);
          }
        }
      }
    } catch {
      // ignore
    }
  }
});

const send = (obj) => {
  agent.stdin.write(`${JSON.stringify(obj)}\n`);
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
  params: { cwd: process.cwd(), mcpServers: [] },
});

// Trigger first prompt so startup info flushes in the first turn
setTimeout(() => {
  send({
    id: 3,
    jsonrpc: "2.0",
    method: "session/prompt",
    params: { prompt: [{ text: "hi", type: "text" }], sessionId: "dummy" },
  });
}, 200);

// Replace dummy session id once we see session/new response
agent.stdout.on("data", (d) => {
  const s = d.toString("utf-8");
  const match = s.match(
    /"id":2,[^\n]*"result":\{[^}]*"sessionId":"(?<sessionId>[^"]+)"/u
  );
  const sid = match?.groups?.sessionId;
  if (sid) {
    // resend prompt with real session id
    send({
      id: 4,
      jsonrpc: "2.0",
      method: "session/prompt",
      params: { prompt: [{ text: "hi", type: "text" }], sessionId: sid },
    });
  }
});

setTimeout(() => {
  console.error("FAIL: did not observe startup info");
  agent.kill("SIGTERM");
  process.exit(1);
}, 5000);
