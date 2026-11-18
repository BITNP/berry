import assert from "node:assert/strict";
import test from "node:test";

import { createTestBerryApp, startStubServer } from "./helpers.ts";

test("Keycloak QQ lookup, unbound rejection, and natural-language guild_create_node via internal API", async () => {
  const guildRequests: {
    method: string;
    path: string;
    auth: string | undefined;
    actor: string | undefined;
    body: unknown;
  }[] = [];

  const kcStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/realms/bitnp/protocol/openid-connect/token") {
      res.end(JSON.stringify({ access_token: "kc-tok", expires_in: 300 }));

      return;
    }

    if (url.pathname === "/admin/realms/bitnp/users") {
      const q = url.searchParams.get("q") ?? "";
      const search = url.searchParams.get("search") ?? "";

      if (q === "qq_number:11111") {
        res.end(
          JSON.stringify([
            {
              id: "sub-wrz",
              username: "wrz",
              firstName: "润哲",
              lastName: "王",
              enabled: true,
              attributes: { qq_number: ["11111"] },
            },
          ]),
        );

        return;
      }

      if (search.includes("硅草")) {
        res.end(
          JSON.stringify([
            {
              id: "sub-guicao",
              username: "guicao",
              firstName: "硅草",
              enabled: true,
              attributes: { qq_number: ["22222"] },
            },
          ]),
        );

        return;
      }

      res.end(JSON.stringify([]));

      return;
    }

    if (
      url.pathname ===
      "/admin/realms/bitnp/users/sub-wrz/role-mappings/realm/composite"
    ) {
      res.end(
        JSON.stringify([
          { name: "permission-techdept-admin" },
          { name: "permission-techdept-access" },
          { name: "position-techdept-head" },
        ]),
      );

      return;
    }

    if (
      url.pathname ===
      "/admin/realms/bitnp/users/sub-guicao/role-mappings/realm/composite"
    ) {
      res.end(JSON.stringify([{ name: "permission-techdept-access" }]));

      return;
    }

    res.statusCode = 404;
    res.end();
  });

  const guildStub = await startStubServer((req, res, bodyText) => {
    guildRequests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      auth: req.headers.authorization,
      actor: req.headers["x-act-as-subject"] as string | undefined,
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/api/internal/nodes" && req.method === "GET") {
      res.end(
        JSON.stringify([
          {
            id: 10,
            parentId: null,
            title: "树莓娘 Agent",
            dueAt: null,
            completedAt: null,
            tags: ["AI Native"],
            sortOrder: 0,
            childCount: 1,
            commentCount: 0,
            myRelation: "leader",
            updatedAt: "2026-11-18T00:00:00Z",
          },
        ]),
      );

      return;
    }

    if (req.url === "/api/internal/nodes" && req.method === "POST") {
      const payload = JSON.parse(bodyText) as {
        parentId: number | null;
        title: string;
      };

      res.statusCode = 201;
      res.end(
        JSON.stringify({
          id: 42,
          parentId: payload.parentId,
          title: payload.title,
          description: "",
          dueAt: null,
          completedAt: null,
          tags: [],
          sortOrder: 0,
          createdBySubject: "sub-wrz",
          breadcrumb: [{ id: 10, title: "树莓娘 Agent" }],
          directLeaders: [{ subject: "sub-guicao", userName: "硅草" }],
          directMembers: [],
          children: [],
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
  });

  let step = 0;
  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };

    res.setHeader("Content-Type", "application/json");
    step++;

    // Unbound user turn: Main Agent delegates to guild_operator, which short-circuits before calling LLM.
    if (step === 1) {
      res.end(
        JSON.stringify({
          id: "u1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-del-unbound",
                    type: "function",
                    function: {
                      name: "delegate_subagent",
                      arguments: JSON.stringify({
                        kind: "guild_operator",
                        task: "创建节点：非法节点",
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

    if (step === 2) {
      const toolResult = reqJson.messages.at(-1)?.content ?? "";

      assert.match(toolResult, /尚未在网协通行证绑定 QQ/);
      res.end(
        JSON.stringify({
          id: "u2",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  units: [{ kind: "qq_reply", text: "请先绑定 QQ" }],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );

      return;
    }

    // Bound user turn: Main Agent delegates -> subagent searches & creates -> subagent returns brief -> Main Agent replies.
    if (step === 3) {
      res.end(
        JSON.stringify({
          id: "b1-main",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-del-bound",
                    type: "function",
                    function: {
                      name: "delegate_subagent",
                      arguments: JSON.stringify({
                        kind: "guild_operator",
                        task: "在「树莓娘 Agent」下创建节点「接入监控告警」，由硅草负责",
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

    if (step === 4) {
      assert.match(reqJson.messages[0]?.content ?? "", /公会看板协作子代理/);
      res.end(
        JSON.stringify({
          id: "b1-sub",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "guild_search_nodes",
                      arguments: JSON.stringify({ query: "树莓娘" }),
                    },
                  },
                  {
                    id: "call-2",
                    type: "function",
                    function: {
                      name: "guild_resolve_member",
                      arguments: JSON.stringify({ query: "硅草" }),
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

    if (step === 5) {
      assert.match(reqJson.messages[0]?.content ?? "", /公会看板协作子代理/);
      res.end(
        JSON.stringify({
          id: "b2-sub",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-3",
                    type: "function",
                    function: {
                      name: "guild_create_node",
                      arguments: JSON.stringify({
                        parentId: 10,
                        title: "接入监控告警",
                        leaderSubjects: ["sub-guicao"],
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

    if (step === 6) {
      assert.match(reqJson.messages[0]?.content ?? "", /公会看板协作子代理/);
      res.end(
        JSON.stringify({
          id: "b3-sub",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  brief: "已创建节点「接入监控告警」（ID 42，负责人：硅草）",
                  references: ["https://guild.bitnp.net/nodes/42"],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );

      return;
    }

    const subagentToolOutput = reqJson.messages.at(-1)?.content ?? "";

    assert.match(subagentToolOutput, /接入监控告警/);
    res.end(
      JSON.stringify({
        id: "b4-main",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                units: [
                  {
                    kind: "qq_reply",
                    text: "已创建节点「接入监控告警」：https://guild.bitnp.net/nodes/42",
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
    const created = await createTestBerryApp({
      oidcIssuer: `${kcStub.url}/realms/bitnp`,
      keycloakAdminUrl: `${kcStub.url}/admin/realms/bitnp`,
      keycloakClientId: "berry-admin",
      keycloakClientSecret: "kc-sec",
      guildApiUrl: guildStub.url,
      guildInternalToken: "guild-internal-sec",
      guildPublicUrl: "https://guild.bitnp.net",
      mainBaseUrl: `${llmStub.url}/v1`,
    });
    const { app } = created;

    cleanup = created.cleanup;
    // Unbound QQ 88888
    const unboundMsg = await app.store.messages.capture({
      kind: "group",
      chatId: "100",
      onebotMessageId: "m-unbound",
      userId: "88888",
      senderName: "路人",
      text: "帮我建个节点",
      segments: [{ type: "text", data: { text: "帮我建个节点" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: true,
      sentAt: Date.now(),
    });

    const resUnbound = await app.agent.invoke({
      source: "qq_batch",
      chatKey: "group:100",
      kind: "group",
      chatId: "100",
      triggerMessageIds: [unboundMsg.message.id],
      senderId: "88888",
      senderName: "路人",
    });

    assert.equal(resUnbound.units[0]?.kind, "qq_reply");
    assert.equal(guildRequests.length, 0);

    // Bound QQ 11111
    const boundMsg = await app.store.messages.capture({
      kind: "group",
      chatId: "100",
      onebotMessageId: "m-bound",
      userId: "11111",
      senderName: "王润哲",
      text: "在树莓娘下面建个接入监控告警，给硅草负责",
      segments: [
        {
          type: "text",
          data: { text: "在树莓娘下面建个接入监控告警，给硅草负责" },
        },
      ],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: true,
      sentAt: Date.now(),
    });

    const resBound = await app.agent.invoke({
      source: "qq_batch",
      chatKey: "group:100",
      kind: "group",
      chatId: "100",
      triggerMessageIds: [boundMsg.message.id],
      senderId: "11111",
      senderName: "王润哲",
    });

    assert.equal(resBound.units.length, 1);
    assert.equal(guildRequests.length, 2);
    assert.equal(guildRequests[1]!.method, "POST");
    assert.equal(guildRequests[1]!.auth, "Bearer guild-internal-sec");
    assert.equal(guildRequests[1]!.actor, "sub-wrz");
    assert.deepEqual(guildRequests[1]!.body, {
      parentId: 10,
      title: "接入监控告警",
      description: "",
      dueAt: null,
      tags: [],
      leaderSubjects: ["sub-guicao"],
      memberSubjects: [],
    });

    const audits = await app.store.guildAudit.list();

    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actorSubject, "sub-wrz");
    assert.equal(audits[0]!.nodeId, 42);
    assert.equal(audits[0]!.error, null);

    // Ensure global conversation persisted the concise subagent brief without raw Guild JSON payloads.
    const conv = await app.store.conversations.get();

    assert.ok(conv);
    const serializedConv = JSON.stringify(conv.messages);

    assert.match(serializedConv, /接入监控告警/);
    assert.doesNotMatch(serializedConv, /createdBySubject/);
  } finally {
    await cleanup?.();
    await kcStub.close();
    await guildStub.close();
    await llmStub.close();
  }
});
