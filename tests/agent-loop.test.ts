import assert from "node:assert/strict";
import test from "node:test";

import { ModelIds } from "../src/agent/model-ids.ts";
import { chatReply, createTestBerryApp, startStubServer } from "./helpers.ts";

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
