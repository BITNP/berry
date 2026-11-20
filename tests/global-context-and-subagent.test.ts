import assert from "node:assert/strict";
import test from "node:test";

import { ModelIds } from "../src/agent/model-ids.ts";
import {
  captureText,
  chatReply,
  chatToolCalls,
  createTestBerryApp,
  startStubServer,
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

  // 2) Turn 2 in private:20002 summarizing group:2048 without leaking raw noise into global history.
  const msgDmSummary = await captureText(app, {
    kind: "private",
    chatId: "20002",
    id: "ob-dm-summary",
    userId: "20002",
    senderName: "普通同学",
    text: "帮我总结技术保障中心群中最近在聊什么",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "private:20002",
    kind: "private",
    chatId: "20002",
    triggerMessageIds: [msgDmSummary.message.id],
    senderId: "20002",
    senderName: "普通同学",
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
        d.body.user_id === 20_002 &&
        JSON.stringify(d.body.message).includes("为你总结"),
    ),
  );

  // 3) Private-chat read isolation and cross-private targetRef outbound guard.
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

  assert.match(subagentToolOutputs[1] ?? "", /无权读取其他用户的私聊消息/);
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

  assert.equal(routingRes.units.length, 1);
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
