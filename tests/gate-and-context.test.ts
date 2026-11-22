import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadEnvConfig } from "../src/config/env.ts";
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

  await app.gatewayEvents.handleEvent({
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
    await app.gatewayEvents.handleEvent({
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
  await app.gatewayEvents.handleEvent({
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

  // Direct @ mention arriving during an active delayed batch immediately flushes run_after.
  await app.worker.stop();
  await app.updateSettings({
    ...app.settings,
    gateModel: { ...app.settings.gateModel, batchWindowMs: 5000 },
  });
  await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "group",
    group_id: 100,
    user_id: 2001,
    message_id: "m-5",
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text: "先发一条普通消息" } }],
    sender: { nickname: "群友A" },
  });
  const delayedBatches = (await app.store.jobs.list(20)).filter(
    (job) => job.kind === "gate_batch" && job.state === "pending",
  );

  assert.equal(delayedBatches.length, 1);
  assert.ok(delayedBatches[0]!.runAfter > Date.now() + 2000);

  await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "group",
    group_id: 100,
    user_id: 2002,
    message_id: "m-6",
    time: Math.floor(Date.now() / 1000),
    message: [
      { type: "at", data: { qq: "999999" } },
      { type: "text", data: { text: " 直接提问不等待" } },
    ],
    sender: { nickname: "群友B" },
  });
  const flushedBatches = (await app.store.jobs.list(20)).filter(
    (job) => job.kind === "gate_batch" && job.state === "pending",
  );

  assert.equal(flushedBatches.length, 1);
  assert.ok(
    flushedBatches[0]!.runAfter <= Date.now() + 50,
    "direct @ should advance pending gate_batch runAfter immediately",
  );
});

test("BERRY_ALLOWED_GROUPS restricts group events, group listing, and outbound group dispatch at the gateway boundary", async (t) => {
  assert.deepEqual(
    loadEnvConfig({ BERRY_ALLOWED_GROUPS: "100, 200, 100" }).allowedGroups,
    ["100", "200"],
  );
  assert.throws(
    () => loadEnvConfig({ BERRY_ALLOWED_GROUPS: "100,abc" }),
    /Invalid numeric ID/,
  );

  const gatewayCalls: string[] = [];

  const gwStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    gatewayCalls.push(req.url ?? "");

    if (req.url === "/api/v1/accounts/qq/get_group_list") {
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: [
            { group_id: 100, group_name: "白名单群" },
            { group_id: 200, group_name: "未授权群" },
          ],
        }),
      );

      return;
    }

    res.end(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { message_id: "msg-allowed-1" },
      }),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      allowedGroups: ["100"],
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
    },
    {},
    t,
  );

  // Non-whitelisted group events are rejected at the gateway ingress before touching storage.
  for (const event of [
    {
      post_type: "message",
      message_type: "group",
      group_id: 200,
      user_id: 3001,
      message_id: "m-200-1",
      time: Math.floor(Date.now() / 1000),
      message: "[CQ:at,qq=999999] 在吗",
      sender: { nickname: "群友甲" },
    },
    {
      post_type: "notice",
      notice_type: "group_recall",
      group_id: 200,
      user_id: 3001,
      message_id: "m-200-1",
      time: Math.floor(Date.now() / 1000),
    },
    {
      post_type: "notice",
      notice_type: "group_msg_emoji_like",
      group_id: 200,
      user_id: 3001,
      message_id: "m-200-1",
      likes: [{ emoji_id: "76", count: 1 }],
    },
  ]) {
    assert.deepEqual(await app.gatewayEvents.handleEvent(event), {
      accepted: true,
      reason: "group_restricted",
    });
  }

  assert.equal(await app.store.chats.get("group:200"), null);
  assert.equal(
    (await app.store.messages.search("group:200", { limit: 10 })).length,
    0,
  );

  // Whitelisted group and private messages still enter normally.
  const allowedMsg = await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "group",
    group_id: 100,
    user_id: 3001,
    message_id: "m-100-1",
    time: Math.floor(Date.now() / 1000),
    message: "[CQ:at,qq=999999] 你好",
    sender: { nickname: "群友甲" },
  });
  const privateMsg = await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "private",
    user_id: 555,
    message_id: "m-priv-1",
    time: Math.floor(Date.now() / 1000),
    message: "私聊测试",
    sender: { nickname: "私聊用户" },
  });
  // Group temporary sessions carry group_id (possibly a non-whitelisted jump group or 0)
  // and must NOT be dropped by allowedGroups.
  const tempSessionMsg = await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "private",
    sub_type: "group",
    group_id: 200,
    user_id: 556,
    message_id: "m-temp-1",
    time: Math.floor(Date.now() / 1000),
    message: "群临时会话测试",
    sender: { nickname: "临时会话用户" },
  });

  assert.ok(allowedMsg.accepted && allowedMsg.messageId);
  assert.ok(privateMsg.accepted && privateMsg.messageId);
  assert.ok(tempSessionMsg.accepted && tempSessionMsg.messageId);
  assert.ok(await app.store.chats.get("private:556"));

  // getGroupList filters to allowedGroups.
  const groups = await app.gateway.getGroupList();

  assert.deepEqual(groups, [{ group_id: 100, group_name: "白名单群" }]);

  // Outbound dispatch is blocked locally for non-whitelisted groups and allowed for whitelisted groups.
  const sendCalls = () =>
    gatewayCalls.filter((u) => u.endsWith("/send_group_msg_async"));
  const callsBeforeDispatch = sendCalls().length;
  const blockedDispatch = await app.gateway.dispatchUnit(
    "group:200",
    { kind: "qq_reply", text: "不应发出" },
    "999999",
  );

  assert.equal(blockedDispatch.status, "failed");
  assert.match(blockedDispatch.error ?? "", /白名单/);
  assert.equal(sendCalls().length, callsBeforeDispatch);

  const allowedDispatch = await app.gateway.dispatchUnit(
    "group:100",
    { kind: "qq_reply", text: "允许群回复" },
    "999999",
  );

  assert.equal(allowedDispatch.status, "sent");
  assert.equal(sendCalls().length, callsBeforeDispatch + 1);

  // Hot-clearing policy.allowedGroups immediately lifts the restriction without restart.
  await app.updateSettings({
    ...app.settings,
    policy: { ...app.settings.policy, allowedGroups: [] },
  });

  const liftedMsg = await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "group",
    group_id: 200,
    user_id: 3001,
    message_id: "m-200-2",
    time: Math.floor(Date.now() / 1000),
    message: "[CQ:at,qq=999999] 放开了吗",
    sender: { nickname: "群友甲" },
  });

  assert.ok(liftedMsg.accepted && liftedMsg.messageId);
  assert.deepEqual(await app.gateway.getGroupList(), [
    { group_id: 100, group_name: "白名单群" },
    { group_id: 200, group_name: "未授权群" },
  ]);

  const liftedDispatch = await app.gateway.dispatchUnit(
    "group:200",
    { kind: "qq_reply", text: "放开后群回复" },
    "999999",
  );

  assert.equal(liftedDispatch.status, "sent");
});

test("gate classifier sends max_tokens >= 2048, mentionedOthers/replyToOther flags, and real memoryHints in dryRun", async (t) => {
  const seenRequests: {
    maxTokens?: number;
    systemPrompt: string;
    payload: {
      memoryHints: {
        global?: { key: string; summary: string }[];
        chat: { key: string; summary: string }[];
      };
      candidates: {
        mentionedBot: boolean;
        mentionedOthers: boolean;
        quotedBot: boolean;
        replyToOther: boolean;
      }[];
    };
  }[] = [];

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      max_tokens?: number;
      messages: { role: string; content: string }[];
    };
    const payload = JSON.parse(reqJson.messages[1]!.content) as {
      memoryHints: {
        global?: { key: string; summary: string }[];
        chat: { key: string; summary: string }[];
      };
      candidates: {
        messageId: number;
        mentionedBot: boolean;
        mentionedOthers: boolean;
        quotedBot: boolean;
        replyToOther: boolean;
      }[];
    };

    seenRequests.push({
      maxTokens: reqJson.max_tokens,
      systemPrompt: reqJson.messages[0]!.content,
      payload,
    });

    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        chatReply({
          decisions: payload.candidates.map((c) => ({
            messageId: c.messageId,
            action: c.mentionedBot ? "reply" : "ignore",
            confidence: 0.9,
            reason: "测试决策",
          })),
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
      botQQ: "999999",
    },
    {
      gateModel: {
        batchWindowMs: 100,
      },
    },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "300",
    title: "活跃测试群",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.memories.upsert({
    scope: "global",
    ownerId: "global",
    key: "bot_speaking_style",
    summary: "全局默认克制话少",
    content: "全局默认克制话少",
  });
  await app.store.memories.upsert({
    scope: "chat",
    ownerId: "group:300",
    key: "group_active_style",
    summary: "本群可以积极一点，多回应大家",
    content: "本群可以积极一点，多回应大家",
  });

  // 1) Message @ing someone else while quoting a human message sets mentionedOthers & replyToOther.
  const humanOrig = await captureText(app, {
    kind: "group",
    chatId: "300",
    id: "m-human-1",
    userId: "2001",
    senderName: "甲",
    text: "原消息",
  });
  const atOther = await app.store.messages.capture({
    kind: "group",
    chatId: "300",
    onebotMessageId: "m-at-other",
    userId: "2002",
    senderName: "乙",
    text: "@甲 讨论一下树莓娘的逻辑",
    segments: [
      { type: "at", data: { qq: "2001" } },
      { type: "text", data: { text: " 讨论一下树莓娘的逻辑" } },
    ],
    replyToMessageId: humanOrig.message.onebotMessageId,
    isBot: false,
    mentionedBot: false,
    sentAt: Date.now(),
  });

  await app.gate.ingest(atOther.message);
  await delay(140);
  await app.worker.drainOnce();

  assert.equal(seenRequests.length, 1);
  assert.ok((seenRequests[0]?.maxTokens ?? 0) >= 2048);
  assert.match(seenRequests[0]!.systemPrompt, /memoryHints\.chat/);
  assert.equal(seenRequests[0]!.payload.candidates[0]?.mentionedOthers, true);
  assert.equal(seenRequests[0]!.payload.candidates[0]?.replyToOther, true);
  assert.equal(
    seenRequests[0]!.payload.memoryHints.chat[0]?.key,
    "group_active_style",
  );

  // 2) dryRun also loads real global + chat memoryHints for the target chatKey.
  await app.classifier.dryRun(app.settings, {
    chatKey: "group:300",
    triggerMode: "smart_observe",
    senderName: "部员",
    userId: "2002",
    mentionedBot: true,
    quotedBot: false,
    text: "@树莓娘 🐱",
    recentContext: [],
  });

  assert.equal(seenRequests.length, 2);
  assert.equal(
    seenRequests[1]!.payload.memoryHints.global?.[0]?.key,
    "bot_speaking_style",
  );
  assert.equal(
    seenRequests[1]!.payload.memoryHints.chat[0]?.key,
    "group_active_style",
  );
});

test("memory_update exposes knownGroups so DM instructions can save chat-scoped group memories and enforces memory vs Bunko boundary", async (t) => {
  let memorySystemPrompt = "";
  let memoryUserPayload: {
    chat?: { kind: string; title: string };
    knownGroups?: { targetRef: string; title: string }[];
  } = {};
  let dialogSystemPrompt = "";
  let memoryTurn = 0;

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
      tools?: { function: { name: string } }[];
    };

    res.setHeader("Content-Type", "application/json");
    const systemMsg = reqJson.messages[0]?.content ?? "";

    if (systemMsg.includes("静默记忆助手")) {
      memoryTurn++;
      memorySystemPrompt = systemMsg;
      if (memoryTurn === 1) {
        memoryUserPayload = JSON.parse(reqJson.messages[1]!.content!) as {
          chat?: { kind: string; title: string };
          knownGroups?: { targetRef: string; title: string }[];
        };
        const targetGroupRef = memoryUserPayload.knownGroups?.find(
          (g) => g.title === "网络开拓者协会2026",
        )?.targetRef;

        assert.ok(
          targetGroupRef,
          "knownGroups should include target group ref",
        );
        res.end(
          JSON.stringify({
            id: "mem-1",
            object: "chat.completion",
            created: 1,
            model: "gpt-test-main",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_mem_1",
                      type: "function",
                      function: {
                        name: "memory_manage",
                        arguments: JSON.stringify({
                          action: "upsert",
                          scope: "chat",
                          targetRef: targetGroupRef,
                          key: "group_active_style",
                          summary: "本群发言积极一点，多用 reaction 互动",
                          content: "在大群里发言积极一点，多用 reaction 回复",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 40,
              total_tokens: 140,
            },
          }),
        );

        return;
      }

      res.end(JSON.stringify(chatReply({ done: true })));

      return;
    }

    dialogSystemPrompt = systemMsg;
    res.end(
      JSON.stringify(
        chatReply({ units: [{ kind: "qq_reply", text: "收到" }] }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
      botQQ: "999999",
    },
    {
      policy: {
        adminQQs: ["2832265139"],
      },
    },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "1048169934",
    title: "网络开拓者协会2026",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.chats.upsert({
    kind: "private",
    chatId: "2832265139",
    title: "硅硅草",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const dmMsg = await captureText(app, {
    kind: "private",
    chatId: "2832265139",
    id: "m-dm-rule-1",
    userId: "2832265139",
    senderName: "硅硅草",
    text: "你在大群里可以多用 reaction 回复，记下来",
  });

  await app.agent.updateMemoryFromMessage(
    "private:2832265139",
    dmMsg.message.id,
  );

  assert.equal(memoryUserPayload.chat?.kind, "private");
  assert.match(memorySystemPrompt, /Bunko 知识库/);
  assert.match(memorySystemPrompt, /scope="chat"/);

  const savedGroupMem = await app.store.memories.get(
    "chat",
    "group:1048169934",
    "group_active_style",
  );

  assert.ok(
    savedGroupMem,
    "DM memory_update should be able to save chat-scoped memory onto target group",
  );
  assert.match(savedGroupMem.summary, /reaction/);

  // Main dialog prompt explicitly enforces 3-tier storage split and persisting memories before confirming.
  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "private:2832265139",
    kind: "private",
    chatId: "2832265139",
    triggerMessageIds: [dmMsg.message.id],
    senderId: "2832265139",
    senderName: "硅硅草",
  });

  assert.match(dialogSystemPrompt, /三层存储分工/);
  assert.match(dialogSystemPrompt, /记忆落库铁律/);
});

test("gate proactive cooldown passes recent botActivity and raises non-mention reply threshold", async (t) => {
  const capturedActivities: {
    windowMinutes?: number;
    proactiveReplies?: number;
    totalReplies?: number;
    softLimit?: number;
    cooldownActive?: boolean;
  }[] = [];

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const userPayload = JSON.parse(reqJson.messages[1]?.content ?? "{}") as {
      botActivity?: {
        windowMinutes: number;
        proactiveReplies: number;
        totalReplies: number;
        softLimit: number;
        cooldownActive: boolean;
      };
      candidates?: { messageId: number }[];
    };

    res.setHeader("Content-Type", "application/json");
    if (!userPayload.candidates) {
      res.end(JSON.stringify(chatReply({ units: [] })));

      return;
    }

    if (userPayload.botActivity) {
      capturedActivities.push(userPayload.botActivity);
    }

    res.end(
      JSON.stringify(
        chatReply({
          decisions: userPayload.candidates.map((c) => ({
            messageId: c.messageId,
            action: "reply",
            confidence: 0.78,
            reason: "氛围不错可以接话",
          })),
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      gateBaseUrl: `${llmStub.url}/v1`,
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {
      gateModel: {
        batchWindowMs: 100,
        minConfidence: 0.65,
        cooldownWindowMinutes: 10,
        proactiveSoftLimit: 2,
        cooldownMinConfidence: 0.88,
      },
      policy: { adminBypassGate: false },
    },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "6666",
    title: "吹水群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  // Seed 2 recent non-mention proactive replies in the 10-minute window.
  for (let i = 1; i <= 2; i += 1) {
    const prev = await captureText(app, {
      kind: "group",
      chatId: "6666",
      id: `prev-proactive-${i}`,
      userId: "2001",
      senderName: "群友甲",
      text: `闲聊 ${i}`,
    });

    await app.store.gate.record({
      chatKey: "group:6666",
      messageId: prev.message.id,
      action: "reply",
      stage: "l1_classifier",
      confidence: 0.8,
      reason: "主动接话",
      model: "gate-test",
      durationMs: 10,
    });
  }

  // Next batch has 1 non-mention chatter (0.78 < 0.88 -> throttled to ignore)
  // and 1 explicit @mention (0.78 >= 0.65 -> direct mention bypasses cooldown -> reply).
  const nonAt = await captureText(app, {
    kind: "group",
    chatId: "6666",
    id: "cool-nonat",
    userId: "2002",
    senderName: "群友乙",
    text: "哈哈确实",
  });
  const directAt = await captureText(app, {
    kind: "group",
    chatId: "6666",
    id: "cool-at",
    userId: "2003",
    senderName: "群友丙",
    text: "@树莓娘 帮我看看",
    mentionedBot: true,
  });

  await app.gate.ingest(nonAt.message);
  await app.gate.ingest(directAt.message);
  await delay(130);
  await app.worker.drainOnce();

  assert.equal(capturedActivities.length > 0, true);
  assert.equal(capturedActivities[0]?.proactiveReplies, 2);
  assert.equal(capturedActivities[0]?.cooldownActive, true);

  const decisions = await app.store.gate.listByMessageIds([
    nonAt.message.id,
    directAt.message.id,
  ]);

  assert.equal(decisions.get(nonAt.message.id)?.[0]?.action, "ignore");
  assert.match(decisions.get(nonAt.message.id)?.[0]?.reason ?? "", /冷却节流/);
  assert.equal(decisions.get(directAt.message.id)?.[0]?.action, "reply");
});
