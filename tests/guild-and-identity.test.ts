import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { TestContext } from "node:test";
import test from "node:test";

import {
  captureText,
  chatReply,
  chatToolCalls,
  createTestBerryApp,
  startStubServer,
  waitUntil,
} from "./helpers.ts";

const startKeycloakStub = (t: TestContext) =>
  startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/realms/bitnp/protocol/openid-connect/token") {
      res.end(JSON.stringify({ access_token: "kc-tok", expires_in: 300 }));

      return;
    }

    const users = [
      {
        id: "sub-wrz",
        username: "wrz",
        firstName: "王润哲",
        enabled: true,
        attributes: { qq_number: ["11111"] },
        roles: [
          "permission-techdept-admin",
          "permission-techdept-access",
          "position-techdept-head",
        ],
      },
      {
        id: "sub-guicao",
        username: "guicao",
        firstName: "硅草",
        enabled: true,
        attributes: { qq_number: ["22222"] },
        roles: ["permission-techdept-access"],
      },
    ];

    if (url.pathname === "/admin/realms/bitnp/users") {
      const q = url.searchParams.get("q") ?? "";
      const search = url.searchParams.get("search") ?? "";
      const matches = users.filter((u) => {
        if (q) {
          return `qq_number:${u.attributes.qq_number[0]}` === q;
        }

        if (search) {
          return u.firstName.includes(search);
        }

        return false;
      });

      res.end(JSON.stringify(matches));

      return;
    }

    const byId = users.find(
      (u) => url.pathname === `/admin/realms/bitnp/users/${u.id}`,
    );

    if (byId) {
      res.end(JSON.stringify(byId));

      return;
    }

    const roleOwner = users.find(
      (u) =>
        url.pathname ===
        `/admin/realms/bitnp/users/${u.id}/role-mappings/realm/composite`,
    );

    if (roleOwner) {
      res.end(JSON.stringify(roleOwner.roles.map((name) => ({ name }))));

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

test("Keycloak QQ lookup, unbound rejection, and natural-language guild_create_node via internal API", async (t) => {
  const guildRequests: {
    method: string;
    path: string;
    auth: string | undefined;
    actor: string | undefined;
    body: unknown;
  }[] = [];

  const kcStub = await startKeycloakStub(t);

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
  }, t);

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string | null }[];
    };
    const sys = reqJson.messages[0]?.content ?? "";
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");
    const lastMsg = reqJson.messages.at(-1);

    res.setHeader("Content-Type", "application/json");

    if (sys.includes("公会看板协作子代理")) {
      if (toolMsgs.length === 0) {
        res.end(
          JSON.stringify(
            chatToolCalls([
              {
                id: "call-1",
                name: "guild_search_nodes",
                args: { query: "树莓娘" },
              },
              {
                id: "call-2",
                name: "guild_resolve_member",
                args: { query: "硅草" },
              },
            ]),
          ),
        );

        return;
      }

      if (toolMsgs.length === 2) {
        res.end(
          JSON.stringify(
            chatToolCalls([
              {
                id: "call-3",
                name: "guild_create_node",
                args: {
                  parentId: 10,
                  title: "接入监控告警",
                  leaderSubjects: ["sub-guicao"],
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
            brief: "已创建节点「接入监控告警」（ID 42，负责人：硅草）",
            references: ["https://guild.bitnp.net/nodes/42"],
          }),
        ),
      );

      return;
    }

    // Main Agent flow.
    if (lastMsg?.role === "tool") {
      const toolResult = lastMsg.content ?? "";

      res.end(
        JSON.stringify(
          chatReply({
            units: [
              {
                kind: "qq_reply",
                text: toolResult.includes("尚未在网协通行证绑定")
                  ? "请先绑定 QQ"
                  : "已创建节点「接入监控告警」：https://guild.bitnp.net/nodes/42",
              },
            ],
          }),
        ),
      );

      return;
    }

    const userContent = lastMsg?.content ?? "";
    const unbound =
      userContent.includes("88888") || userContent.includes("路人");

    res.end(
      JSON.stringify(
        chatToolCalls([
          {
            id: unbound ? "call-del-unbound" : "call-del-bound",
            name: "delegate_subagent",
            args: {
              kind: "guild_operator",
              task: unbound
                ? "创建节点：非法节点"
                : "在「树莓娘 Agent」下创建节点「接入监控告警」，由硅草负责",
            },
          },
        ]),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      oidcIssuer: `${kcStub.url}/realms/bitnp`,
      keycloakAdminUrl: `${kcStub.url}/admin/realms/bitnp`,
      keycloakClientId: "berry-admin",
      keycloakClientSecret: "kc-sec",
      guildApiUrl: guildStub.url,
      guildInternalToken: "guild-internal-sec",
      guildPublicUrl: "https://guild.bitnp.net",
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {},
    t,
  );

  // Unbound QQ 88888 cannot hit Guild internal API.
  const unboundMsg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "m-unbound",
    userId: "88888",
    senderName: "路人",
    text: "帮我建个节点",
    mentionedBot: true,
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

  assert.deepEqual(resUnbound.units, [
    { kind: "qq_reply", text: "请先绑定 QQ" },
  ]);
  assert.equal(guildRequests.length, 0);

  // Bound QQ 11111 creates node impersonating sub-wrz with audit log and concise brief.
  const boundMsg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "m-bound",
    userId: "11111",
    senderName: "王润哲",
    text: "在树莓娘下面建个接入监控告警，给硅草负责",
    mentionedBot: true,
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

  const serializedConv = JSON.stringify(
    (await app.store.conversations.get())?.messages ?? [],
  );

  assert.match(serializedConv, /接入监控告警/);
  assert.doesNotMatch(serializedConv, /createdBySubject/);
});

test("GuildAutomationRunner consumes SSE events, due-nodes, and activity-summary", async (t) => {
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

  t.after(() => {
    for (const client of sseClients) {
      client.end();
    }

    sseClients.clear();
  });

  function pushSseEvent(ev: StubGuildEvent): void {
    eventsList.push(ev);
    const frame = `id: ${ev.id}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`;

    for (const client of sseClients) {
      client.write(frame);
    }
  }

  const kcStub = await startKeycloakStub(t);

  const gatewayStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/accounts/qq/send_private_msg_async") {
      const body = JSON.parse(bodyText) as {
        user_id: number;
        message: { data?: { text?: string } }[];
      };

      sentDms.push({
        userId: body.user_id,
        text: body.message
          .map((seg) => seg.data?.text ?? "")
          .join("")
          .trim(),
      });
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
    res.end();
  }, t);

  const llmStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    res.end(
      JSON.stringify(
        chatReply("## 核心进展\n\n- 完成接口鉴权改造与告警联调。"),
      ),
    );
  }, t);

  const guildStub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    assert.equal(req.headers.authorization, "Bearer guild-internal-sec");
    assert.equal(req.headers["x-act-as-subject"], undefined);

    if (url.pathname === "/api/internal/events") {
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const filtered = eventsList.filter((e) => e.id > after);
      const items = filtered.slice(0, limit);

      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          items,
          hasMore: filtered.length > limit,
          nextAfter: items.at(-1)?.id ?? after,
          latestId: eventsList.at(-1)?.id ?? 0,
          serverTime: "2026-11-18T10:00:00Z",
        }),
      );

      return;
    }

    if (url.pathname === "/api/internal/events/stream") {
      const after =
        Number.parseInt(
          url.searchParams.get("after") ??
            (typeof req.headers["last-event-id"] === "string"
              ? req.headers["last-event-id"]
              : "0"),
          10,
        ) || 0;

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
      req.on("close", () => sseClients.delete(res));

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

      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          start,
          end: url.searchParams.get("end") ?? "",
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
          completedNodes: [],
          recentComments: [],
          overdueNodes: [],
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

  const { app } = await createTestBerryApp(
    {
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
    },
    {},
    t,
  );

  app.guildAutomation.start();
  assert.equal(app.guildAutomation.streamConnected, false);

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

  // Self-assignment on create advances cursor without DM; assigning another member sends DM.
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

  // Catch-up polling does not replay already-streamed events.
  const catchup = await app.guildAutomation.runAssignments();

  assert.equal(catchup.notified, 0);
  assert.equal(sentDms.length, 1);

  // Due reminders seed on first run and notify leaders on subsequent run.
  const dueSeed = await app.guildAutomation.runDueReminders();

  assert.equal(dueSeed.notified, 0);
  const dueRun = await app.guildAutomation.runDueReminders();

  assert.equal(dueRun.notified, 1);
  assert.equal(sentDms[1]!.userId, 22_222);
  assert.match(sentDms[1]!.text, /完善告警规则/);

  // Weekly report writes markdown into notebooks.
  const report = await app.guildAutomation.runWeeklyReport();
  const doc = await app.knowledge.readRaw("notebook", report.path);

  assert.match(doc, /周内新增：2/);
  assert.match(doc, /完成接口鉴权改造与告警联调/);
});
