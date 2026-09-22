import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import { MagPiAcpAgent, generateThreadTitle } from "../../src/acp/agent.js";
import {
  MAGPI_ACP_FORK_ENTRY_ID_META,
  MAGPI_ACP_FORK_MESSAGES_METHOD,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
  MAGPI_ACP_TREE_METHOD,
} from "../../src/pi-rpc/tree-command.js";
import type { TreeNavigationOptions } from "../../src/pi-rpc/tree-command.js";
import {
  FakeAgentSideConnection,
  FakePiRpcProcess,
  asAgentConn,
  asRecord,
  replaceProperty,
} from "../helpers/fakes.js";

class FakeSessions {
  forkParams: unknown;
  private readonly session: unknown;

  constructor(session: unknown) {
    this.session = session;
  }

  maybeGet(_id: string): unknown {
    return this.session;
  }

  get(_id: string): unknown {
    return this.session;
  }

  async fork(params: unknown): Promise<string> {
    await Promise.resolve();
    this.forkParams = params;
    return "forked-session";
  }
}

const setSessions = (agent: MagPiAcpAgent, sessions: FakeSessions): void => {
  replaceProperty(agent, "sessions", sessions);
};

void test("MagPiAcpAgent: /steering is handled adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ steeringMode: "one-at-a-time" });

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  const res = await agent.prompt({
    prompt: [{ text: "/steering", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  const content = asRecord(asRecord(conn.updates.at(-1)?.update).content);
  assert.match(String(content.text), /Steering mode: one-at-a-time/u);
});

void test("MagPiAcpAgent: /name sets session display name adapter-side", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();

  let setTo: string | null = null;
  proc.setSessionName = (name: string) => {
    setTo = name;
  };

  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  const res = await agent.prompt({
    prompt: [{ text: "/name My Session", type: "text" }],
    sessionId: "s1",
  });

  assert.equal(res.stopReason, "end_turn");
  assert.equal(proc.prompts.length, 0);
  assert.equal(setTo, "My Session");
  const info = conn.updates.find(
    (message) => message.update.sessionUpdate === "session_info_update"
  );
  assert.equal(asRecord(info?.update).title, "My Session");

  const content = asRecord(asRecord(conn.updates.at(-1)?.update).content);
  assert.match(String(content.text), /Session name set: My Session/u);
});

void test("MagPiAcpAgent: automatically names a thread from its first user message", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  let sessionName: string | undefined;
  let titleRequest: unknown;
  proc.getState = () => ({
    model: { id: "gpt-5.6-sol", provider: "openai-codex" },
    sessionName,
  });
  proc.getMessages = () => ({ messages: [] });
  proc.setSessionName = (name: string) => {
    sessionName = name;
  };

  const session = {
    cwd: process.cwd(),
    proc,
    prompt: async (): Promise<"end_turn"> => {
      await Promise.resolve();
      return "end_turn";
    },
    sessionId: "s1",
    wasCancelRequested: () => false,
  };
  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, new FakeSessions(session));
  replaceProperty(agent, "generateTitle", async (request: unknown) => {
    await Promise.resolve();
    titleRequest = request;
    return "Fix Login Cache Bug";
  });

  await agent.prompt({
    prompt: [{ text: "fix the login caching bug", type: "text" }],
    sessionId: "s1",
  });
  await waitForImmediate();

  assert.deepEqual(titleRequest, {
    cwd: process.cwd(),
    model: "openai-codex/gpt-5.6-sol",
    user: "fix the login caching bug",
  });
  assert.equal(sessionName, "Fix Login Cache Bug");
  const info = conn.updates.find(
    (message) => message.update.sessionUpdate === "session_info_update"
  );
  assert.equal(asRecord(info?.update).title, "Fix Login Cache Bug");
});

void test("generateThreadTitle runs a hardened one-shot Pi call", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "magpi-title-"));
  const command = path.join(directory, "fake-pi");
  const argsPath = path.join(directory, "args.json");
  const previousCommand = process.env.MAGPI_ACP_PI_COMMAND;
  const previousArgsPath = process.env.MAGPI_TEST_ARGS_PATH;
  writeFileSync(
    command,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.MAGPI_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)))
console.log("One Two Three Four Five Six Seven")
`
  );
  chmodSync(command, 0o755);
  process.env.MAGPI_ACP_PI_COMMAND = command;
  process.env.MAGPI_TEST_ARGS_PATH = argsPath;

  try {
    assert.equal(
      await generateThreadTitle({
        cwd: directory,
        model: "test/model",
        user: "test prompt",
      }),
      "One Two Three Four Five Six"
    );
    const parsed: unknown = JSON.parse(readFileSync(argsPath, "utf-8"));
    assert.ok(
      Array.isArray(parsed) &&
        parsed.every((argument) => typeof argument === "string")
    );
    const args: string[] = parsed;
    for (const flag of [
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
    ]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    const modelIndex = args.indexOf("--model");
    const thinkingIndex = args.indexOf("--thinking");
    assert.deepEqual(args.slice(modelIndex, modelIndex + 2), [
      "--model",
      "test/model",
    ]);
    assert.deepEqual(args.slice(thinkingIndex, thinkingIndex + 2), [
      "--thinking",
      "off",
    ]);
  } finally {
    if (previousCommand === undefined) {
      delete process.env.MAGPI_ACP_PI_COMMAND;
    } else {
      process.env.MAGPI_ACP_PI_COMMAND = previousCommand;
    }
    if (previousArgsPath === undefined) {
      delete process.env.MAGPI_TEST_ARGS_PATH;
    } else {
      process.env.MAGPI_TEST_ARGS_PATH = previousArgsPath;
    }
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("MagPiAcpAgent: standard fork clones the current Pi leaf without metadata", async () => {
  const conn = new FakeAgentSideConnection();
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({ proc, sessionId: "s1" });
  const agent = new MagPiAcpAgent(asAgentConn(conn));
  setSessions(agent, sessions);

  const response = await agent.unstable_forkSession({
    cwd: "/workspace",
    mcpServers: [],
    sessionId: "s1",
  });

  assert.deepEqual(response, { sessionId: "forked-session" });
  assert.deepEqual(sessions.forkParams, {
    cwd: "/workspace",
    entryId: undefined,
    piCommand: undefined,
    sourceSessionFile: "/sessions/source.jsonl",
  });
});

void test("MagPiAcpAgent: targeted fork passes a native Pi entry ID", async () => {
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({ proc, sessionId: "s1" });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, sessions);

  await agent.unstable_forkSession({
    _meta: { [MAGPI_ACP_FORK_ENTRY_ID_META]: "pi-user-1" },
    cwd: "/workspace",
    mcpServers: [],
    sessionId: "s1",
  });

  assert.deepEqual(sessions.forkParams, {
    cwd: "/workspace",
    entryId: "pi-user-1",
    piCommand: undefined,
    sourceSessionFile: "/sessions/source.jsonl",
  });
});

void test("MagPiAcpAgent: fork picker returns Pi native fork messages unchanged", async () => {
  const proc = new FakePiRpcProcess();
  const messages = [{ entryId: "pi-user-1", text: "Fix login" }];
  proc.getForkMessages = () => messages;
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_FORK_MESSAGES_METHOD, { sessionId: "s1" }),
    { messages }
  );
});

void test("MagPiAcpAgent: tree picker returns Pi native tree and leaf unchanged", async () => {
  const proc = new FakePiRpcProcess();
  const tree = [{ children: [], entry: { id: "pi-user-1", type: "message" } }];
  proc.getTree = () => ({ leafId: "pi-user-1", tree });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  assert.deepEqual(
    await agent.extMethod(MAGPI_ACP_TREE_METHOD, { sessionId: "s1" }),
    {
      leafId: "pi-user-1",
      tree,
    }
  );
});

void test("MagPiAcpAgent: tree navigation passes summary choices and keeps the session identity", async () => {
  const proc = new FakePiRpcProcess();
  const navigations: {
    entryId: string;
    options: TreeNavigationOptions | undefined;
  }[] = [];
  const tree = [
    {
      children: [],
      entry: {
        id: "pi-user-1",
        message: { content: "Fix login", role: "user" },
        type: "message",
      },
    },
  ];
  proc.getTree = () => ({
    leafId: navigations.length > 0 ? "pi-user-1" : "pi-assistant-2",
    tree,
  });
  proc.getState = () => ({
    sessionFile: "/sessions/source.jsonl",
    sessionId: "s1",
  });
  proc.navigateTree = (entryId, options) => {
    navigations.push({ entryId, options });
  };
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));
  const customInstructions = "Focus on auth paths.\nKeep exact errors.";
  const choices: {
    params: Record<string, unknown>;
    options: TreeNavigationOptions;
  }[] = [
    {
      options: { customInstructions: undefined, summarize: false },
      params: {},
    },
    {
      options: { customInstructions: undefined, summarize: false },
      params: { summarize: false },
    },
    {
      options: { customInstructions: undefined, summarize: true },
      params: { summarize: true },
    },
    {
      options: { customInstructions, summarize: true },
      params: { customInstructions, summarize: true },
    },
  ];

  const responses = await Promise.all(
    choices.map(
      async (choice) =>
        await agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
          entryId: "pi-user-1",
          sessionId: "s1",
          ...choice.params,
        })
    )
  );
  for (const response of responses) {
    assert.deepEqual(response, { draft: "Fix login", leafId: "pi-user-1" });
  }
  assert.deepEqual(
    navigations,
    choices.map(({ options }) => ({ entryId: "pi-user-1", options }))
  );
});

void test("MagPiAcpAgent: tree navigation rejects malformed summary options before invoking Pi", async () => {
  const proc = new FakePiRpcProcess();
  let piCalls = 0;
  proc.getTree = () => {
    piCalls += 1;
    return { leafId: null, tree: [] };
  };
  proc.getState = () => {
    piCalls += 1;
    return {};
  };
  proc.navigateTree = () => {
    piCalls += 1;
  };
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  await Promise.all(
    [{ summarize: "true" }, { customInstructions: ["focus"] }].map(
      async (options) => {
        await assert.rejects(
          agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
            entryId: "pi-user-1",
            sessionId: "s1",
            ...options,
          }),
          { code: -32_602 }
        );
      }
    )
  );
  assert.equal(piCalls, 0);
});

void test("MagPiAcpAgent: tree navigation surfaces summary failure without changing the leaf", async () => {
  const proc = new FakePiRpcProcess();
  const activeLeaf = "pi-assistant-2";
  const tree = [
    {
      children: [],
      entry: {
        id: "pi-user-1",
        message: { content: "Fix login", role: "user" },
        type: "message",
      },
    },
  ];
  let attempts = 0;
  proc.getTree = () => ({ leafId: activeLeaf, tree });
  proc.getState = () => ({
    sessionFile: "/sessions/source.jsonl",
    sessionId: "s1",
  });
  proc.navigateTree = () => {
    attempts += 1;
    throw new Error("branch summary failed");
  };
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "pi-user-1",
      sessionId: "s1",
      summarize: true,
    }),
    /branch summary failed/u
  );
  assert.equal(attempts, 1);
  const currentTree = await proc.process.getTree();
  assert.equal(currentTree.leafId, activeLeaf);
});

void test("MagPiAcpAgent: tree navigation rejects non-message and stale entry IDs", async () => {
  const proc = new FakePiRpcProcess();
  proc.getTree = () => ({
    leafId: "compaction-1",
    tree: [{ children: [], entry: { id: "compaction-1", type: "compaction" } }],
  });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, new FakeSessions({ proc, sessionId: "s1" }));

  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "compaction-1",
      sessionId: "s1",
    }),
    { code: -32_602 }
  );
  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "foreign-entry",
      sessionId: "s1",
    }),
    { code: -32_602 }
  );
});
