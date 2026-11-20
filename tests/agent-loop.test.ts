import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { ModelIds } from "../src/agent/model-ids.ts";
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
    res.end(
      JSON.stringify(
        chatReply(
          { units: [{ kind: "qq_reply", text: "好的" }] },
          {
            prompt_tokens: 180,
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
    {},
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
  assert.ok(seenMainToolNames.includes("custom_echo"));
  assert.match(seenMainSystem, /- custom_echo: 自定义扩展主工具。/);
  assert.match(seenMainSystem, /\* ops_inspector: 执行自定义运维连通性检查。/);

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
    },
    ids: new ModelIds(),
  });

  assert.equal(blocked.brief, "前置条件未满足");
  assert.equal(blocked.mutated, false);
});
