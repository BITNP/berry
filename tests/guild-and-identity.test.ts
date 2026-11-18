import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
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

test("GuildAutomationRunner consumes SSE events, due-nodes, and activity-summary without PostgreSQL", async () => {
  interface StubGuildEvent {
    id: number;
    kind: string;
    nodeId: number | null;
    actorSubject: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }

  const eventsList: StubGuildEvent[] = [
    {
      id: 1,
      kind: "node.created",
      nodeId: 10,
      actorSubject: "sub-wrz",
      payload: { title: "Historical Seed Node" },
      createdAt: "2026-11-18T09:00:00Z",
    },
  ];
  const sseClients = new Set<ServerResponse>();
  const sentDms: { userId: number; text: string }[] = [];
  const serviceAuthChecks: string[] = [];

  function pushSseEvent(ev: StubGuildEvent): void {
    eventsList.push(ev);
    const frame = `id: ${ev.id}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`;

    for (const client of sseClients) {
      client.write(frame);
    }
  }

  const kcStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/realms/bitnp/protocol/openid-connect/token") {
      res.end(JSON.stringify({ access_token: "kc-tok", expires_in: 300 }));

      return;
    }

    if (url.pathname === "/admin/realms/bitnp/users/sub-wrz") {
      res.end(
        JSON.stringify({
          id: "sub-wrz",
          username: "wrz",
          firstName: "王润哲",
          enabled: true,
          attributes: { qq_number: ["11111"] },
        }),
      );

      return;
    }

    if (url.pathname === "/admin/realms/bitnp/users/sub-guicao") {
      res.end(
        JSON.stringify({
          id: "sub-guicao",
          username: "guicao",
          firstName: "硅草",
          enabled: true,
          attributes: { qq_number: ["22222"] },
        }),
      );

      return;
    }

    if (url.pathname.endsWith("/role-mappings/realm/composite")) {
      res.end(JSON.stringify([{ name: "permission-techdept-admin" }]));

      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  const gatewayStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");

    if (req.url === "/api/v1/accounts/qq/send_private_msg_async") {
      const body = JSON.parse(bodyText) as {
        user_id: number;
        message: { type: string; data?: { text?: string } }[];
      };
      const text = body.message
        .map((seg) => seg.data?.text ?? "")
        .join("")
        .trim();

      sentDms.push({ userId: body.user_id, text });
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { message_id: `dm-${sentDms.length}` },
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ status: "failed", retcode: 404 }));
  });

  const llmStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    res.end(
      JSON.stringify({
        id: "weekly-summary-1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "## 核心进展\n\n- 完成接口鉴权改造与告警联调。",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 90, completion_tokens: 30 },
      }),
    );
  });

  const guildStub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    serviceAuthChecks.push(url.pathname);
    assert.equal(req.headers.authorization, "Bearer guild-internal-sec");
    assert.equal(req.headers["x-act-as-subject"], undefined);

    if (url.pathname === "/api/internal/events") {
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const filtered = eventsList.filter((e) => e.id > after);
      const items = filtered.slice(0, limit);
      const latestId = eventsList.at(-1)?.id ?? 0;
      const nextAfter = items.at(-1)?.id ?? after;

      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          items,
          hasMore: filtered.length > limit,
          nextAfter,
          latestId,
          serverTime: "2026-11-18T10:00:00Z",
        }),
      );

      return;
    }

    if (url.pathname === "/api/internal/events/stream") {
      const rawAfter =
        url.searchParams.get("after") ??
        (typeof req.headers["last-event-id"] === "string"
          ? req.headers["last-event-id"]
          : "0");
      const after = Number.parseInt(rawAfter, 10) || 0;

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      });
      res.write(": connected\n\n");

      for (const ev of eventsList) {
        if (ev.id > after) {
          res.write(
            `id: ${ev.id}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`,
          );
        }
      }

      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });

      return;
    }

    if (url.pathname === "/api/internal/due-nodes") {
      const since = url.searchParams.get("since");

      res.setHeader("Content-Type", "application/json");

      if (!since) {
        res.end(
          JSON.stringify({ items: [], serverTime: "2026-11-18T10:00:00Z" }),
        );

        return;
      }

      assert.equal(since, "2026-11-18T10:00:00Z");
      assert.equal(url.searchParams.get("advanceHours"), "24");
      res.end(
        JSON.stringify({
          items: [
            {
              id: 88,
              parentId: null,
              title: "完善告警规则",
              dueAt: "2026-11-19T08:00:00Z",
              leaders: ["sub-guicao"],
              members: [],
              overdue: false,
            },
          ],
          serverTime: "2026-11-18T10:15:00Z",
        }),
      );

      return;
    }

    if (url.pathname === "/api/internal/activity-summary") {
      const start = url.searchParams.get("start") ?? "";
      const end = url.searchParams.get("end") ?? "";

      assert.ok(start && end);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          start,
          end,
          snapshotAt: "2026-11-18T10:20:00Z",
          createdCount: 2,
          completedCount: 1,
          commentCount: 1,
          openCount: 3,
          overdueCount: 1,
          createdNodes: [
            {
              id: 88,
              parentId: null,
              title: "完善告警规则",
              dueAt: "2026-11-19T08:00:00Z",
              completedAt: null,
              createdAt: start,
            },
          ],
          completedNodes: [
            {
              id: 77,
              parentId: null,
              title: "接口鉴权改造",
              dueAt: null,
              completedAt: start,
              createdAt: start,
            },
          ],
          recentComments: [
            {
              id: 5,
              nodeId: 88,
              nodeTitle: "完善告警规则",
              authorSubject: "sub-guicao",
              bodyPreview: "已完成联调",
              createdAt: start,
            },
          ],
          overdueNodes: [
            {
              id: 66,
              parentId: null,
              title: "清理旧脚本",
              dueAt: start,
              completedAt: null,
              createdAt: start,
            },
          ],
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
  });

  async function waitUntil(
    predicate: () => Promise<boolean> | boolean,
    timeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("waitUntil timed out");
  }

  let cleanup: (() => Promise<void>) | null = null;

  try {
    const created = await createTestBerryApp({
      gatewayUrl: gatewayStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
      keycloakAdminUrl: `${kcStub.url}/admin/realms/bitnp`,
      keycloakClientId: "berry-admin",
      keycloakClientSecret: "sec",
      oidcIssuer: `${kcStub.url}/realms/bitnp`,
      guildApiUrl: guildStub.url,
      guildInternalToken: "guild-internal-sec",
      guildPublicUrl: "https://guild.bitnp.net",
      mainBaseUrl: `${llmStub.url}/v1`,
    });

    cleanup = created.cleanup;
    const { app } = created;

    app.guildAutomation.start();
    assert.equal(app.guildAutomation.streamConnected, false);

    // Turning guildAutomation on at runtime triggers syncState() -> SSE connect.
    await app.updateSettings({
      ...app.settings,
      guildAutomation: {
        enabled: true,
        pollSeconds: 60,
        dueReminderEnabled: true,
        dueAdvanceHours: 24,
        assignmentsEnabled: true,
        weeklyReportEnabled: true,
        weeklySchedule: { kind: "weekly", weekdays: ["mon"], time: "09:00" },
        weeklyUploadTool: "",
      },
    });

    await waitUntil(async () => {
      const cursor = await app.store.cursors.get("guild_event_cursor");

      return app.guildAutomation.streamConnected && cursor === "1";
    });

    // Self-assignment during node creation should advance cursor without sending a DM.
    pushSseEvent({
      id: 2,
      kind: "member.assigned",
      nodeId: 90,
      actorSubject: "sub-wrz",
      payload: {
        subject: "sub-wrz",
        role: "leader",
        nodeTitle: "部署流水线",
        onCreate: true,
      },
      createdAt: "2026-11-18T10:01:00Z",
    });

    await waitUntil(
      async () => (await app.store.cursors.get("guild_event_cursor")) === "2",
    );
    assert.equal(sentDms.length, 0);

    // Assigning another member notifies them via gateway with assignor name resolved.
    pushSseEvent({
      id: 3,
      kind: "member.assigned",
      nodeId: 90,
      actorSubject: "sub-wrz",
      payload: {
        subject: "sub-guicao",
        role: "leader",
        nodeTitle: "部署流水线",
        onCreate: true,
      },
      createdAt: "2026-11-18T10:02:00Z",
    });

    await waitUntil(
      async () =>
        (await app.store.cursors.get("guild_event_cursor")) === "3" &&
        sentDms.length === 1,
    );
    assert.equal(sentDms[0]!.userId, 22_222);
    assert.match(
      sentDms[0]!.text,
      /王润哲 已将你指定为公会任务的负责人：部署流水线/,
    );
    assert.match(sentDms[0]!.text, /https:\/\/guild\.bitnp\.net\/nodes\/90/);

    // Catch-up polling must not duplicate already-streamed events.
    const catchup = await app.guildAutomation.runAssignments();

    assert.equal(catchup.notified, 0);
    assert.equal(sentDms.length, 1);

    // Due reminders: first call seeds guild_due_cursor, second call notifies leaders.
    const dueSeed = await app.guildAutomation.runDueReminders();

    assert.equal(dueSeed.notified, 0);
    assert.equal(
      await app.store.cursors.get("guild_due_cursor"),
      "2026-11-18T10:00:00Z",
    );

    const dueRun = await app.guildAutomation.runDueReminders();

    assert.equal(dueRun.notified, 1);
    assert.equal(sentDms.length, 2);
    assert.equal(sentDms[1]!.userId, 22_222);
    assert.match(sentDms[1]!.text, /完善告警规则/);

    // Weekly report pulls /api/internal/activity-summary and writes notebook.
    const report = await app.guildAutomation.runWeeklyReport();
    const doc = await app.knowledge.readLines("notebook", report.path, 1, 80);
    const markdown = doc.content;

    assert.match(markdown, /周内新增：2/);
    assert.match(markdown, /完成接口鉴权改造与告警联调/);
    assert.ok(serviceAuthChecks.includes("/api/internal/events"));
    assert.ok(serviceAuthChecks.includes("/api/internal/events/stream"));
    assert.ok(serviceAuthChecks.includes("/api/internal/due-nodes"));
    assert.ok(serviceAuthChecks.includes("/api/internal/activity-summary"));
  } finally {
    await cleanup?.();
    for (const client of sseClients) {
      client.end();
    }

    sseClients.clear();
    await guildStub.close();
    await gatewayStub.close();
    await kcStub.close();
    await llmStub.close();
  }
});
