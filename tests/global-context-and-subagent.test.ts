import assert from "node:assert/strict";
import test from "node:test";

import { parseModelJson } from "../src/agent/llm.ts";
import { ModelIds } from "../src/agent/model-ids.ts";
import {
  captureText,
  chatReply,
  chatToolCalls,
  createTestBerryApp,
  startStubServer,
  waitUntil,
} from "./helpers.ts";

test("global single context, isolated chat_analyst cross-group summary, privacy isolation, and admin-only #NEW#", async (t) => {
  const ref2048 = new ModelIds().groupRef("2048");
  const ref9999 = new ModelIds().userRef("9999");

  const dispatches: { action: string; body: Record<string, unknown> }[] = [];
  const mainHistories: { role: string; content: string | null }[][] = [];
  const subagentToolOutputs: string[] = [];

  const gwStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    const action = req.url?.split("/").pop() ?? "";
    const parsed = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    dispatches.push({ action, body: parsed });

    const data =
      action === "send_group_msg_async" || action === "send_private_msg_async"
        ? { message_id: `ob-gw-${dispatches.length}` }
        : [];

    res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
  }, t);

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
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

    // Isolated chat_analyst subagent dispatch.
    if (sys.includes("聊天记录检索及摘要子代理")) {
      const task =
        (
          JSON.parse(
            reqJson.messages.find((m) => m.role === "user")?.content ?? "{}",
          ) as { task?: string }
        ).task ?? "";

      if (task.includes("PRIVATE_LEAK_CHECK")) {
        if (toolMsgs.length === 0) {
          res.end(
            JSON.stringify(
              chatToolCalls([
                {
                  id: "call-priv-read",
                  name: "read_chat_window",
                  args: { targetRef: ref9999, limit: 10 },
                },
              ]),
            ),
          );

          return;
        }

        const errMsg = toolMsgs.at(-1)?.content ?? "";

        subagentToolOutputs.push(errMsg);
        res.end(
          JSON.stringify(
            chatReply({ brief: `已拒绝越权查询：${errMsg}`, references: [] }),
          ),
        );

        return;
      }

      if (toolMsgs.length === 0) {
        res.end(
          JSON.stringify(
            chatToolCalls([
              { id: "call-list-chats", name: "list_chats", args: {} },
            ]),
          ),
        );

        return;
      }

      if (toolMsgs.length === 1) {
        const listed = JSON.parse(toolMsgs[0]!.content ?? "{}") as {
          result?: { chats: { targetRef: string; title: string }[] };
        };
        const target = listed.result?.chats.find(
          (c) => c.title === "技术保障中心",
        );

        assert.ok(target, "chat_analyst should list 技术保障中心");
        res.end(
          JSON.stringify(
            chatToolCalls([
              {
                id: "call-read-2048",
                name: "read_chat_window",
                args: { targetRef: target.targetRef, limit: 20 },
              },
            ]),
          ),
        );

        return;
      }

      subagentToolOutputs.push(toolMsgs.at(-1)?.content ?? "");
      res.end(
        JSON.stringify(
          chatReply({
            brief:
              "技术保障中心近期讨论结论：全局单上下文维持统一连续人格，群聊总结通过子代理隔离避免污染主上下文。",
            references: ["技术保障中心"],
          }),
        ),
      );

      return;
    }

    // Main Agent dispatch.
    const latestMsg = reqJson.messages.at(-1);

    if (latestMsg?.role === "user") {
      mainHistories.push(reqJson.messages.slice(1, -1));
    }

    const latestTurnUser =
      reqJson.messages.findLast((m) => m.role === "user")?.content ?? "";
    const latestEnvelope = JSON.parse(
      latestTurnUser.split("\n\n").at(-1) ?? "{}",
    ) as { requestMessages?: { text: string }[] };
    const activeRequestText = (latestEnvelope.requestMessages ?? [])
      .map((m) => m.text)
      .join("\n");

    if (activeRequestText.includes("总结技术保障中心群中最近在聊什么")) {
      if (latestMsg?.role === "user") {
        res.end(
          JSON.stringify(
            chatToolCalls([
              {
                id: "call-main-1",
                name: "delegate_subagent",
                args: {
                  kind: "chat_analyst",
                  task: "查阅「技术保障中心」群近期讨论并整理简洁摘要",
                },
              },
            ]),
          ),
        );

        return;
      }

      const subResult = JSON.parse(latestMsg?.content ?? "{}") as {
        result?: { brief?: string };
      };

      res.end(
        JSON.stringify(
          chatReply({
            units: [
              {
                kind: "qq_reply",
                text: `为你总结：${subResult.result?.brief ?? ""}`,
              },
            ],
          }),
        ),
      );

      return;
    }

    if (activeRequestText.includes("看看9999私聊")) {
      if (latestMsg?.role === "user") {
        res.end(
          JSON.stringify(
            chatToolCalls([
              {
                id: "call-main-priv",
                name: "delegate_subagent",
                args: {
                  kind: "chat_analyst",
                  task: "PRIVATE_LEAK_CHECK: 尝试读取指定私聊记录",
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
            units: [
              {
                kind: "qq_reply",
                text: "抱歉，我无权查阅其他成员的私聊内容。",
              },
            ],
          }),
        ),
      );

      return;
    }

    if (activeRequestText.includes("TARGET_ROUTING_TEST")) {
      res.end(
        JSON.stringify(
          chatReply({
            units: [
              {
                kind: "qq_reply",
                text: "越权私信拦截测试",
                targetRef: ref9999,
              },
              {
                kind: "qq_reply",
                text: "转达给技术保障中心：今晚正常巡检。",
                targetRef: ref2048,
              },
            ],
          }),
        ),
      );

      return;
    }

    res.end(
      JSON.stringify(
        chatReply({
          units: [
            { kind: "qq_reply", text: "收到，已在全局上下文记住群聊约定。" },
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
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    {
      policy: {
        adminQQs: ["10001"],
        groupDefaultMode: "mention_only",
      },
    },
    t,
  );

  for (const chat of [
    { kind: "group" as const, chatId: "100", title: "主测试群" },
    { kind: "group" as const, chatId: "2048", title: "技术保障中心" },
    { kind: "private" as const, chatId: "20002", title: "普通同学" },
    { kind: "private" as const, chatId: "9999", title: "第三方私聊对象" },
  ]) {
    await app.store.chats.upsert({
      ...chat,
      enabled: true,
      triggerMode: "smart_observe",
    });
  }

  await captureText(app, {
    kind: "group",
    chatId: "2048",
    id: "ob-2048-1",
    userId: "30001",
    senderName: "郭逸龙",
    text: "全局单上下文不会人格分裂 _RAW_GROUP_CHAT_NOISE_1",
    sentAt: Date.now() - 20_000,
  });
  await captureText(app, {
    kind: "private",
    chatId: "9999",
    id: "ob-9999-1",
    userId: "9999",
    senderName: "第三人",
    text: "_SECRET_THIRD_PARTY_DM_",
    sentAt: Date.now() - 5000,
  });

  // 1) Turn 1 in group:100 via serial worker lane.
  const msgGroup = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-100-1",
    userId: "20002",
    senderName: "普通同学",
    text: "我们在主测试群约定周日晚上巡检。",
    mentionedBot: true,
  });

  await app.store.jobs.enqueue("invoke", "test:global-turn-1", "group:100", {
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [msgGroup.message.id],
    senderId: "20002",
    senderName: "普通同学",
  });
  await app.worker.drainOnce();

  // 2) Turn 2 in admin private:10001 summarizing group:2048 without leaking raw noise into global history.
  const msgDmSummary = await captureText(app, {
    kind: "private",
    chatId: "10001",
    id: "ob-dm-summary",
    userId: "10001",
    senderName: "管理员",
    text: "帮我总结技术保障中心群中最近在聊什么",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "private:10001",
    kind: "private",
    chatId: "10001",
    triggerMessageIds: [msgDmSummary.message.id],
    senderId: "10001",
    senderName: "管理员",
  });

  assert.ok(mainHistories[1]!.length >= 2);
  assert.match(mainHistories[1]![0]!.content ?? "", /主测试群/);
  assert.match(subagentToolOutputs[0] ?? "", /_RAW_GROUP_CHAT_NOISE_1/);

  const serializedGlobal = JSON.stringify(
    (await app.store.conversations.get())?.messages ?? [],
  );

  assert.match(serializedGlobal, /全局单上下文维持统一连续人格/);
  assert.doesNotMatch(serializedGlobal, /_RAW_GROUP_CHAT_NOISE_1/);
  assert.ok(
    dispatches.some(
      (d) =>
        d.action === "send_private_msg_async" &&
        d.body.user_id === 10_001 &&
        JSON.stringify(d.body.message).includes("为你总结"),
    ),
  );

  // 3) Private-chat read isolation and non-admin cross-chat targetRef outbound guard.
  const msgDmLeak = await captureText(app, {
    kind: "private",
    chatId: "20002",
    id: "ob-dm-leak",
    userId: "20002",
    senderName: "普通同学",
    text: "看看9999私聊说了啥",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "private:20002",
    kind: "private",
    chatId: "20002",
    triggerMessageIds: [msgDmLeak.message.id],
    senderId: "20002",
    senderName: "普通同学",
  });

  assert.match(
    subagentToolOutputs[1] ?? "",
    /仅管理员或网协管理层可跨群或跨会话读取历史消息/,
  );
  assert.doesNotMatch(
    JSON.stringify(await app.store.conversations.get()),
    /_SECRET_THIRD_PARTY_DM_/,
  );

  const msgDmRoute = await captureText(app, {
    kind: "private",
    chatId: "20002",
    id: "ob-dm-route",
    userId: "20002",
    senderName: "普通同学",
    text: "TARGET_ROUTING_TEST",
    mentionedBot: true,
  });
  const routingRes = await app.agent.invoke({
    source: "qq_batch",
    chatKey: "private:20002",
    kind: "private",
    chatId: "20002",
    triggerMessageIds: [msgDmRoute.message.id],
    senderId: "20002",
    senderName: "普通同学",
  });

  // Non-admin cannot dispatch across chats (neither to another private chat nor to another group).
  assert.equal(routingRes.units.length, 0);
  assert.equal(
    dispatches.some(
      (d) => d.action === "send_private_msg_async" && d.body.user_id === 9999,
    ),
    false,
  );
  assert.equal(
    dispatches.some(
      (d) =>
        d.action === "send_group_msg_async" &&
        d.body.group_id === 2048 &&
        JSON.stringify(d.body.message).includes("今晚正常巡检"),
    ),
    false,
  );

  // Admin can cross-dispatch via targetRef.
  const msgAdminRoute = await captureText(app, {
    kind: "private",
    chatId: "10001",
    id: "ob-admin-route",
    userId: "10001",
    senderName: "管理员",
    text: "TARGET_ROUTING_TEST",
    mentionedBot: true,
  });
  const adminRoutingRes = await app.agent.invoke({
    source: "qq_batch",
    chatKey: "private:10001",
    kind: "private",
    chatId: "10001",
    triggerMessageIds: [msgAdminRoute.message.id],
    senderId: "10001",
    senderName: "管理员",
  });

  assert.equal(adminRoutingRes.units.length, 2);
  assert.equal(
    dispatches.some(
      (d) =>
        d.action === "send_group_msg_async" &&
        d.body.group_id === 2048 &&
        JSON.stringify(d.body.message).includes("今晚正常巡检"),
    ),
    true,
  );

  // 4) Non-admin #NEW# is rejected; admin #NEW# resets global context and sets afterMessageId.
  const beforeReset = await app.store.conversations.get();

  assert.ok(beforeReset && beforeReset.messages.length > 0);
  await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "private",
    user_id: 20_002,
    message_id: "ob-nonadmin-new",
    time: Math.floor(Date.now() / 1000),
    message: "#NEW#",
    sender: { nickname: "普通同学" },
  });
  assert.equal(
    (await app.store.conversations.get())?.sessionId,
    beforeReset.sessionId,
  );

  await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "private",
    user_id: 10_001,
    message_id: "ob-admin-new",
    time: Math.floor(Date.now() / 1000),
    message: "#NEW#",
    sender: { nickname: "管理员" },
  });
  const afterAdminNew = await app.store.conversations.get();
  const adminNewMsg = await app.store.messages.findByOnebotId(
    "private:10001",
    "ob-admin-new",
  );

  assert.notEqual(afterAdminNew?.sessionId, beforeReset.sessionId);
  assert.equal(afterAdminNew?.messages.length, 0);
  assert.equal(afterAdminNew?.afterMessageId, adminNewMsg?.id);

  const globalMem = await app.store.memories.upsert({
    scope: "global",
    ownerId: "ignored-arbitrary-owner",
    key: "persona_core",
    summary: "全平台单一连续身份",
    content: "无论群聊还是私聊都使用同一套全球长期约定。",
  });

  assert.equal(globalMem.ownerId, "global");
});

test("JobWorker executes same-chat and cross-chat invokes concurrently while preserving coalescing and atomic Tape turns", async (t) => {
  const gwStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const action = req.url?.split("/").pop() ?? "";

    res.end(
      JSON.stringify({
        status: "ok",
        data: action.includes("history") ? { messages: [] } : { message_id: 1 },
      }),
    );
  }, t);

  let releaseGroup100First!: () => void;
  const group100FirstGate = new Promise<void>((resolve) => {
    releaseGroup100First = resolve;
  });

  let activeCalls = 0;
  let maxConcurrentCalls = 0;
  let group100Running = 0;
  let maxGroup100Concurrent = 0;
  const group100TurnTexts: string[][] = [];
  let sawGroup100SecondDuringFirst = false;
  let sawGroup200DuringGroup100 = false;

  const llmStub = await startStubServer(async (_req, res, bodyText) => {
    const body = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const lastUser = body.messages.at(-1)?.content ?? "";
    const parsed = JSON.parse(lastUser) as {
      chat: { title: string };
      requestMessages: { text: string }[];
    };
    const isGroup100 = parsed.chat.title === "群A";
    const texts = parsed.requestMessages.map((m) => m.text);

    activeCalls++;
    maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);

    if (isGroup100) {
      group100Running++;
      maxGroup100Concurrent = Math.max(maxGroup100Concurrent, group100Running);
      group100TurnTexts.push(texts);
      if (texts.includes("群A连发1") && group100Running >= 2) {
        sawGroup100SecondDuringFirst = true;
      }
    } else if (group100Running > 0) {
      sawGroup200DuringGroup100 = true;
    }

    if (sawGroup100SecondDuringFirst && sawGroup200DuringGroup100) {
      releaseGroup100First();
    }

    try {
      if (isGroup100 && texts.includes("群A第一条")) {
        await group100FirstGate;
      }

      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          chatReply(
            JSON.stringify({
              units: [
                {
                  kind: "qq_reply",
                  text: `回复 ${parsed.chat.title}: ${texts.join(" + ")}`,
                },
              ],
            }),
          ),
        ),
      );
    } finally {
      activeCalls--;
      if (isGroup100) {
        group100Running--;
      }
    }
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
    },
    { policy: { adminQQs: ["10001"] } },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "100",
    title: "群A",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "200",
    title: "群B",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const mA1 = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-a-1",
    userId: "10001",
    senderName: "管理员",
    text: "群A第一条",
  });
  const mA2 = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-a-2",
    userId: "10001",
    senderName: "管理员",
    text: "群A连发1",
  });
  const mA3 = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-a-3",
    userId: "10001",
    senderName: "管理员",
    text: "群A连发2",
  });
  const mB1 = await captureText(app, {
    kind: "group",
    chatId: "200",
    id: "ob-b-1",
    userId: "10001",
    senderName: "管理员",
    text: "群B同时发言",
  });

  // Start group:100's slow first turn.
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [mA1.message.id],
    senderId: "10001",
    senderName: "管理员",
  });
  app.worker.start();

  await waitUntil(() => group100Running === 1, 3000);

  // While group:100's slow turn is still running, coalesce two rapid follow-up bursts
  // for group:100 and enqueue group:200 — BOTH must execute concurrently with turn 1.
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [mA2.message.id],
    senderId: "10001",
    senderName: "管理员",
  });
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [mA3.message.id],
    senderId: "10001",
    senderName: "管理员",
  });
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:200",
    kind: "group",
    chatId: "200",
    triggerMessageIds: [mB1.message.id],
    senderId: "10001",
    senderName: "管理员",
  });
  app.worker.wake();

  await waitUntil(async () => {
    const jobs = await app.store.jobs.list({ kind: "invoke" });

    return jobs.length === 3 && jobs.every((j) => j.state === "done");
  }, 5000);
  await app.worker.stop();

  assert.equal(sawGroup100SecondDuringFirst, true);
  assert.equal(sawGroup200DuringGroup100, true);
  assert.ok(maxConcurrentCalls >= 2);
  assert.ok(maxGroup100Concurrent >= 2);
  assert.deepEqual(group100TurnTexts, [
    ["群A第一条"],
    ["群A连发1", "群A连发2"],
  ]);

  const globalConv = await app.store.conversations.get();
  const serialized = JSON.stringify(globalConv?.messages ?? []);

  assert.match(serialized, /回复 群A: 群A第一条/);
  assert.match(serialized, /回复 群B: 群B同时发言/);
  assert.match(serialized, /回复 群A: 群A连发1 \+ 群A连发2/);
});

test("model input truncates oversized messages to 3000 chars while preserving raw SQLite text, and parseModelJson handles leading prose", async (t) => {
  assert.deepEqual(
    parseModelJson(
      '代码写好了，直接发你。\n\n{"units":[{"kind":"qq_reply","text":"ok"}]}',
    ),
    { units: [{ kind: "qq_reply", text: "ok" }] },
  );

  let seenRequestText = "";
  const llmStub = await startStubServer((_req, res, bodyText) => {
    const body = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const payload = JSON.parse(body.messages.at(-1)!.content!) as {
      requestMessages: { text: string }[];
    };

    seenRequestText = payload.requestMessages[0]?.text ?? "";
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        chatReply(
          '收到啦\n\n{"units":[{"kind":"qq_reply","text":"太长不看"}]}',
        ),
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
    chatId: "301",
    title: "长文测试群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const hugeText = "甲".repeat(3500);
  const captured = await captureText(app, {
    kind: "group",
    chatId: "301",
    id: "ob-huge-1",
    userId: "2001",
    senderName: "测试同学",
    text: hugeText,
  });

  const stored = await app.store.messages.get(captured.message.id);

  assert.equal(stored?.text.length, 3500);

  const result = await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:301",
    kind: "group",
    chatId: "301",
    triggerMessageIds: [captured.message.id],
    senderId: "2001",
    senderName: "测试同学",
  });

  assert.ok(seenRequestText.length < 3100);
  assert.match(seenRequestText, /原长 3500 字，已截断前 3000 字/);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0]?.kind, "qq_reply");
});

test("delegate_subagent(background=true) runs asynchronously and delivers follow-up via subagent_result", async (t) => {
  const sentTexts: string[] = [];

  const gwStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    const action = req.url?.split("/").pop() ?? "";
    const parsed = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    if (action === "send_group_msg_async") {
      sentTexts.push(JSON.stringify(parsed.message));
    }

    res.end(
      JSON.stringify({
        status: "ok",
        data: action.includes("history") ? { messages: [] } : { message_id: 1 },
      }),
    );
  }, t);

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const body = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const sys = body.messages[0]?.content ?? "";
    const last = body.messages.at(-1);

    res.setHeader("Content-Type", "application/json");

    // Background chat_analyst subagent turn
    if (sys.includes("聊天记录检索及摘要子代理")) {
      res.end(
        JSON.stringify(
          chatReply(
            JSON.stringify({
              brief: "过去一周群里主要讨论了机房巡检排班和 UPS 告警。",
              references: [],
            }),
          ),
        ),
      );

      return;
    }

    // Main dialog receiving queued acknowledgement from delegate_subagent(background=true)
    if (last?.role === "tool") {
      assert.match(last.content ?? "", /"background":true/);
      res.end(
        JSON.stringify(
          chatReply(
            JSON.stringify({
              units: [
                { kind: "qq_reply", text: "好嘞我去翻下记录，查完发你～" },
              ],
            }),
          ),
        ),
      );

      return;
    }

    // Follow-up main dialog turn triggered by subagent_result
    if ((last?.content ?? "").includes('"source":"subagent_result"')) {
      assert.match(last?.content ?? "", /机房巡检排班/);
      res.end(
        JSON.stringify(
          chatReply(
            JSON.stringify({
              units: [
                {
                  kind: "qq_reply",
                  text: "查完了：过去一周群里主要讨论了机房巡检排班和 UPS 告警。",
                },
              ],
            }),
          ),
        ),
      );

      return;
    }

    // Initial main dialog turn dispatches background subagent
    res.end(
      JSON.stringify(
        chatToolCalls([
          {
            id: "call_bg_1",
            name: "delegate_subagent",
            args: {
              kind: "chat_analyst",
              task: "总结过去一周群里讨论的重点",
              background: true,
            },
          },
        ]),
      ),
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
    { policy: { adminQQs: ["10001"] } },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "100",
    title: "技术保障中心",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const msg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-bg-1",
    userId: "10001",
    senderName: "管理员",
    text: "帮我总结过去一周大家聊了啥",
    mentionedBot: true,
  });

  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [msg.message.id],
    senderId: "10001",
    senderName: "管理员",
  });

  app.worker.start();
  await waitUntil(() => sentTexts.length >= 2, 5000);
  await app.worker.stop();

  assert.match(sentTexts[0] ?? "", /我去翻下记录/);
  assert.match(sentTexts[1] ?? "", /机房巡检排班/);

  const subagentJobs = await app.store.jobs.list({ kind: "subagent_task" });

  assert.equal(subagentJobs.length, 1);
  assert.equal(subagentJobs[0]?.state, "done");
});

test("same-role alternating speakers coalesce with per-speaker metadata and 2-hop replyToQuoteRef while distinct roles stay isolated", async (t) => {
  const seenEnvelopes: {
    speaker: { displayName: string; role: string } | null;
    speakers?: { displayName: string; role: string }[];
    requestMessages: {
      senderName: string;
      role?: string;
      text: string;
      replyToQuoteRef?: string;
    }[];
    quotedMessages?: {
      quoteRef: string;
      text: string;
      replyToQuoteRef?: string;
    }[];
  }[] = [];

  const gwStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const action = req.url?.split("/").pop() ?? "";

    res.end(
      JSON.stringify({
        status: "ok",
        data: action.includes("history") ? { messages: [] } : { message_id: 1 },
      }),
    );
  }, t);

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const body = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const lastUser = body.messages.at(-1)?.content ?? "";
    const jsonStart = lastUser.indexOf("{");
    const parsed = JSON.parse(
      jsonStart === -1 ? lastUser : lastUser.slice(jsonStart),
    ) as (typeof seenEnvelopes)[number];

    seenEnvelopes.push(parsed);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        chatReply(
          JSON.stringify({
            units: [{ kind: "qq_reply", text: "收到" }],
          }),
        ),
      ),
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
    { policy: { adminQQs: ["10001", "10002"] } },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "100",
    title: "技术保障中心",
    enabled: true,
    triggerMode: "smart_observe",
  });

  // Original image -> Berry's reply -> IDA* quoting Berry's reply;
  // plus Siunaus. (also admin) and 路人 (guest) speaking in the same burst.
  const imgOriginal = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-img-orig",
    userId: "20001",
    senderName: "硅硅草",
    text: "[图片: ？！区区！？]",
  });
  const botReply = await app.store.messages.capture({
    kind: "group",
    chatId: "100",
    onebotMessageId: "ob-bot-desc",
    userId: "3173748223",
    senderName: "树莓娘",
    text: "配字「？！囧囧！？」",
    segments: [],
    replyToMessageId: imgOriginal.message.onebotMessageId,
    isBot: true,
    mentionedBot: false,
    sentAt: Date.now(),
  });
  const siunausImg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-siunaus-img",
    userId: "10002",
    senderName: "Siunaus.",
    text: "[图片: 回应了你的消息]",
  });
  const idaReply = await app.store.messages.capture({
    kind: "group",
    chatId: "100",
    onebotMessageId: "ob-ida-quote",
    userId: "10001",
    senderName: "IDA*",
    text: "@树莓娘 上面不是写的区吗",
    segments: [],
    replyToMessageId: botReply.message.onebotMessageId,
    isBot: false,
    mentionedBot: true,
    sentAt: Date.now(),
  });
  const guestMsg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-guest-1",
    userId: "30009",
    senderName: "路人甲",
    text: "@树莓娘 你好呀",
    mentionedBot: true,
  });

  // Two distinct admins coalesce into ONE pending invoke job; guest stays isolated in a second job.
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [siunausImg.message.id],
    accessRole: "admin",
    senderId: "10002",
    senderName: "Siunaus.",
  });
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [idaReply.message.id],
    accessRole: "admin",
    senderId: "10001",
    senderName: "IDA*",
  });
  await app.store.jobs.coalesceInvoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [guestMsg.message.id],
    accessRole: "guest",
    senderId: "30009",
    senderName: "路人甲",
  });

  const pendingJobs = await app.store.jobs.list({
    kind: "invoke",
    state: "pending",
  });

  assert.equal(pendingJobs.length, 2);

  await app.worker.drainOnce();

  assert.equal(seenEnvelopes.length, 2);

  const adminBatch = seenEnvelopes[0]!;

  assert.equal(adminBatch.speaker, null);
  assert.deepEqual(
    adminBatch.speakers?.map((s) => [s.displayName, s.role]),
    [
      ["Siunaus.", "admin"],
      ["IDA*", "admin"],
    ],
  );
  assert.equal(adminBatch.requestMessages.length, 2);
  assert.equal(adminBatch.requestMessages[0]?.senderName, "Siunaus.");
  assert.equal(adminBatch.requestMessages[1]?.senderName, "IDA*");

  const idaMsg = adminBatch.requestMessages[1];
  const quotedBot = adminBatch.quotedMessages?.find((m) =>
    m.text.includes("囧囧"),
  );
  const quotedOrig = adminBatch.quotedMessages?.find((m) =>
    m.text.includes("区区"),
  );

  assert.ok(quotedBot);
  assert.ok(quotedOrig);
  assert.equal(idaMsg.replyToQuoteRef, quotedBot.quoteRef);
  assert.equal(quotedBot.replyToQuoteRef, quotedOrig.quoteRef);

  const guestTurn = seenEnvelopes[1]!;

  assert.equal(guestTurn.speaker?.displayName, "路人甲");
  assert.equal(guestTurn.speaker?.role, "guest");
  assert.equal(guestTurn.speakers, undefined);
});
