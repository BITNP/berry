import assert from "node:assert/strict";
import test from "node:test";

import { createTestBerryApp, startStubServer } from "./helpers.ts";

test("mention_only vs smart_observe micro-batch, confidence threshold, and anti-pollution stripping", async () => {
  const gateCalls: { candidates: { messageId: number; text: string }[] }[] = [];
  const mainCalls: {
    messages: { role: string; content: string | null }[];
  }[] = [];
  let mainMode: "silent" | "reply" = "reply";
  let gateShouldFail = false;

  const llmStub = await startStubServer((req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      model: string;
      messages: { role: string; content: string | null }[];
    };

    res.setHeader("Content-Type", "application/json");

    if (
      req.url === "/v1/chat/completions" &&
      reqJson.model === "gpt-test-gate"
    ) {
      if (gateShouldFail) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "classifier down" }));

        return;
      }

      const payload = JSON.parse(reqJson.messages[1]!.content!) as {
        candidates: { messageId: number; text: string }[];
      };

      gateCalls.push({ candidates: payload.candidates });

      const decisions = payload.candidates.map((item) => {
        if (item.text.includes("低置信度")) {
          return {
            messageId: item.messageId,
            action: "reply",
            confidence: 0.4,
            reason: "不确定是不是在问机器人",
          };
        }

        if (item.text.includes("帮忙查一下")) {
          return {
            messageId: item.messageId,
            action: "reply",
            confidence: 0.92,
            reason: "明确提问请求",
          };
        }

        return {
          messageId: item.messageId,
          action: "ignore",
          confidence: 0.95,
          reason: "水群闲聊",
        };
      });

      res.end(
        JSON.stringify({
          id: "gate-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ decisions }),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      );

      return;
    }

    mainCalls.push({ messages: reqJson.messages });
    const content =
      mainMode === "silent"
        ? JSON.stringify({ units: [] })
        : JSON.stringify({
            units: [{ kind: "qq_reply", text: "收到，已经处理好了" }],
          });

    res.end(
      JSON.stringify({
        id: "main-1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 200,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      }),
    );
  });

  const gwStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("send_group_msg_async")) {
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { message_id: "5001" },
        }),
      );

      return;
    }

    res.end(JSON.stringify({ status: "ok", retcode: 0, data: {} }));
  });

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const created = await createTestBerryApp(
      {
        gatewayUrl: gwStub.url,
        gatewayAccount: "qq",
        gatewayToken: "gw-tok",
        mainBaseUrl: `${llmStub.url}/v1`,
        gateBaseUrl: `${llmStub.url}/v1`,
      },
      {
        gateModel: {
          batchWindowMs: 120,
          minConfidence: 0.65,
          failClosed: true,
          contextMessages: 10,
        },
      },
    );
    const { app } = created;

    cleanup = created.cleanup;
    // 1) Group in mention_only mode drops un-@ water chat with zero LLM cost.
    await app.store.chats.upsert({
      kind: "group",
      chatId: "100",
      title: "大水群",
      enabled: true,
      triggerMode: "mention_only",
    });

    await app.webhook.handle({
      post_type: "message",
      message_type: "group",
      group_id: 100,
      user_id: 2001,
      message_id: "m-noise-1",
      time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text: "哈哈哈今天中午吃什么" } }],
      sender: { nickname: "群友A" },
    });
    assert.equal((await app.store.jobs.list()).length, 0);
    assert.equal(gateCalls.length, 0);

    // 2) Switch to smart_observe: un-@ water chat + question coalesce into ONE 1s batch.
    await app.store.chats.update("group:100", { triggerMode: "smart_observe" });

    // Pre-existing water-chat context saved earlier.
    await app.store.messages.capture({
      kind: "group",
      chatId: "100",
      onebotMessageId: "m-pre-water",
      userId: "2000",
      senderName: "水友",
      text: "旧水群消息_TRANSIENT_MARKER",
      segments: [
        { type: "text", data: { text: "旧水群消息_TRANSIENT_MARKER" } },
      ],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: Date.now() - 5000,
    });

    await app.webhook.handle({
      post_type: "message",
      message_type: "group",
      group_id: 100,
      user_id: 2001,
      message_id: "m-2",
      time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text: "低置信度的一句话" } }],
      sender: { nickname: "群友A" },
    });
    await app.webhook.handle({
      post_type: "message",
      message_type: "group",
      group_id: 100,
      user_id: 2002,
      message_id: "m-3",
      time: Math.floor(Date.now() / 1000),
      message: [
        { type: "text", data: { text: "树莓娘在吗，帮忙查一下昨天的事" } },
      ],
      sender: { nickname: "群友B" },
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    await app.worker.drainOnce();

    // Only 1 gate call batched both candidates!
    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0]!.candidates.length, 2);

    // Low-confidence message was downgraded to ignore; only m-3 triggered main agent.
    const gateHistory = await app.store.gate.list({ chatKey: "group:100" });
    const decLow = gateHistory.items.find((d) =>
      d.messageText?.includes("低置信度"),
    );
    const decReply = gateHistory.items.find((d) =>
      d.messageText?.includes("帮忙查一下"),
    );

    assert.equal(decLow?.action, "ignore");
    assert.match(decLow?.reason ?? "", /低于阈值/);
    assert.equal(decReply?.action, "reply");

    // Main agent saw transient water-chat context during inference...
    assert.equal(mainCalls.length, 1);
    const livePrompt = mainCalls[0]!.messages.at(-1)!.content!;

    assert.match(livePrompt, /旧水群消息_TRANSIENT_MARKER/);

    // ...but persisted global conversation stripped recentContext!
    const conv = await app.store.conversations.get();

    assert.ok(conv);
    assert.equal(conv.messages.length, 2);
    assert.doesNotMatch(
      conv.messages[0]!.content ?? "",
      /旧水群消息_TRANSIENT_MARKER/,
    );
    assert.match(conv.messages[0]!.content ?? "", /帮忙查一下昨天的事/);

    // 3) Silent units: [] does NOT pollute conversation history.
    mainMode = "silent";
    await app.agent.invoke({
      source: "admin_inject",
      chatKey: "group:100",
      kind: "group",
      chatId: "100",
      triggerMessageIds: [],
      content: "误触发测试",
    });
    const convAfterSilent = await app.store.conversations.get();

    assert.equal(convAfterSilent?.messages.length, 2);

    // 4) failClosed: true drops messages when gate endpoint errors.
    gateShouldFail = true;
    await app.webhook.handle({
      post_type: "message",
      message_type: "group",
      group_id: 100,
      user_id: 2003,
      message_id: "m-4",
      time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text: "再来一条" } }],
      sender: { nickname: "群友C" },
    });
    await new Promise((resolve) => setTimeout(resolve, 160));
    await app.worker.drainOnce();
    assert.equal(mainCalls.length, 2); // No new main call after silent one!
  } finally {
    await cleanup?.();
    await llmStub.close();
    await gwStub.close();
  }
});
