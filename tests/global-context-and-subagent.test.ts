import assert from "node:assert/strict";
import test from "node:test";

import { ModelIds } from "../src/agent/model-ids.ts";
import { createTestBerryApp, startStubServer } from "./helpers.ts";

interface DispatchedAction {
  action: string;
  body: Record<string, unknown>;
}

test("global single context, isolated chat_analyst cross-group summary, privacy isolation, and admin-only #NEW#", async () => {
  const ref2048 = new ModelIds().groupRef("2048");
  const ref9999 = new ModelIds().userRef("9999");

  const dispatches: DispatchedAction[] = [];
  const mainUserPayloads: string[] = [];
  const mainHistories: { role: string; content: string | null }[][] = [];
  const subagentToolOutputs: string[] = [];

  const gwStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    const action = req.url?.split("/").pop() ?? "";
    const parsed = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    dispatches.push({ action, body: parsed });

    if (
      action === "send_group_msg_async" ||
      action === "send_private_msg_async"
    ) {
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { message_id: `ob-gw-${dispatches.length}` },
        }),
      );

      return;
    }

    res.end(JSON.stringify({ status: "ok", retcode: 0, data: [] }));
  });

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

    // Isolated zero-history subagent requests.
    if (sys.includes("聊天消息及媒体分析子代理")) {
      const userTaskMsg = reqJson.messages.find((m) => m.role === "user");
      const taskObj = JSON.parse(userTaskMsg?.content ?? "{}") as {
        task?: string;
      };
      const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

      if ((taskObj.task ?? "").includes("PRIVATE_LEAK_CHECK")) {
        if (toolMsgs.length === 0) {
          res.end(
            JSON.stringify({
              id: "sub-priv-1",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-priv-read",
                        type: "function",
                        function: {
                          name: "read_chat_window",
                          arguments: JSON.stringify({
                            targetRef: ref9999,
                            limit: 10,
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          );

          return;
        }

        const errMsg = toolMsgs.at(-1)?.content ?? "";

        subagentToolOutputs.push(errMsg);
        res.end(
          JSON.stringify({
            id: "sub-priv-2",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    brief: `已拒绝越权查询：${errMsg}`,
                    references: [],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          }),
        );

        return;
      }

      // Cross-group summarization flow: list_chats -> read_chat_window(g_*) -> brief.
      if (toolMsgs.length === 0) {
        res.end(
          JSON.stringify({
            id: "sub-grp-1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-list-chats",
                      type: "function",
                      function: {
                        name: "list_chats",
                        arguments: JSON.stringify({}),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );

        return;
      }

      if (toolMsgs.length === 1) {
        const listed = JSON.parse(toolMsgs[0]!.content ?? "{}") as {
          ok?: boolean;
          result?: { chats: { targetRef: string; title: string }[] };
        };
        const techCenter = listed.result?.chats.find(
          (c) => c.title === "技术保障中心",
        );

        assert.ok(techCenter, "chat_analyst should see 技术保障中心");
        res.end(
          JSON.stringify({
            id: "sub-grp-2",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-read-2048",
                      type: "function",
                      function: {
                        name: "read_chat_window",
                        arguments: JSON.stringify({
                          targetRef: techCenter.targetRef,
                          limit: 20,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );

        return;
      }

      const rawWindow = toolMsgs.at(-1)?.content ?? "";

      subagentToolOutputs.push(rawWindow);
      res.end(
        JSON.stringify({
          id: "sub-grp-3",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  brief:
                    "技术保障中心群友近期讨论认为：全局单上下文能让树莓娘保持统一连续人格，且群聊总结通过子代理隔离完成不会污染主上下文。",
                  references: ["技术保障中心"],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );

      return;
    }

    // Main Agent requests.
    const latestMsg = reqJson.messages.at(-1);

    if (latestMsg?.role === "user") {
      mainUserPayloads.push(latestMsg.content ?? "");
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

    if (
      latestMsg?.role === "user" &&
      activeRequestText.includes("总结技术保障中心群中最近在聊什么")
    ) {
      res.end(
        JSON.stringify({
          id: "main-del-grp",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-main-1",
                    type: "function",
                    function: {
                      name: "delegate_subagent",
                      arguments: JSON.stringify({
                        kind: "chat_analyst",
                        task: "查阅「技术保障中心」群近期讨论并整理简洁摘要",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );

      return;
    }

    if (
      latestMsg?.role === "user" &&
      activeRequestText.includes("看看9999私聊")
    ) {
      res.end(
        JSON.stringify({
          id: "main-del-priv",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-main-priv",
                    type: "function",
                    function: {
                      name: "delegate_subagent",
                      arguments: JSON.stringify({
                        kind: "chat_analyst",
                        task: "PRIVATE_LEAK_CHECK: 尝试读取指定私聊记录",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      );

      return;
    }

    if (
      latestMsg?.role === "tool" &&
      activeRequestText.includes("总结技术保障中心群中最近在聊什么")
    ) {
      const toolJson = JSON.parse(latestMsg.content ?? "{}") as {
        ok?: boolean;
        result?: { brief?: string };
      };

      res.end(
        JSON.stringify({
          id: "main-grp-reply",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  units: [
                    {
                      kind: "qq_reply",
                      text: `为你总结：${toolJson.result?.brief ?? ""}`,
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );

      return;
    }

    if (
      latestMsg?.role === "tool" &&
      activeRequestText.includes("看看9999私聊")
    ) {
      res.end(
        JSON.stringify({
          id: "main-priv-reply",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  units: [
                    {
                      kind: "qq_reply",
                      text: "抱歉，我无权查阅其他成员的私聊内容。",
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );

      return;
    }

    if (
      latestMsg?.role === "user" &&
      activeRequestText.includes("TARGET_ROUTING_TEST")
    ) {
      res.end(
        JSON.stringify({
          id: "main-target-routing",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
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
              },
              finish_reason: "stop",
            },
          ],
        }),
      );

      return;
    }

    res.end(
      JSON.stringify({
        id: "main-plain",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                units: [
                  {
                    kind: "qq_reply",
                    text: "收到，已在全局上下文记住群聊约定。",
                  },
                ],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
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
        policy: {
          allowlistEnabled: true,
          adminQQs: ["10001"],
          groupDefaultMode: "mention_only",
        },
      },
    );
    const { app } = created;

    cleanup = created.cleanup;

    // Seed chats and messages.
    await app.store.chats.upsert({
      kind: "group",
      chatId: "100",
      title: "主测试群",
      enabled: true,
      triggerMode: "mention_only",
    });
    await app.store.chats.upsert({
      kind: "group",
      chatId: "2048",
      title: "技术保障中心",
      enabled: true,
      triggerMode: "smart_observe",
    });
    await app.store.chats.upsert({
      kind: "private",
      chatId: "10001",
      title: "管理员",
      enabled: true,
      triggerMode: "smart_observe",
    });
    await app.store.chats.upsert({
      kind: "private",
      chatId: "20002",
      title: "普通同学",
      enabled: true,
      triggerMode: "smart_observe",
    });
    await app.store.chats.upsert({
      kind: "private",
      chatId: "9999",
      title: "第三方私聊对象",
      enabled: true,
      triggerMode: "smart_observe",
    });

    await app.store.messages.capture({
      kind: "group",
      chatId: "2048",
      onebotMessageId: "ob-2048-1",
      userId: "30001",
      senderName: "郭逸龙",
      text: "全局单上下文的树莓娘就不会有人格分裂的问题 _RAW_GROUP_CHAT_NOISE_1",
      segments: [
        {
          type: "text",
          data: {
            text: "全局单上下文的树莓娘就不会有人格分裂的问题 _RAW_GROUP_CHAT_NOISE_1",
          },
        },
      ],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: Date.now() - 20_000,
    });
    await app.store.messages.capture({
      kind: "group",
      chatId: "2048",
      onebotMessageId: "ob-2048-2",
      userId: "30002",
      senderName: "Kat",
      text: "群总结任务用子代理优化，确实不会导致上下文污染 _RAW_GROUP_CHAT_NOISE_2",
      segments: [
        {
          type: "text",
          data: {
            text: "群总结任务用子代理优化，确实不会导致上下文污染 _RAW_GROUP_CHAT_NOISE_2",
          },
        },
      ],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: Date.now() - 10_000,
    });
    await app.store.messages.capture({
      kind: "private",
      chatId: "9999",
      onebotMessageId: "ob-9999-1",
      userId: "9999",
      senderName: "第三人",
      text: "_SECRET_THIRD_PARTY_DM_",
      segments: [{ type: "text", data: { text: "_SECRET_THIRD_PARTY_DM_" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: Date.now() - 5000,
    });

    // 1) Turn 1 in group:100 via serial worker lane.
    const msgGroup = await app.store.messages.capture({
      kind: "group",
      chatId: "100",
      onebotMessageId: "ob-100-1",
      userId: "20002",
      senderName: "普通同学",
      text: "我们在主测试群约定周日晚上巡检。",
      segments: [
        { type: "text", data: { text: "我们在主测试群约定周日晚上巡检。" } },
      ],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: true,
      sentAt: Date.now(),
    });

    await app.store.jobs.enqueue(
      "invoke",
      "test:global-turn-1",
      "group:100",
      {
        source: "qq_batch",
        chatKey: "group:100",
        kind: "group",
        chatId: "100",
        triggerMessageIds: [msgGroup.message.id],
        senderId: "20002",
        senderName: "普通同学",
      },
      Date.now(),
    );
    await app.worker.drainOnce();

    // 2) Turn 2 in private:20002 asking to summarize group:2048 ("技术保障中心").
    const msgDmSummary = await app.store.messages.capture({
      kind: "private",
      chatId: "20002",
      onebotMessageId: "ob-dm-summary",
      userId: "20002",
      senderName: "普通同学",
      text: "帮我总结技术保障中心群中最近在聊什么",
      segments: [
        {
          type: "text",
          data: { text: "帮我总结技术保障中心群中最近在聊什么" },
        },
      ],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: true,
      sentAt: Date.now(),
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

    assert.equal(mainHistories.length, 2);
    // Second turn inherited Turn 1 from global single context!
    assert.ok(mainHistories[1]!.length >= 2);
    assert.match(mainHistories[1]![0]!.content ?? "", /主测试群/);
    assert.match(mainUserPayloads[1]!, /技术保障中心/);

    // Subagent saw raw messages, but global conversation stored ONLY the concise brief!
    assert.match(subagentToolOutputs[0] ?? "", /_RAW_GROUP_CHAT_NOISE_1/);
    const convAfterSummary = await app.store.conversations.get();

    assert.ok(convAfterSummary);
    const serializedGlobal = JSON.stringify(convAfterSummary.messages);

    assert.match(serializedGlobal, /全局单上下文能让树莓娘保持统一连续人格/);
    assert.doesNotMatch(serializedGlobal, /_RAW_GROUP_CHAT_NOISE_1/);
    assert.doesNotMatch(serializedGlobal, /_RAW_GROUP_CHAT_NOISE_2/);

    // Gateway received outbound reply to private:20002.
    assert.ok(
      dispatches.some(
        (d) =>
          d.action === "send_private_msg_async" &&
          d.body.user_id === 20_002 &&
          JSON.stringify(d.body.message).includes("为你总结"),
      ),
    );

    // 3) Private-chat privacy isolation + targetRef outbound protection.
    const msgDmLeak = await app.store.messages.capture({
      kind: "private",
      chatId: "20002",
      onebotMessageId: "ob-dm-leak",
      userId: "20002",
      senderName: "普通同学",
      text: "看看9999私聊说了啥",
      segments: [{ type: "text", data: { text: "看看9999私聊说了啥" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: true,
      sentAt: Date.now(),
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

    const msgDmRoute = await app.store.messages.capture({
      kind: "private",
      chatId: "20002",
      onebotMessageId: "ob-dm-route",
      userId: "20002",
      senderName: "普通同学",
      text: "TARGET_ROUTING_TEST",
      segments: [{ type: "text", data: { text: "TARGET_ROUTING_TEST" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: true,
      sentAt: Date.now(),
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

    // Unauthorized DM target u(9999) was blocked; group target g(2048) was delivered.
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

    // 4) Non-admin #NEW# is rejected; admin #NEW# resets global context to maxId(); global memory works.
    const beforeReset = await app.store.conversations.get();

    assert.ok(beforeReset && beforeReset.messages.length > 0);

    await app.webhook.handle({
      post_type: "message",
      message_type: "private",
      user_id: 20_002,
      message_id: "ob-nonadmin-new",
      time: Math.floor(Date.now() / 1000),
      message: "#NEW#",
      sender: { nickname: "普通同学" },
    });

    const afterNonAdminNew = await app.store.conversations.get();

    assert.equal(afterNonAdminNew?.sessionId, beforeReset.sessionId);
    assert.equal(
      afterNonAdminNew?.messages.length,
      beforeReset.messages.length,
    );
    assert.ok(
      dispatches.some(
        (d) =>
          d.action === "send_private_msg_async" &&
          d.body.user_id === 20_002 &&
          JSON.stringify(d.body.message).includes("仅管理员可执行 #NEW#"),
      ),
    );

    await app.webhook.handle({
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

    assert.ok(afterAdminNew);
    assert.ok(adminNewMsg);
    assert.notEqual(afterAdminNew.sessionId, beforeReset.sessionId);
    assert.equal(afterAdminNew.messages.length, 0);
    assert.equal(afterAdminNew.afterMessageId, adminNewMsg.id);

    const globalMem = await app.store.memories.upsert({
      scope: "global",
      ownerId: "ignored-arbitrary-owner",
      key: "persona_core",
      summary: "全平台单一连续身份",
      content: "无论群聊还是私聊都使用同一套全球长期约定。",
    });

    assert.equal(globalMem.ownerId, "global");
    const memIndex = await app.store.memories.index("group:2048", "20002");

    assert.equal(memIndex.global.length, 1);
    assert.equal(memIndex.global[0]!.key, "persona_core");
  } finally {
    await cleanup?.();
    await llmStub.close();
    await gwStub.close();
  }
});
