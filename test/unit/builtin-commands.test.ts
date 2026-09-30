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
  MAGPI_ACP_FORK_MESSAGE_ID_META,
  MAGPI_ACP_NAVIGATE_TREE_METHOD,
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

void test("MagPiAcpAgent: rejects retired fork entry IDs", async () => {
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({ sessionFile: "/sessions/source.jsonl" });
  const sessions = new FakeSessions({ proc, sessionId: "s1" });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, sessions);

  await assert.rejects(
    agent.unstable_forkSession({
      _meta: { "magpi-acp/fork-entry-id": "pi-user-1" },
      cwd: "/workspace",
      mcpServers: [],
      sessionId: "s1",
    }),
    { code: -32_602 }
  );
  assert.equal(sessions.forkParams, undefined);
});

const treeUser = (id: string) => ({
  id,
  message: { content: "same", role: "user" },
  type: "message",
});
const treeAssistant = (id: string) => ({
  id,
  message: { content: [{ text: "answer", type: "text" }], role: "assistant" },
  type: "message",
});

void test("MagPiAcpAgent: transcript actions resolve ACP IDs without client target matching", async () => {
  const proc = new FakePiRpcProcess();
  proc.getState = () => ({
    sessionFile: "/sessions/source.jsonl",
    sessionId: "s1",
  });
  const navigated: string[] = [];
  proc.navigateTree = (entryId) => {
    navigated.push(entryId);
  };
  const tree = [
    {
      children: [
        {
          children: [
            {
              children: [{ children: [], entry: treeAssistant("pi-a2") }],
              entry: treeUser("pi-u2"),
            },
            { children: [], entry: treeUser("pi-inactive") },
          ],
          entry: treeAssistant("pi-a1"),
        },
      ],
      entry: treeUser("pi-u1"),
    },
  ];
  proc.getTree = () => ({ leafId: "pi-a2", tree });
  const ids = new Map([
    ["acp-u1", "pi-u1"],
    ["acp-a1", "pi-a1"],
    ["acp-u2", "pi-u2"],
    ["acp-a2", "pi-a2"],
    ["acp-inactive", "pi-inactive"],
  ]);
  let idle = true;
  const sessions = new FakeSessions({
    entryIdForMessage: (id: string) => ids.get(id),
    isIdle: () => idle,
    proc,
    sessionId: "s1",
  });
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  setSessions(agent, sessions);
  const fork = async (messageId: string) =>
    await agent.unstable_forkSession({
      _meta: { [MAGPI_ACP_FORK_MESSAGE_ID_META]: messageId },
      cwd: "/workspace",
      mcpServers: [],
      sessionId: "s1",
    });
  await fork("acp-u2");
  assert.equal(asRecord(sessions.forkParams).entryId, "pi-u2");
  await fork("acp-u1");
  assert.equal(asRecord(sessions.forkParams).entryId, "pi-u1");
  await Promise.all(
    ["acp-a1", "acp-inactive", "unknown"].map(async (messageId) => {
      await assert.rejects(fork(messageId));
    })
  );

  const navigate = async (messageId: string) =>
    await agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      messageId,
      sessionId: "s1",
      summarize: false,
    });
  assert.deepEqual(await navigate("acp-a1"), { draft: null, leafId: "pi-a2" });
  assert.deepEqual(await navigate("acp-u2"), {
    draft: "same",
    leafId: "pi-a2",
  });
  assert.deepEqual(navigated, ["pi-a1", "pi-u2"]);
  await assert.rejects(navigate("acp-inactive"));
  await assert.rejects(navigate("unknown"));
  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      entryId: "pi-u1",
      messageId: "acp-u1",
      sessionId: "s1",
    })
  );
  idle = false;
  await assert.rejects(fork("acp-u2"));
  await assert.rejects(navigate("acp-u2"));
  assert.deepEqual(navigated, ["pi-a1", "pi-u2"]);
});

void test("MagPiAcpAgent: retired picker endpoints are unavailable", async () => {
  const agent = new MagPiAcpAgent(asAgentConn(new FakeAgentSideConnection()));
  await Promise.all(
    ["_magpi-acp/session/fork-messages", "_magpi-acp/session/tree"].map(
      async (method) => {
        await assert.rejects(agent.extMethod(method, { sessionId: "s1" }), {
          code: -32_601,
        });
      }
    )
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
    leafId: "pi-user-1",
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
  setSessions(
    agent,
    new FakeSessions({
      entryIdForMessage: (id: string) =>
        id === "acp-user-1" ? "pi-user-1" : undefined,
      isIdle: () => true,
      proc,
      sessionId: "s1",
    })
  );
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
          messageId: "acp-user-1",
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
            messageId: "acp-user-1",
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
  const activeLeaf = "pi-user-1";
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
  setSessions(
    agent,
    new FakeSessions({
      entryIdForMessage: (id: string) =>
        id === "acp-user-1" ? "pi-user-1" : undefined,
      isIdle: () => true,
      proc,
      sessionId: "s1",
    })
  );

  await assert.rejects(
    agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
      messageId: "acp-user-1",
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
  setSessions(
    agent,
    new FakeSessions({
      entryIdForMessage: (id: string) =>
        id === "acp-compaction" ? "compaction-1" : undefined,
      isIdle: () => true,
      proc,
      sessionId: "s1",
    })
  );

  await Promise.all(
    [
      { messageId: "acp-compaction" },
      { messageId: "foreign-entry" },
      { entryId: "compaction-1" },
    ].map(async (target) => {
      await assert.rejects(
        agent.extMethod(MAGPI_ACP_NAVIGATE_TREE_METHOD, {
          ...target,
          sessionId: "s1",
        }),
        { code: -32_602 }
      );
    })
  );
});
