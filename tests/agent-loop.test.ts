import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { ModelIds } from "../src/agent/model-ids.ts";
import {
  parseSettings,
  resolveThinkingEffort,
} from "../src/config/settings.ts";
import { defineTool } from "../src/tools/index.ts";
import {
  chatReply,
  chatToolCalls,
  createTestBerryApp,
  startStubServer,
} from "./helpers.ts";

test("agent loop: ModelIds isolation, one-shot OutputResult feed, compaction, and token accounting", async (t) => {
  const userMessages: string[] = [];
  let compactionCalled = false;

  const llmStub = await startStubServer((req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };

    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    const sys = reqJson.messages[0]?.content ?? "";

    if (sys.includes("会话历史压缩器")) {
      compactionCalled = true;
      res.end(JSON.stringify(chatReply({ summary: "压缩后的核心结论摘要" })));

      return;
    }

    userMessages.push(reqJson.messages.at(-1)?.content ?? "");
    const promptTokens = reqJson.messages.length > 20 ? 3200 : 180;

    res.end(
      JSON.stringify(
        chatReply(
          { units: [{ kind: "qq_reply", text: "好的" }] },
          {
            prompt_tokens: promptTokens,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 120 },
          },
        ),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    {
      mainModel: {
        contextTokens: 9000,
        maxOutputTokens: 1000,
      },
    },
    t,
  );

  // ModelIds rejects unknown and cross-kind handles.
  const ids = new ModelIds();
  const uRef = ids.userRef("12345");
  const gRef = ids.groupRef("67890");

  assert.equal(ids.resolveUser(uRef), "12345");
  assert.throws(() => ids.resolveUser(gRef), /kind group/);
  assert.throws(() => ids.resolveTargetChatKey("m_999"), /Unknown/);

  // One-shot pending OutputResult receipts are drained into the next turn and not repeated.
  await app.store.conversations.pushOutputResult({
    module: "qq_gateway",
    status: "ok",
    detail: "sent",
    createdAt: Date.now(),
  });
  await app.store.conversations.pushOutputResult({
    module: "qq_gateway",
    status: "ok",
    detail: "sent",
    createdAt: Date.now(),
  });

  await app.agent.invoke({
    source: "admin_inject",
    chatKey: "private:555",
    kind: "private",
    chatId: "555",
    triggerMessageIds: [],
    content: "第一轮问题",
  });
  await app.agent.invoke({
    source: "admin_inject",
    chatKey: "private:555",
    kind: "private",
    chatId: "555",
    triggerMessageIds: [],
    content: "第二轮问题",
  });

  assert.match(userMessages[0]!, /qq_gateway: ok sent \(x2\)/);
  assert.doesNotMatch(userMessages[1]!, /qq_gateway: ok sent \(x2\)/);
  assert.match(userMessages[1]!, /message-gateway 未配置/);

  // Dual-threshold compaction shrinks oversized history and records usage.
  const bigTurns = Array.from({ length: 12 }, (_, idx) => [
    {
      role: "user" as const,
      content: `问题 ${idx} ${"长内容".repeat(200)}`,
    },
    {
      role: "assistant" as const,
      content: `回答 ${idx} ${"详情".repeat(200)}`,
    },
  ]).flat();
  const conv = await app.store.conversations.open();

  await app.store.conversations.appendTurn(conv.sessionId, bigTurns);
  await app.agent.invoke({
    source: "admin_inject",
    chatKey: "private:555",
    kind: "private",
    chatId: "555",
    triggerMessageIds: [],
    content: "触发压缩",
  });

  assert.equal(compactionCalled, true);
  const compacted = await app.store.conversations.get();

  assert.equal(compacted?.summary, "压缩后的核心结论摘要");
  assert.ok((compacted?.messages.length ?? 999) < bigTurns.length);

  const todaySummary = await app.store.usage.todaySummary(
    app.settings.bot.timezone,
  );

  assert.ok(todaySummary.calls >= 3);
  assert.ok(todaySummary.totalTokens > 0);
  assert.ok(todaySummary.cachedInputTokens > 0);
});

test("extensible tool and subagent registries wire prompts, schemas, isolation, and duplicate guards", async (t) => {
  let seenMainSystem = "";
  let seenMainReasoning: string | undefined;
  let seenSubagentReasoning: string | undefined;
  let seenDelegateSchema: Record<string, unknown> | undefined;
  let seenMainToolNames: string[] = [];
  let customMainToolCalled = false;
  let customSubagentToolCalled = false;

  const llmStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
      reasoning_effort?: string;
      tools?: {
        function: {
          name: string;
          parameters: Record<string, unknown>;
        };
      }[];
    };
    const sys = reqJson.messages[0]?.content ?? "";
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

    if (sys.includes("运维诊断子代理")) {
      seenSubagentReasoning = reqJson.reasoning_effort;
      if (toolMsgs.length === 0) {
        res.end(
          JSON.stringify(
            chatToolCalls([
              {
                id: "call-ops-ping",
                name: "ops_ping",
                args: { host: "gateway.bitnp.net" },
              },
            ]),
          ),
        );

        return;
      }

      res.end(
        JSON.stringify(
          chatReply({
            brief: `节点健康：${toolMsgs[0]!.content}`,
            references: ["gateway.bitnp.net"],
          }),
        ),
      );

      return;
    }

    seenMainSystem = sys;
    seenMainReasoning = reqJson.reasoning_effort;
    seenMainToolNames = (reqJson.tools ?? []).map((item) => item.function.name);
    seenDelegateSchema = reqJson.tools?.find(
      (item) => item.function.name === "delegate_subagent",
    )?.function.parameters;

    if (toolMsgs.length === 0) {
      res.end(
        JSON.stringify(
          chatToolCalls([
            {
              id: "call-custom-main",
              name: "custom_echo",
              args: { text: "hello" },
            },
            {
              id: "call-custom-sub",
              name: "delegate_subagent",
              args: {
                kind: "ops_inspector",
                task: "检查 gateway.bitnp.net 状态",
              },
            },
          ]),
        ),
      );

      return;
    }

    res.end(
      JSON.stringify(
        chatReply({
          units: [{ kind: "qq_reply", text: "扩展工具与子代理已执行" }],
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    {
      mainModel: {
        thinkingEffort: "medium",
      },
    },
    t,
  );

  app.mainTools.register(
    defineTool({
      name: "custom_echo",
      description: "测试扩展主工具",
      capability: "- custom_echo: 自定义扩展主工具。",
      parameters: Type.Object(
        { text: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      execute: async (args) => {
        customMainToolCalled = true;

        return { echoed: args.text };
      },
    }),
  );

  app.subagents.register({
    kind: "ops_inspector",
    title: "运维诊断",
    summary: "检查内部节点连通状态",
    describeCapability: () => "执行自定义运维连通性检查。",
    systemPrompt: "你是隔离运行的运维诊断子代理。",
    tools: [
      defineTool({
        name: "ops_ping",
        description: "探测主机",
        parameters: Type.Object(
          { host: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          customSubagentToolCalled = true;

          return { host: args.host, ok: true };
        },
      }),
    ],
  });

  // Duplicate registrations are rejected cleanly.
  assert.throws(
    () =>
      app.mainTools.register(
        defineTool({
          name: "custom_echo",
          description: "dup",
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: async () => ({}),
        }),
      ),
    /Duplicate tool registration/,
  );
  assert.throws(
    () =>
      app.subagents.register({
        kind: "ops_inspector",
        title: "dup",
        summary: "dup",
        describeCapability: () => "dup",
        systemPrompt: "dup",
        tools: [],
      }),
    /Duplicate subagent registration/,
  );

  const result = await app.agent.invoke({
    source: "admin_inject",
    chatKey: "private:777",
    kind: "private",
    chatId: "777",
    triggerMessageIds: [],
    content: "测试扩展能力",
  });

  assert.equal(result.units.length, 1);
  assert.equal(customMainToolCalled, true);
  assert.equal(customSubagentToolCalled, true);
  assert.equal(seenMainReasoning, "medium");
  assert.equal(seenSubagentReasoning, "low");
  assert.ok(seenMainToolNames.includes("custom_echo"));
  assert.ok(seenMainToolNames.includes("search_qq_emojis"));
  assert.ok(seenMainToolNames.includes("qq_directory"));
  assert.ok(seenMainToolNames.includes("inspect_media"));
  assert.match(seenMainSystem, /- custom_echo: 自定义扩展主工具。/);
  assert.match(seenMainSystem, /\* ops_inspector: 执行自定义运维连通性检查。/);

  const chatAnalyst = app.subagents.get("chat_analyst");
  const chatAnalystToolNames = (chatAnalyst?.tools ?? []).map((tool) =>
    "name" in tool ? tool.name : tool.id,
  );

  assert.deepEqual(chatAnalystToolNames, [
    "list_chats",
    "search_chat_messages",
    "read_chat_window",
    "fetch_older_history",
    "inspect_media",
  ]);

  const kindProp = (
    seenDelegateSchema?.properties as { kind?: { enum?: string[] } } | undefined
  )?.kind;

  assert.ok(kindProp?.enum?.includes("ops_inspector"));

  const subCalls = await app.store.usage.listRecent({
    purpose: "subagent:ops_inspector",
  });

  // Round 1 calls ops_ping, round 2 returns the structured brief.
  assert.equal(subCalls.total, 2);
  assert.equal(subCalls.items[0]?.purpose, "subagent:ops_inspector");

  // Availability guard short-circuits before calling the LLM.
  app.subagents.register({
    kind: "blocked_agent",
    title: "受限子代理",
    summary: "测试前置条件拦截",
    describeCapability: () => "受限测试能力。",
    systemPrompt: "never invoked",
    tools: [],
    checkAvailability: () => "前置条件未满足",
  });
  const blocked = await app.subagents.run("blocked_agent", "任意任务", {
    services: {
      store: app.store,
      gateway: app.gateway,
      media: app.media,
      knowledge: app.knowledge,
      directory: app.directory,
      guild: app.guild,
      mcp: app.mcp,
      getSettings: () => app.settings,
    },
    actor: {
      chatKey: "private:777",
      senderQQ: "777",
      actorSubject: null,
      actorName: "测试",
      actorIsAdmin: false,
      actorIsManager: false,
      actorAdmitted: false,
    },
    ids: new ModelIds(),
  });

  assert.equal(blocked.brief, "前置条件未满足");
  assert.equal(blocked.mutated, false);
});

test("extensible JobRegistry runs custom background jobs with dedupe and exposes metadata via /api/admin/jobs", async (t) => {
  const { app } = await createTestBerryApp(
    {
      devAuthBypass: true,
    },
    {},
    t,
  );
  const { url } = await app.listen();
  const executedTargets: string[] = [];

  app.jobs.register({
    kind: "kb_reindex",
    label: "资料库重建索引",
    lane: "background",
    execute: async (job) => {
      executedTargets.push(String(job.payload.scope ?? ""));
    },
    summarize: (job) => `重建 ${String(job.payload.scope ?? "all")} 索引`,
  });

  const first = await app.store.jobs.enqueueUniqueActive(
    "kb_reindex",
    "kb:all",
    { scope: "knowledge" },
  );
  const second = await app.store.jobs.enqueueUniqueActive(
    "kb_reindex",
    "kb:all",
    { scope: "knowledge" },
  );

  assert.equal(first.alreadyActive, false);
  assert.equal(second.alreadyActive, true);
  assert.equal(second.job.id, first.job.id);

  // Before draining, activeBackgroundJobs reflects the queued custom job.
  const overviewBefore = (await (
    await fetch(`${url}/api/admin/overview`)
  ).json()) as { activeBackgroundJobs: number };

  assert.equal(overviewBefore.activeBackgroundJobs, 1);

  await app.worker.drainOnce();
  assert.deepEqual(executedTargets, ["knowledge"]);

  const jobsRes = (await (
    await fetch(`${url}/api/admin/jobs?lane=background`)
  ).json()) as {
    items: {
      id: number;
      kind: string;
      label: string;
      lane: string;
      summary: string;
      state: string;
      tagType?: unknown;
      links?: unknown;
    }[];
    kinds: { kind: string; label: string; lane: string }[];
    counts: {
      pending: number;
      running: number;
      failed: number;
      backgroundActive: number;
    };
  };

  assert.ok(jobsRes.kinds.some((k) => k.kind === "kb_reindex"));
  assert.equal(jobsRes.counts.backgroundActive, 0);
  const item = jobsRes.items.find((j) => j.id === first.job.id);

  assert.ok(item);
  assert.equal(item.state, "done");
  assert.equal(item.label, "资料库重建索引");
  assert.equal(item.lane, "background");
  assert.equal(item.summary, "重建 knowledge 索引");
  assert.equal(item.tagType, undefined);
  assert.equal(item.links, undefined);
});

test("per-task thinkingEffort resolves defaults, category fallback, and exact overrides end-to-end", async (t) => {
  // Pure precedence checks.
  const baseNone = parseSettings({
    mainModel: { thinkingEffort: "none" },
  });

  assert.equal(resolveThinkingEffort(baseNone, "dialog"), "none");
  assert.equal(
    resolveThinkingEffort(baseNone, "subagent:chat_analyst"),
    "none",
  );
  assert.equal(resolveThinkingEffort(baseNone, "memory_update"), "none");
  assert.equal(resolveThinkingEffort(baseNone, "compaction"), "none");

  const baseMedium = parseSettings({
    mainModel: {
      thinkingEffort: "medium",
      taskThinkingEffort: {
        "subagent": "high",
        "subagent:chat_analyst": "none",
        "compaction": "low",
      },
    },
  });

  assert.equal(resolveThinkingEffort(baseMedium, "dialog"), "medium");
  assert.equal(resolveThinkingEffort(baseMedium, "report"), "medium");
  assert.equal(resolveThinkingEffort(baseMedium, "memory_update"), "none");
  assert.equal(resolveThinkingEffort(baseMedium, "compaction"), "low");
  assert.equal(
    resolveThinkingEffort(baseMedium, "subagent:guild_operator"),
    "high",
  );
  assert.equal(
    resolveThinkingEffort(baseMedium, "subagent:chat_analyst"),
    "none",
  );
  assert.equal(
    resolveThinkingEffort(
      parseSettings({ mainModel: { thinkingEffort: "medium" } }),
      "subagent:custom",
      "high",
    ),
    "high",
  );

  // End-to-end verification via /api/admin/settings and live LLM calls.
  const observed: Record<string, string | undefined> = {};
  const llmStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
      reasoning_effort?: string;
    };
    const sys = reqJson.messages[0]?.content ?? "";
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

    if (sys.includes("专项排查子代理")) {
      observed.subagent = reqJson.reasoning_effort;
      res.end(JSON.stringify(chatReply({ brief: "排查完成", references: [] })));

      return;
    }

    observed.dialog = reqJson.reasoning_effort;
    if (toolMsgs.length === 0) {
      res.end(
        JSON.stringify(
          chatToolCalls([
            {
              id: "call-deep-check",
              name: "delegate_subagent",
              args: { kind: "deep_checker", task: "做一次深度排查" },
            },
          ]),
        ),
      );

      return;
    }

    res.end(
      JSON.stringify(
        chatReply({ units: [{ kind: "qq_reply", text: "已处理" }] }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      devAuthBypass: true,
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    {
      mainModel: {
        thinkingEffort: "low",
      },
    },
    t,
  );

  app.subagents.register({
    kind: "deep_checker",
    title: "深度排查",
    summary: "深度排查测试子代理",
    describeCapability: () => "执行深度排查。",
    systemPrompt: "你是专项排查子代理。",
    tools: [],
  });

  const { url } = await app.listen();
  const initialRes = (await (
    await fetch(`${url}/api/admin/settings`)
  ).json()) as {
    settings: Record<string, unknown> & {
      mainModel: Record<string, unknown>;
    };
    thinkingTasks: { key: string; label: string; fallback?: string }[];
  };

  assert.ok(initialRes.thinkingTasks.some((item) => item.key === "dialog"));
  assert.ok(
    initialRes.thinkingTasks.some(
      (item) =>
        item.key === "subagent:deep_checker" &&
        item.label === "子代理：深度排查",
    ),
  );

  const statusJson = (await (await fetch(`${url}/api/auth/status`)).json()) as {
    csrfToken?: string;
  };
  const putRes = await fetch(`${url}/api/admin/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": statusJson.csrfToken ?? "",
    },
    body: JSON.stringify({
      ...initialRes.settings,
      mainModel: {
        ...initialRes.settings.mainModel,
        thinkingEffort: "low",
        taskThinkingEffort: {
          "dialog": "none",
          "subagent:deep_checker": "high",
        },
      },
    }),
  });

  assert.equal(putRes.status, 200);

  await app.agent.invoke({
    source: "admin_inject",
    chatKey: "private:888",
    kind: "private",
    chatId: "888",
    triggerMessageIds: [],
    content: "测试按任务覆盖思考强度",
  });

  assert.equal(observed.dialog, undefined);
  assert.equal(observed.subagent, "high");

  // excludePurpose=gate keeps core LLM calls separated from gate classifier calls.
  await app.store.usage.record({
    purpose: "gate",
    model: "qwen3.8-flash-next",
    chatKey: "group:123",
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 12,
    durationMs: 80,
  });
  const coreCalls = (await (
    await fetch(`${url}/api/admin/llm-calls?excludePurpose=gate`)
  ).json()) as { items: { purpose: string }[] };

  assert.ok(coreCalls.items.length > 0);
  assert.ok(coreCalls.items.every((item) => item.purpose !== "gate"));
});
