import assert from "node:assert/strict";
import test from "node:test";

import { ModelIds } from "../src/agent/model-ids.ts";
import { resultsAsText } from "../src/agent/prompt.ts";
import { createTestBerryApp, startStubServer } from "./helpers.ts";

test("agent loop mechanics: byte-static systemPrompt, one-shot OutputResult feed, ModelIds, and compaction", async () => {
  const systemPrompts: string[] = [];
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
      res.end(
        JSON.stringify({
          id: "compact-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ summary: "压缩后的核心结论摘要" }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );

      return;
    }

    systemPrompts.push(sys);
    userMessages.push(reqJson.messages.at(-1)?.content ?? "");

    res.end(
      JSON.stringify({
        id: `m-${systemPrompts.length}`,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                units: [{ kind: "qq_reply", text: "好的" }],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 180,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 120 },
        },
      }),
    );
  });

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const created = await createTestBerryApp(
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
    );
    const { app } = created;

    cleanup = created.cleanup;
    // 1) ModelIds rejects unknown and mismatched handles.
    const ids = new ModelIds();
    const uRef = ids.userRef("12345");
    const gRef = ids.groupRef("67890");
    const mRef = ids.messageRef("999");

    assert.equal(ids.resolveUser(uRef), "12345");
    assert.equal(ids.resolveGroup(gRef), "67890");
    assert.equal(ids.resolveMessage(mRef), "999");
    assert.throws(() => ids.resolveUser(gRef), /kind group/);
    assert.throws(() => ids.resolveMessage("m_999"), /Unknown msg/);

    // 2) resultsAsText collapses identical ok lines while preserving error verbatim.
    const rendered = resultsAsText([
      { module: "qq_gateway", status: "ok", detail: "sent", createdAt: 1 },
      { module: "qq_gateway", status: "ok", detail: "sent", createdAt: 2 },
      {
        module: "qq_gateway",
        status: "error",
        detail: "temp session rejected",
        createdAt: 3,
      },
    ]);

    assert.equal(
      rendered,
      "Output module results from previous deliveries:\n- qq_gateway: ok sent (x2)\n- qq_gateway: error temp session rejected",
    );

    // 3) Push pending results, invoke turn 1 -> turn 2 -> turn 3, assert byte-static systemPrompt + one-shot drain.
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

    // Next turn drains error from unconfigured gateway (1 failure from turn 1's dispatch!).
    await app.agent.invoke({
      source: "admin_inject",
      chatKey: "private:555",
      kind: "private",
      chatId: "555",
      triggerMessageIds: [],
      content: "第二轮问题",
    });

    assert.equal(systemPrompts.length, 2);
    assert.equal(systemPrompts[0], systemPrompts[1]);
    assert.match(userMessages[0]!, /qq_gateway: ok sent \(x2\)/);
    assert.doesNotMatch(userMessages[1]!, /qq_gateway: ok sent \(x2\)/);
    assert.match(userMessages[1]!, /message-gateway 未配置/);

    // 4) Dual-threshold compaction: seed oversized history and verify compaction fires.
    const bigTurns = Array.from({ length: 12 }, (_, idx) => [
      {
        role: "user" as const,
        content: `问题 ${idx} ${"长内容".repeat(200)}`,
        timestamp: Date.now(),
      },
      {
        role: "assistant" as const,
        content: `回答 ${idx} ${"详情".repeat(200)}`,
        timestamp: Date.now(),
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
  } finally {
    await cleanup?.();
    await llmStub.close();
  }
});
