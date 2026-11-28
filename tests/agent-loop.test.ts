import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { computeReplyPaceDelayMs } from "../src/agent/dispatch.ts";
import { ModelIds } from "../src/agent/model-ids.ts";
import { parseJargonResponse } from "../src/agent/social-distiller.ts";
import {
  parseSettings,
  resolveMaxOutputTokens,
  resolveThinkingEffort,
} from "../src/config/settings.ts";
import { defineTool } from "../src/tools/define.ts";
import { inspectTapeTool } from "../src/tools/tape.ts";
import type { ToolContext } from "../src/tools/types.ts";
import {
  captureText,
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
      description: "自定义扩展主工具。",
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
  assert.ok(!seenMainToolNames.includes("qq_directory"));
  assert.ok(seenMainToolNames.includes("inspect_media"));
  assert.match(seenMainSystem, /- custom_echo: 自定义扩展主工具。/);
  assert.match(seenMainSystem, /- search_qq_emojis: /);
  assert.doesNotMatch(seenMainSystem, /- qq_directory: /);
  assert.match(seenMainSystem, /\* ops_inspector: 执行自定义运维连通性检查。/);

  const chatAnalyst = app.subagents.get("chat_analyst");
  const chatAnalystToolNames = (chatAnalyst?.tools ?? []).map((entry) =>
    entry.kind === "tool" ? entry.name : entry.id,
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

  const recordedCalls = await app.store.usage.listRecent({ limit: 20 });
  const mainEchoCall = recordedCalls.items
    .flatMap((c) => c.toolCalls)
    .find((tc) => tc.name === "custom_echo");
  const subagentPingCall = recordedCalls.items
    .flatMap((c) => c.toolCalls)
    .find((tc) => tc.name === "ops_ping");

  assert.equal(mainEchoCall?.ok, true);
  assert.match(mainEchoCall?.result ?? "", /"echoed":/);
  assert.equal(typeof mainEchoCall?.durationMs, "number");
  assert.equal(subagentPingCall?.ok, true);
  assert.match(subagentPingCall?.result ?? "", /gateway\.bitnp\.net/);
  assert.equal(typeof subagentPingCall?.durationMs, "number");
  assert.ok(kindProp?.enum?.includes("chat_analyst"));
  assert.ok(!kindProp?.enum?.includes("bunko_operator"));
  assert.ok(!kindProp?.enum?.includes("mcp_operator"));

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
      bunko: app.bunko,
      shortlink: app.shortlink,
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
      role: "guest",
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
      maxOutputTokens: 4096,
      taskThinkingEffort: {
        "subagent": "high",
        "subagent:chat_analyst": "none",
        "compaction": "low",
      },
      taskMaxOutputTokens: {
        "subagent": 3072,
        "subagent:chat_analyst": 6144,
        "impression_update": 1024,
      },
    },
  });

  assert.equal(resolveMaxOutputTokens(baseNone, "dialog"), 4096);
  assert.equal(resolveMaxOutputTokens(baseNone, "impression_update"), 4096);
  assert.equal(resolveMaxOutputTokens(baseNone, "jargon_distill"), 4096);
  assert.equal(resolveMaxOutputTokens(baseNone, "style_distill"), 4096);
  assert.equal(resolveMaxOutputTokens(baseNone, "gate"), 2048);
  assert.equal(resolveMaxOutputTokens(baseNone, "vision"), 2048);

  // parseJargonResponse tolerates extra keys, null/string aliases, skips 1-char terms and excluded bot names.
  const extracted = parseJargonResponse(
    JSON.stringify({
      entries: [
        { term: "树莓娘", aliases: ["树莓"], meaning: "树莓派的拟人化称呼" },
        { term: "寄", aliases: null, meaning: "完蛋了" },
        {
          term: "群串子",
          aliases: "串子",
          meaning: "指群里爱带节奏整活的成员",
          extraNote: "ignored",
        },
        {
          term: "炼丹",
          aliases: ["调参", "树莓", null],
          meaning: "训练模型",
        },
      ],
    }),
    {
      finishReason: "stop",
      maxTokens: 4096,
      excludedTerms: ["树莓娘", "树莓"],
    },
  );

  assert.deepEqual(extracted, [
    {
      term: "群串子",
      aliases: ["串子"],
      meaning: "指群里爱带节奏整活的成员",
    },
    { term: "炼丹", aliases: ["调参"], meaning: "训练模型" },
  ]);

  assert.throws(
    () => parseJargonResponse("", { finishReason: "length", maxTokens: 4096 }),
    /max_tokens=4096/,
  );
  assert.equal(resolveMaxOutputTokens(baseMedium, "impression_update"), 1024);
  assert.equal(
    resolveMaxOutputTokens(baseMedium, "subagent:guild_operator"),
    3072,
  );
  assert.equal(
    resolveMaxOutputTokens(baseMedium, "subagent:chat_analyst"),
    6144,
  );

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
  const observedMaxTokens: Record<string, number | undefined> = {};
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
      max_tokens?: number;
    };
    const sys = reqJson.messages[0]?.content ?? "";
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

    if (sys.includes("专项排查子代理")) {
      observed.subagent = reqJson.reasoning_effort;
      observedMaxTokens.subagent = reqJson.max_tokens;
      res.end(JSON.stringify(chatReply({ brief: "排查完成", references: [] })));

      return;
    }

    observed.dialog = reqJson.reasoning_effort;
    observedMaxTokens.dialog = reqJson.max_tokens;
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
    initialRes.thinkingTasks.some((item) => item.key === "impression_update"),
  );
  assert.ok(
    initialRes.thinkingTasks.some((item) => item.key === "jargon_distill"),
  );
  assert.ok(
    initialRes.thinkingTasks.some((item) => item.key === "style_distill"),
  );
  assert.ok(initialRes.thinkingTasks.some((item) => item.key === "gate"));
  assert.ok(initialRes.thinkingTasks.some((item) => item.key === "vision"));
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
        taskMaxOutputTokens: {
          "dialog": 3200,
          "subagent:deep_checker": 5120,
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
  assert.equal(observedMaxTokens.dialog, 3200);
  assert.equal(observedMaxTokens.subagent, 5120);

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

test("append-only Tape anchors, structured handoff, permission-filtered Views, forked subagent Sidecar Tape, and inspect_tape", async (t) => {
  let forkedSubagentMessages: { role: string; content: string | null }[] = [];
  const mainRequestHistoryLengths: Record<string, number> = {};
  const mainRequestTextByPrompt: Record<string, string> = {};

  const llmStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const sys = reqJson.messages[0]?.content ?? "";

    if (sys.includes("会话历史压缩器")) {
      res.end(
        JSON.stringify(
          chatReply({
            summary: "已完成 Tape 架构方案对齐",
            confirmedFacts: ["采用只追加 Tape 与 Anchor 检查点"],
            openTasks: ["上线 Sidecar 抽屉"],
            pendingFollowups: ["回归验证权限过滤视图"],
          }),
        ),
      );

      return;
    }

    if (sys.includes("专项整理子代理")) {
      forkedSubagentMessages = reqJson.messages;
      res.end(
        JSON.stringify(
          chatReply({
            brief: "已基于主上下文 fork 整理出核心结论，无需重复检索。",
            references: ["fork-view"],
          }),
        ),
      );

      return;
    }

    const lastMsg = reqJson.messages.at(-1);
    const fullSerialized = JSON.stringify(reqJson.messages);

    if (lastMsg?.role === "user" && lastMsg.content?.includes("FORK_ME")) {
      res.end(
        JSON.stringify(
          chatToolCalls([
            {
              id: "call-fork-1",
              name: "delegate_subagent",
              args: {
                kind: "fork_helper",
                task: "基于刚才主对话里的讨论直接整理结论",
                fork: true,
              },
            },
          ]),
        ),
      );

      return;
    }

    if (lastMsg?.role === "user") {
      if (lastMsg.content?.includes("GROUP_B_ADMIN")) {
        mainRequestHistoryLengths.adminGroupB = reqJson.messages.length - 2;
        mainRequestTextByPrompt.adminGroupB = fullSerialized;
      } else if (lastMsg.content?.includes("GROUP_B_NON_ADMIN")) {
        mainRequestHistoryLengths.nonAdminGroupB = reqJson.messages.length - 2;
        mainRequestTextByPrompt.nonAdminGroupB = fullSerialized;
      }
    }

    res.end(
      JSON.stringify(
        chatReply(
          { units: [{ kind: "qq_reply", text: "收到，已记录。" }] },
          {
            prompt_tokens: reqJson.messages.length > 10 ? 3500 : 200,
            completion_tokens: 20,
          },
        ),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      devAuthBypass: true,
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {
      mainModel: {
        contextTokens: 9000,
        maxOutputTokens: 1000,
      },
      policy: {
        adminQQs: ["10001"],
      },
    },
    t,
  );

  app.subagents.register({
    kind: "fork_helper",
    title: "上下文派生助手",
    summary: "支持从主视图 fork 整理任务",
    describeCapability: () => "从主对话上下文直接派生处理。",
    systemPrompt: "你是专项整理子代理。",
    tools: [],
  });

  await app.store.chats.upsert({
    kind: "group",
    chatId: "1001",
    title: "技术保障群",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "2002",
    title: "外部交流群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  // 1) Admin speaks in group:1001 with confidential context.
  const secretMsg = await captureText(app, {
    kind: "group",
    chatId: "1001",
    id: "m-sec-1",
    userId: "10001",
    senderName: "管理员",
    text: "核心机密代号 ALPHA_OMEGA_99",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:1001",
    kind: "group",
    chatId: "1001",
    triggerMessageIds: [secretMsg.message.id],
    senderId: "10001",
    senderName: "管理员",
  });

  // 2) Forked subagent call inherits current main view without dangling unresolved tool_calls and persists Sidecar Tape.
  const forkTrigger = await captureText(app, {
    kind: "group",
    chatId: "1001",
    id: "m-fork-1",
    userId: "10001",
    senderName: "管理员",
    text: "FORK_ME 整理一下刚才的核心代号",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:1001",
    kind: "group",
    chatId: "1001",
    triggerMessageIds: [forkTrigger.message.id],
    senderId: "10001",
    senderName: "管理员",
  });

  assert.ok(
    JSON.stringify(forkedSubagentMessages).includes("ALPHA_OMEGA_99"),
    "forked subagent should inherit prior main context without re-exploring",
  );
  assert.ok(
    forkedSubagentMessages.at(-1)?.content?.includes('"forkedFromMain":true'),
  );

  const activeConv = await app.store.conversations.get();
  const sidecarToolEntry = activeConv?.entries.find(
    (entry) => entry.kind === "message" && entry.sidecarId !== null,
  );

  assert.ok(sidecarToolEntry?.sidecarId, "tool entry should link sidecarId");

  // 3) Permission-filtered View: non-admin in group:2002 cannot see group:1001 entries or global handoff,
  //    while admin in group:2002 sees full cross-chat Tape.
  const nonAdminMsg = await captureText(app, {
    kind: "group",
    chatId: "2002",
    id: "m-ext-1",
    userId: "50005",
    senderName: "外部同学",
    text: "GROUP_B_NON_ADMIN 刚才在聊啥",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:2002",
    kind: "group",
    chatId: "2002",
    triggerMessageIds: [nonAdminMsg.message.id],
    senderId: "50005",
    senderName: "外部同学",
  });

  assert.equal(mainRequestHistoryLengths.nonAdminGroupB, 0);
  assert.doesNotMatch(
    mainRequestTextByPrompt.nonAdminGroupB ?? "",
    /ALPHA_OMEGA_99/,
  );

  const adminInGroupBMsg = await captureText(app, {
    kind: "group",
    chatId: "2002",
    id: "m-adm-b",
    userId: "10001",
    senderName: "管理员",
    text: "GROUP_B_ADMIN 继续跟进",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:2002",
    kind: "group",
    chatId: "2002",
    triggerMessageIds: [adminInGroupBMsg.message.id],
    senderId: "10001",
    senderName: "管理员",
  });

  assert.ok((mainRequestHistoryLengths.adminGroupB ?? 0) > 0);
  assert.match(mainRequestTextByPrompt.adminGroupB ?? "", /ALPHA_OMEGA_99/);

  // 4) Non-destructive compaction appends structured handoff anchor while keeping all prior entries intact.
  const head = await app.store.conversations.open();
  const extraTurns = Array.from({ length: 6 }, (_, i) => [
    { role: "user" as const, content: `补充讨论 ${i}` },
    { role: "assistant" as const, content: `结论 ${i}` },
  ]).flat();

  await app.store.conversations.appendTurn(head.sessionId, extraTurns, {
    chatKey: "group:1001",
  });
  await app.agent.invoke({
    source: "admin_inject",
    chatKey: "group:1001",
    kind: "group",
    chatId: "1001",
    triggerMessageIds: [],
    content: "触发结构化压缩",
  });

  const afterCompact = await app.store.conversations.get();

  assert.equal(afterCompact?.handoff?.summary, "已完成 Tape 架构方案对齐");
  assert.deepEqual(afterCompact?.handoff?.confirmedFacts, [
    "采用只追加 Tape 与 Anchor 检查点",
  ]);
  assert.ok((afterCompact?.handoff?.sourceEntryIds.length ?? 0) > 0);

  const fullBeforeReset = await app.store.conversations.listEntries({
    tapeId: "global",
    limit: 200,
  });

  assert.ok(
    fullBeforeReset.some(
      (entry) => entry.kind === "anchor" && entry.anchor.reason === "compact",
    ),
  );
  assert.ok(
    fullBeforeReset.some(
      (entry) =>
        entry.kind === "message" &&
        typeof entry.message.content === "string" &&
        entry.message.content.includes("ALPHA_OMEGA_99"),
    ),
    "archived entries remain intact in append-only tape_entries",
  );

  // 5) inspect_tape lets admin inspect Sidecar Tape and archived sourceEntryIds; blocks non-admin.
  const makeToolCtx = (role: "admin" | "member"): ToolContext => ({
    services: {
      store: app.store,
      gateway: app.gateway,
      media: app.media,
      bunko: app.bunko,
      shortlink: app.shortlink,
      directory: app.directory,
      guild: app.guild,
      mcp: app.mcp,
      getSettings: () => app.settings,
    },
    actor: {
      chatKey: "group:1001",
      senderQQ: role === "admin" ? "10001" : "50005",
      actorSubject: null,
      actorName: role,
      role,
    },
    ids: new ModelIds(),
  });

  await assert.rejects(
    () =>
      inspectTapeTool
        .bind(makeToolCtx("member"))
        .execute({ sidecarId: sidecarToolEntry.sidecarId! }),
    /仅管理员或网协管理层/,
  );

  const sidecarInspect = (await inspectTapeTool
    .bind(makeToolCtx("admin"))
    .execute({ sidecarId: sidecarToolEntry.sidecarId })) as {
    count: number;
    entries: { role?: string }[];
  };

  assert.ok(sidecarInspect.count >= 2);

  const sourceIds = afterCompact.handoff.sourceEntryIds.slice(0, 2);
  const entryInspect = (await inspectTapeTool
    .bind(makeToolCtx("admin"))
    .execute({ entryIds: sourceIds })) as {
    entries: { id: number }[];
  };

  assert.deepEqual(
    entryInspect.entries.map((e) => e.id),
    sourceIds,
  );

  // 6) Non-destructive reset appends a reset anchor without deleting history; HTTP /api/admin/tape serves full timeline.
  await app.store.conversations.reset();
  const afterReset = await app.store.conversations.get();

  assert.equal(afterReset?.messages.length, 0);

  const { url } = await app.listen();
  const fullTapeRes = (await (
    await fetch(`${url}/api/admin/tape?tapeId=global&limit=200`)
  ).json()) as { entries: { kind: string; anchor?: { reason: string } }[] };

  assert.ok(
    fullTapeRes.entries.some(
      (entry) => entry.kind === "anchor" && entry.anchor?.reason === "reset",
    ),
  );
  assert.ok(fullTapeRes.entries.length > fullBeforeReset.length);

  const sidecarHttpRes = (await (
    await fetch(
      `${url}/api/admin/tape?tapeId=${encodeURIComponent(`sidecar:${sidecarToolEntry.sidecarId}`)}`,
    )
  ).json()) as { entries: unknown[] };

  assert.ok(sidecarHttpRes.entries.length >= 2);
});

test("tool loop guides models back to output units when qq_poke/qq_reaction are called as tools", async (t) => {
  const toolErrorMessages: string[] = [];
  const gatewayCalls: { path: string; body: unknown }[] = [];

  const gwStub = await startStubServer((req, res, bodyText) => {
    gatewayCalls.push({
      path: req.url ?? "",
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: {} }));
  }, t);

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

    res.setHeader("Content-Type", "application/json");
    if (toolMsgs.length === 0) {
      res.end(
        JSON.stringify(
          chatToolCalls([
            {
              id: "call-mistaken-poke",
              name: "qq_poke",
              args: {},
            },
          ]),
        ),
      );

      return;
    }

    toolErrorMessages.push(toolMsgs[0]!.content ?? "");
    res.end(
      JSON.stringify(
        chatReply({
          units: [{ kind: "qq_poke" }],
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {},
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "8881",
    title: "测试群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const captured = await captureText(app, {
    kind: "group",
    chatId: "8881",
    id: "ob-poke-1",
    userId: "12345",
    senderName: "呆唯",
    text: "[戳了戳树莓娘]",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:8881",
    kind: "group",
    chatId: "8881",
    triggerMessageIds: [captured.message.id],
    senderId: "12345",
    senderName: "呆唯",
  });

  assert.equal(toolErrorMessages.length, 1);
  assert.match(toolErrorMessages[0]!, /不是函数工具/);
  assert.match(toolErrorMessages[0]!, /正常可用/);
  assert.doesNotMatch(toolErrorMessages[0]!, /Unknown tool/);
  assert.ok(gatewayCalls.some((c) => c.path.endsWith("/send_poke")));
});

test("multi-bubble qq_reply pacing scales with text length and spaces consecutive sends", async (t) => {
  assert.equal(computeReplyPaceDelayMs("短", 0, 0), 0);
  const shortDelay = computeReplyPaceDelayMs("好的", 600, 1800, 0.5);
  const longDelay = computeReplyPaceDelayMs(
    "这是一句字数比较长、像真人慢慢敲完再发出来的群聊回复内容。",
    600,
    1800,
    0.5,
  );

  assert.ok(shortDelay >= 600 && shortDelay <= 1800);
  assert.ok(longDelay > shortDelay);

  const sendTimestamps: number[] = [];
  const gwStub = await startStubServer((req, res) => {
    if (req.url?.includes("/send_group_msg_async")) {
      sendTimestamps.push(Date.now());
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: {} }));
  }, t);

  const llmStub = await startStubServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        chatReply({
          units: [
            { kind: "qq_reply", text: "第一条短句" },
            { kind: "qq_reply", text: "第二条稍微长一点的补充" },
            { kind: "qq_reply", text: "第三条收尾" },
          ],
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {
      bot: { replyPaceMinMs: 70, replyPaceMaxMs: 120 },
    },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "8882",
    title: "测试节奏群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const msg = await captureText(app, {
    kind: "group",
    chatId: "8882",
    id: "ob-pace-1",
    userId: "12345",
    senderName: "测试君",
    text: "连发三条试试",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:8882",
    kind: "group",
    chatId: "8882",
    triggerMessageIds: [msg.message.id],
    senderId: "12345",
    senderName: "测试君",
  });

  assert.equal(sendTimestamps.length, 3);
  assert.ok(sendTimestamps[1]! - sendTimestamps[0]! >= 55);
  assert.ok(sendTimestamps[2]! - sendTimestamps[1]! >= 55);
});

test("runChatToolLoop breaks redundant read-only tool loops immediately instead of spinning to maxRounds", async (t) => {
  let llmRounds = 0;

  const llmStub = await startStubServer((_req, res, bodyText) => {
    llmRounds++;
    const reqJson = JSON.parse(bodyText) as {
      tools?: unknown[];
    };

    res.setHeader("Content-Type", "application/json");
    if (reqJson.tools && reqJson.tools.length > 0) {
      // Simulate a model repeatedly calling the exact same read-only tool with identical args.
      res.end(
        JSON.stringify(
          chatToolCalls([
            {
              id: `dup_${llmRounds}`,
              name: "search_qq_emojis",
              args: { query: "斜眼笑" },
            },
          ]),
        ),
      );

      return;
    }

    res.end(
      JSON.stringify(
        chatReply({
          units: [{ kind: "qq_reply", text: "收到" }],
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    {},
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "8883",
    title: "防死循环群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const msg = await captureText(app, {
    kind: "group",
    chatId: "8883",
    id: "ob-loop-1",
    userId: "12345",
    senderName: "测试君",
    text: "@树莓娘 测试一下",
    mentionedBot: true,
  });

  const result = await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:8883",
    kind: "group",
    chatId: "8883",
    triggerMessageIds: [msg.message.id],
    senderId: "12345",
    senderName: "测试君",
  });

  // Round 1 executes tool, round 2 detects identical duplicate and triggers wrap-up,
  // round 3 produces final JSON with tools stripped (3 rounds instead of 12!).
  assert.equal(llmRounds, 3);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0]?.kind, "qq_reply");
});
