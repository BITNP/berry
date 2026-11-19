import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  captureText,
  chatReply,
  createTestBerryApp,
  startStubServer,
} from "./helpers.ts";

test("mention_only vs smart_observe micro-batch, confidence threshold, and anti-pollution stripping", async (t) => {
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
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    if (reqJson.model === "gpt-test-gate") {
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
            reason: "不确定是否在问机器人",
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

      res.end(JSON.stringify(chatReply({ decisions })));

      return;
    }

    mainCalls.push({ messages: reqJson.messages });
    res.end(
      JSON.stringify(
        chatReply(
          mainMode === "silent"
            ? { units: [] }
            : { units: [{ kind: "qq_reply", text: "收到，已经处理好了" }] },
        ),
      ),
    );
  }, t);

  const gwStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: req.url?.includes("send_group_msg_async")
          ? { message_id: "5001" }
          : {},
      }),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    {
      gateModel: {
        batchWindowMs: 100,
        minConfidence: 0.65,
        failClosed: true,
        contextMessages: 10,
      },
    },
    t,
  );

  // 1) Group in mention_only mode ignores non-@ messages with zero LLM cost.
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

  // 2) Switch to smart_observe: two messages coalesce into a single gate batch.
  await app.store.chats.update("group:100", { triggerMode: "smart_observe" });
  await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "m-pre-water",
    userId: "2000",
    senderName: "水友",
    text: "旧水群消息_TRANSIENT_MARKER",
    sentAt: Date.now() - 5000,
  });

  for (const [id, uid, name, text] of [
    ["m-2", 2001, "群友A", "低置信度的一句话"],
    ["m-3", 2002, "群友B", "树莓娘在吗，帮忙查一下昨天的事"],
  ] as const) {
    await app.webhook.handle({
      post_type: "message",
      message_type: "group",
      group_id: 100,
      user_id: uid,
      message_id: id,
      time: Math.floor(Date.now() / 1000),
      message: [{ type: "text", data: { text } }],
      sender: { nickname: name },
    });
  }

  await delay(140);
  await app.worker.drainOnce();

  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0]!.candidates.length, 2);

  // Low-confidence message is downgraded to ignore; only m-3 invokes main agent.
  const gateHistory = await app.store.gate.list({ chatKey: "group:100" });

  assert.equal(
    gateHistory.items.find((d) => d.messageText?.includes("低置信度"))?.action,
    "ignore",
  );
  assert.equal(
    gateHistory.items.find((d) => d.messageText?.includes("帮忙查一下"))
      ?.action,
    "reply",
  );

  assert.equal(mainCalls.length, 1);
  assert.match(
    mainCalls[0]!.messages.at(-1)!.content!,
    /旧水群消息_TRANSIENT_MARKER/,
  );

  // Persisted global conversation keeps request content while stripping transient water chat.
  const conv = await app.store.conversations.get();

  assert.ok(conv);
  assert.equal(conv.messages.length, 2);
  assert.doesNotMatch(
    conv.messages[0]!.content ?? "",
    /旧水群消息_TRANSIENT_MARKER/,
  );
  assert.match(conv.messages[0]!.content ?? "", /帮忙查一下昨天的事/);

  // 3) Silent units: [] does not pollute conversation history.
  mainMode = "silent";
  await app.agent.invoke({
    source: "admin_inject",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [],
    content: "误触发测试",
  });
  assert.equal((await app.store.conversations.get())?.messages.length, 2);

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
  await delay(140);
  await app.worker.drainOnce();
  assert.equal(mainCalls.length, 2);
});
