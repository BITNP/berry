import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ModelIds } from "../src/agent/model-ids.ts";
import {
  bunkoAppendDocumentTool,
  bunkoCreateDocumentTool,
  bunkoDeleteDocumentTool,
  bunkoListTreeTool,
  bunkoReadDocumentTool,
  bunkoTools,
} from "../src/tools/bunko.ts";
import { listChatsTool, readChatWindowTool } from "../src/tools/chat.ts";
import {
  guildCreateNodeTool,
  guildListTreeTool,
  guildTools,
} from "../src/tools/guild.ts";
import { mcpToolProvider } from "../src/tools/mcp.ts";
import { memoryManageTool } from "../src/tools/memory.ts";
import { qqDirectoryTool } from "../src/tools/qq.ts";
import { resolveTools } from "../src/tools/registry.ts";
import { scheduleManageTool } from "../src/tools/schedule.ts";
import { shortenUrlTool } from "../src/tools/shortlink.ts";
import type {
  AgentServices,
  ToolActor,
  ToolContext,
} from "../src/tools/types.ts";
import {
  captureText,
  chatReply,
  createTestBerryApp,
  startStubServer,
  waitUntil,
} from "./helpers.ts";

const makeServices = (
  app: Awaited<ReturnType<typeof createTestBerryApp>>["app"],
): AgentServices => ({
  store: app.store,
  gateway: app.gateway,
  media: app.media,
  bunko: app.bunko,
  shortlink: app.shortlink,
  directory: app.directory,
  guild: app.guild,
  mcp: app.mcp,
  getSettings: () => app.settings,
});

const makeCtx = (
  services: AgentServices,
  ids: ModelIds,
  actor: ToolActor,
): ToolContext => ({ services, ids, actor });

test("two-tier tool guards enforce privileged vs standard boundaries across chats, MCP, memory, schedule, guild, and qq_directory", async (t) => {
  const guildStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/internal/nodes" && req.method === "GET") {
      res.end(
        JSON.stringify([
          {
            id: 1,
            parentId: null,
            title: "总项目",
            description: "",
            dueAt: null,
            completedAt: null,
            tags: [],
            sortOrder: 0,
            childCount: 0,
            commentCount: 0,
            myRelation: "member",
            updatedAt: "2026-11-21T00:00:00Z",
          },
        ]),
      );

      return;
    }

    if (req.url === "/api/internal/nodes" && req.method === "POST") {
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          id: 9,
          parentId: null,
          title: "管理层节点",
          description: "",
          dueAt: null,
          completedAt: null,
          tags: [],
          sortOrder: 0,
          createdBySubject: "sub-mgmt",
          breadcrumb: [],
          directLeaders: [],
          directMembers: [],
          children: [],
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

  const { app } = await createTestBerryApp(
    {
      guildApiUrl: guildStub.url,
      guildInternalToken: "guild-secret",
    },
    {},
    t,
  );
  const services = makeServices(app);

  await app.store.chats.upsert({
    kind: "group",
    chatId: "1001",
    title: "公开交流群",
    enabled: true,
    triggerMode: "mention_only",
    internal: false,
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "2002",
    title: "网协内部工作群",
    enabled: true,
    triggerMode: "smart_observe",
    internal: true,
  });
  await app.store.chats.upsert({
    kind: "private",
    chatId: "5001",
    title: "外部人员",
    enabled: true,
    triggerMode: "smart_observe",
  });

  await captureText(app, {
    kind: "group",
    chatId: "2002",
    id: "ob-internal-1",
    userId: "9001",
    senderName: "部长",
    text: "内部机密排班",
  });

  const ids = new ModelIds();
  const publicRef = ids.groupRef("1001");
  const internalRef = ids.groupRef("2002");
  const memberUserRef = ids.userRef("6001");
  const mgmtUserRef = ids.userRef("7001");

  const externalActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "5001",
    actorSubject: null,
    actorName: "路人",
    actorIsAdmin: false,
    actorIsPrivileged: false,
    actorAdmitted: false,
  };
  const memberActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "6001",
    actorSubject: "sub-member",
    actorName: "普通部员",
    actorIsAdmin: false,
    actorIsPrivileged: false,
    actorAdmitted: true,
  };
  const memberInInternalActor: ToolActor = {
    ...memberActor,
    chatKey: "group:2002",
  };
  const managementActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "7001",
    actorSubject: "sub-mgmt",
    actorName: "管理层",
    actorIsAdmin: false,
    actorIsPrivileged: true,
    actorAdmitted: true,
  };
  const adminActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "9999",
    actorSubject: "sub-admin",
    actorName: "管理员",
    actorIsAdmin: true,
    actorIsPrivileged: true,
    actorAdmitted: true,
  };

  // 1) Chat visibility, cross-group read, and internal group protection.
  // Both external users and ordinary bound members are standard-tier: only current non-internal chat is visible.
  for (const stdActor of [externalActor, memberActor]) {
    const visibleChats = (await listChatsTool
      .bind(makeCtx(services, ids, stdActor))
      .execute({})) as { chats: { targetRef: string }[] };

    assert.equal(
      visibleChats.chats.some((c) => c.targetRef === internalRef),
      false,
    );
    assert.equal(
      visibleChats.chats.some((c) => c.targetRef === publicRef),
      true,
    );

    await assert.rejects(
      () =>
        readChatWindowTool
          .bind(makeCtx(services, ids, stdActor))
          .execute({ targetRef: internalRef }),
      /无权跨群/,
    );
  }

  await assert.rejects(
    () =>
      readChatWindowTool
        .bind(makeCtx(services, ids, memberInInternalActor))
        .execute({}),
    /内部工作群/,
  );

  // Management (privileged) can read internal groups across chats.
  const mgmtInternalRead = (await readChatWindowTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({ targetRef: internalRef })) as { count: number };

  assert.equal(mgmtInternalRead.count, 1);

  // qq_directory blocks standard users (including ordinary members) from enumerating groups/friends.
  const gwStub = await startStubServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: [] }));
  }, t);
  const { app: gwApp } = await createTestBerryApp(
    { gatewayUrl: gwStub.url, gatewayToken: "tok" },
    {},
    t,
  );
  const gwServices = makeServices(gwApp);

  await assert.rejects(
    () =>
      qqDirectoryTool
        .bind(makeCtx(gwServices, ids, memberActor))
        .execute({ scope: "groups" }),
    /普通权限无权查询/,
  );
  await assert.rejects(
    () =>
      qqDirectoryTool
        .bind(makeCtx(gwServices, ids, memberActor))
        .execute({ scope: "friends" }),
    /普通权限无权查询/,
  );

  // 2) Memory guards: standard users are strictly read-only; privileged can write (management scoped to current chat/self + global).
  for (const scope of ["global", "chat", "user"] as const) {
    await assert.rejects(
      () =>
        memoryManageTool.bind(makeCtx(services, ids, memberActor)).execute({
          action: "upsert",
          scope,
          ...(scope === "user" ? { userRef: memberUserRef } : {}),
          key: `k-${scope}`,
          content: "should-block",
        }),
      /仅管理员或网协管理层/,
    );
  }

  const mgmtGlobal = (await memoryManageTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({
      action: "upsert",
      scope: "global",
      key: "k1",
      summary: "共识",
      content: "有效全局记忆",
    })) as { mutated: boolean };

  assert.equal(mgmtGlobal.mutated, true);

  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, managementActor)).execute({
        action: "upsert",
        scope: "chat",
        targetRef: internalRef,
        key: "c1",
        content: "cross",
      }),
    /禁止跨会话/,
  );
  const mgmtChatMem = (await memoryManageTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({
      action: "upsert",
      scope: "chat",
      key: "c1",
      summary: "本群约定",
      content: "周五例会",
    })) as { mutated: boolean };

  assert.equal(mgmtChatMem.mutated, true);

  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, managementActor)).execute({
        action: "upsert",
        scope: "user",
        userRef: memberUserRef,
        key: "u1",
        content: "tamper",
      }),
    /本人的个人记忆/,
  );
  const mgmtSelfUserMem = (await memoryManageTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({
      action: "upsert",
      scope: "user",
      userRef: mgmtUserRef,
      key: "u1",
      summary: "偏好",
      content: "喜欢简短回复",
    })) as { mutated: boolean };

  assert.equal(mgmtSelfUserMem.mutated, true);

  // Standard users can still read allowed memories.
  const memberReadGlobal = (await memoryManageTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({
      action: "read",
      scope: "global",
      key: "k1",
    })) as { memory: { content: string } | null };

  assert.equal(memberReadGlobal.memory?.content, "有效全局记忆");

  // 3) Schedule guards: standard users denied writes; management scoped to current chat & >= 5m interval.
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, memberActor)).execute({
        action: "create",
        title: "普通用户定时",
        content: "ping",
        schedule: { kind: "interval", everyMinutes: 30 },
      }),
    /仅管理员或网协管理层/,
  );
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, managementActor)).execute({
        action: "create",
        title: "高频刷屏",
        content: "spam",
        schedule: { kind: "interval", everySeconds: 30 },
      }),
    /不得短于 5 分钟/,
  );
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, managementActor)).execute({
        action: "create",
        title: "跨群提醒",
        content: "hi",
        targetRef: internalRef,
        schedule: { kind: "interval", everyMinutes: 30 },
      }),
    /非管理员禁止为其他群/,
  );

  const mgmtTaskRes = (await scheduleManageTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({
      action: "create",
      title: "本群提醒",
      content: "开会",
      schedule: { kind: "interval", everyMinutes: 30 },
    })) as { task: { id: string } };

  assert.ok(mgmtTaskRes.task.id);

  const adminOtherTaskRes = (await scheduleManageTool
    .bind(makeCtx(services, ids, adminActor))
    .execute({
      action: "create",
      title: "内部群提醒",
      content: "值班",
      targetRef: internalRef,
      schedule: { kind: "interval", everySeconds: 10 },
    })) as { task: { id: string } };

  const mgmtListed = (await scheduleManageTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({ action: "list" })) as { tasks: { id: string }[] };

  assert.deepEqual(
    mgmtListed.tasks.map((task) => task.id),
    [mgmtTaskRes.task.id],
  );
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, managementActor)).execute({
        action: "delete",
        id: adminOtherTaskRes.task.id,
      }),
    /禁止删除其他会话/,
  );

  // 4) MCP tools require privileged role.
  assert.deepEqual(
    mcpToolProvider.resolve(makeCtx(services, ids, memberActor)),
    [],
  );

  // 5) Guild: bound ordinary member can read (write tools hidden by guard), writes require privileged role.
  assert.deepEqual(
    resolveTools(guildTools, makeCtx(services, ids, memberActor)).map(
      (tool) => tool.name,
    ),
    [
      "guild_resolve_member",
      "guild_list_tree",
      "guild_search_nodes",
      "guild_get_node",
      "guild_node_progress",
    ],
  );
  assert.equal(
    resolveTools(guildTools, makeCtx(services, ids, managementActor)).length,
    guildTools.length,
  );
  const memberTree = (await guildListTreeTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({})) as { totalNodes: number; roots: { id: number }[] };

  assert.equal(memberTree.totalNodes, 1);
  assert.equal(memberTree.roots.length, 1);

  await assert.rejects(
    () =>
      guildCreateNodeTool
        .bind(makeCtx(services, ids, memberActor))
        .execute({ title: "未授权节点" }),
    /仅管理员或网协管理层/,
  );

  const mgmtNode = (await guildCreateNodeTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({ title: "管理层节点" })) as { id: number };

  assert.equal(mgmtNode.id, 9);
});

test("gate privilege bypass, classifier privilege tags, qq_reaction guard, knownGroups, and privateAccessMode", async (t) => {
  const capturedMainPayloads: string[] = [];
  const capturedGateCandidates: {
    userId: string;
    privilege?: string;
    text: string;
  }[] = [];
  const reactionRequests: string[] = [];

  const llmStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();

      return;
    }

    const reqJson = JSON.parse(bodyText) as {
      model: string;
      messages: { role: string; content: string | null }[];
    };

    if (reqJson.model === "gpt-test-gate") {
      const payload = JSON.parse(reqJson.messages[1]!.content!) as {
        candidates: {
          messageId: number;
          userId: string;
          privilege?: string;
          text: string;
        }[];
      };

      for (const item of payload.candidates) {
        capturedGateCandidates.push({
          userId: item.userId,
          privilege: item.privilege,
          text: item.text,
        });
      }

      res.end(
        JSON.stringify(
          chatReply({
            decisions: payload.candidates.map((c) => ({
              messageId: c.messageId,
              action: c.text.includes("静默记忆") ? "memory" : "ignore",
              confidence: 0.9,
              reason: "测试分流",
            })),
          }),
        ),
      );

      return;
    }

    const content = reqJson.messages.at(-1)?.content ?? "";

    capturedMainPayloads.push(content);

    if (content.includes("打个表情测试")) {
      const match = /"quoteRef":"(m_[^"]+)"/.exec(content);

      res.end(
        JSON.stringify(
          chatReply({
            units: match
              ? [
                  {
                    kind: "qq_reaction",
                    messageId: match[1]!,
                    emojiId: "㊗️",
                  },
                ]
              : [],
          }),
        ),
      );

      return;
    }

    res.end(JSON.stringify(chatReply({ units: [] })));
  }, t);

  const gwStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("set_msg_emoji_like")) {
      reactionRequests.push(req.url);
    }

    res.end(JSON.stringify({ status: "ok", retcode: 0, data: {} }));
  }, t);

  const kcStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("/protocol/openid-connect/token")) {
      res.end(JSON.stringify({ access_token: "kc-tok", expires_in: 300 }));

      return;
    }

    if (
      req.url?.includes("qq_number%3A30001") ||
      req.url?.includes("qq_number:30001")
    ) {
      res.end(
        JSON.stringify([
          {
            id: "sub-member-1",
            username: "member1",
            firstName: "网协成员",
            enabled: true,
            attributes: { qq_number: ["30001"] },
          },
        ]),
      );

      return;
    }

    if (
      req.url?.includes("qq_number%3A40001") ||
      req.url?.includes("qq_number:40001")
    ) {
      res.end(
        JSON.stringify([
          {
            id: "sub-mgmt-1",
            username: "mgmt1",
            firstName: "网协部长",
            enabled: true,
            attributes: { qq_number: ["40001"] },
          },
        ]),
      );

      return;
    }

    if (
      req.url?.includes("/users/sub-member-1/role-mappings/realm/composite")
    ) {
      res.end(JSON.stringify([{ name: "permission-techdept-access" }]));

      return;
    }

    if (req.url?.includes("/users/sub-mgmt-1/role-mappings/realm/composite")) {
      res.end(
        JSON.stringify([
          { name: "permission-management-access" },
          { name: "permission-techdept-access" },
        ]),
      );

      return;
    }

    res.end(JSON.stringify([]));
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayToken: "gw-tok",
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
      keycloakAdminUrl: `${kcStub.url}/admin/realms/bitnp`,
      oidcIssuer: `${kcStub.url}/realms/bitnp`,
      keycloakClientId: "berry",
      keycloakClientSecret: "secret",
    },
    {
      gateModel: {
        batchWindowMs: 100,
      },
      policy: {
        adminQQs: ["10001"],
        adminBypassGate: true,
        privateDefaultEnabled: true,
        privateAccessMode: "members_and_admins",
      },
    },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "100",
    title: "外部群",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "200",
    title: "机密内部群",
    enabled: true,
    triggerMode: "smart_observe",
    internal: true,
  });

  // 1) Ordinary member invoke in group:100 should NOT see group:200 in knownGroups,
  //    has tier="standard", and qq_reaction unit is hard-blocked.
  const memberMsg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-member-react",
    userId: "30001",
    senderName: "普通部员",
    text: "打个表情测试",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [memberMsg.message.id],
    senderId: "30001",
    senderName: "普通部员",
  });

  const memberPayload = capturedMainPayloads[0] ?? "";

  assert.doesNotMatch(memberPayload, /机密内部群/);
  assert.match(memberPayload, /"tier":"standard"/);
  assert.match(memberPayload, /"role":"member"/);
  assert.equal(reactionRequests.length, 0);

  // 2) Management user (permission-management-access) gets tier="privileged", sees internal group,
  //    and qq_reaction is dispatched.
  const mgmtMsg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-mgmt-react",
    userId: "40001",
    senderName: "网协部长",
    text: "打个表情测试",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [mgmtMsg.message.id],
    senderId: "40001",
    senderName: "网协部长",
  });

  const mgmtPayload = capturedMainPayloads[1] ?? "";

  assert.match(mgmtPayload, /机密内部群/);
  assert.match(mgmtPayload, /"tier":"privileged"/);
  assert.match(mgmtPayload, /"role":"management"/);
  assert.equal(reactionRequests.length, 1);

  // 3) Direct @ by management user bypasses small-model classifier at L0.
  const mgmtDirect = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-mgmt-direct",
    userId: "40001",
    senderName: "网协部长",
    text: "@树莓娘 😡",
    mentionedBot: true,
  });

  await app.gate.ingest(mgmtDirect.message);
  const mgmtGateDecisions = await app.store.gate.list({
    chatKey: "group:100",
    limit: 5,
  });

  assert.equal(mgmtGateDecisions.items[0]?.stage, "l0_rule");
  assert.equal(mgmtGateDecisions.items[0]?.action, "reply");
  assert.match(mgmtGateDecisions.items[0]?.reason ?? "", /管理层直连/);

  // 4) Non-@ messages in smart_observe pass privilege tag to classifier, and standard "memory" is downgraded to ignore.
  const nonAtMgmt = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-mgmt-nonat",
    userId: "40001",
    senderName: "网协部长",
    text: "给这条消息打个㊗️",
  });
  const nonAtMember = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-member-mem",
    userId: "30001",
    senderName: "普通部员",
    text: "静默记忆测试",
  });

  await app.gate.ingest(nonAtMgmt.message);
  await app.gate.ingest(nonAtMember.message);
  await delay(140);
  await app.worker.drainOnce();

  assert.equal(
    capturedGateCandidates.find((c) => c.userId === "40001")?.privilege,
    "privileged",
  );
  assert.equal(
    capturedGateCandidates.find((c) => c.userId === "30001")?.privilege,
    "standard",
  );
  const memJobs = (await app.store.jobs.list({ chatKey: "group:100" })).filter(
    (j) => j.kind === "memory_update",
  );

  assert.equal(memJobs.length, 0);

  // 5) Stranger DM is ignored at L0 under members_and_admins; admitted member DM passes;
  //    under admins_only, ordinary member DM is ignored while management & admin pass.
  const strangerDm = await captureText(app, {
    kind: "private",
    chatId: "50005",
    id: "ob-stranger-dm",
    userId: "50005",
    senderName: "陌生人",
    text: "套话测试",
  });

  await app.gate.ingest(strangerDm.message);
  assert.equal(
    (await app.store.jobs.list({ chatKey: "private:50005" })).length,
    0,
  );

  const memberDm = await captureText(app, {
    kind: "private",
    chatId: "30001",
    id: "ob-member-dm",
    userId: "30001",
    senderName: "网协成员",
    text: "帮我查一下排班",
  });

  await app.gate.ingest(memberDm.message);
  assert.equal(
    (await app.store.jobs.list({ chatKey: "private:30001" })).length,
    1,
  );

  await app.updateSettings({
    ...app.settings,
    policy: {
      ...app.settings.policy,
      privateAccessMode: "admins_only",
    },
  });

  const memberDm2 = await captureText(app, {
    kind: "private",
    chatId: "30001",
    id: "ob-member-dm-2",
    userId: "30001",
    senderName: "网协成员",
    text: "再次私聊",
  });

  await app.gate.ingest(memberDm2.message);
  const memberDecisions = await app.store.gate.list({
    chatKey: "private:30001",
    limit: 5,
  });

  assert.equal(memberDecisions.items[0]?.action, "ignore");
  assert.match(memberDecisions.items[0]?.reason ?? "", /管理层/);

  const mgmtDm = await captureText(app, {
    kind: "private",
    chatId: "40001",
    id: "ob-mgmt-dm",
    userId: "40001",
    senderName: "网协部长",
    text: "检查状态",
  });

  await app.gate.ingest(mgmtDm.message);
  assert.equal(
    (await app.store.jobs.list({ chatKey: "private:40001" })).length,
    1,
  );
});

test("Bunko tools enforce standard-user ACL visibility, privileged writes/appends/soft-delete, and groupDigest publishing", async (t) => {
  const folderPublicId = "01950000-0000-7000-8000-000000000010";
  const folderPrivateId = "01950000-0000-7000-8000-000000000020";
  const docPublicId = "01950000-0000-7000-8000-000000000101";
  const docMemberId = "01950000-0000-7000-8000-000000000102";
  const docPrivateId = "01950000-0000-7000-8000-000000000103";
  const docDeptOnlyId = "01950000-0000-7000-8000-000000000104";
  const docInPrivateFolderId = "01950000-0000-7000-8000-000000000105";
  const createdDocs: { title: string; folderId?: string; markdown?: string }[] =
    [];
  const appendedCalls: { docId: string; key: string; markdown: string }[] = [];
  const deletedDocs: string[] = [];

  const bunkoStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/v1/tree" && req.method === "GET") {
      const fid = url.searchParams.get("folderId");

      if (!fid) {
        res.end(
          JSON.stringify({
            folder: null,
            breadcrumb: [],
            folders: [
              { id: folderPublicId, name: "公开区", isPrivate: false },
              { id: folderPrivateId, name: "管理层私密", isPrivate: true },
            ],
            documents: [
              {
                id: docPublicId,
                title: "网协简介",
                folderId: null,
                isPublic: true,
                isPrivate: false,
                version: 1,
                updatedAt: "2026-11-21T00:00:00Z",
              },
              {
                id: docMemberId,
                title: "全员手册",
                folderId: null,
                isPublic: false,
                isPrivate: false,
                version: 1,
                updatedAt: "2026-11-21T00:00:00Z",
              },
              {
                id: docPrivateId,
                title: "主席团密件",
                folderId: null,
                isPublic: false,
                isPrivate: true,
                version: 1,
                updatedAt: "2026-11-21T00:00:00Z",
              },
              {
                id: docDeptOnlyId,
                title: "技术部内部",
                folderId: null,
                isPublic: false,
                isPrivate: false,
                version: 1,
                updatedAt: "2026-11-21T00:00:00Z",
              },
            ],
            aliases: [],
          }),
        );

        return;
      }

      if (fid === folderPrivateId) {
        res.end(
          JSON.stringify({
            folder: {
              id: folderPrivateId,
              name: "管理层私密",
              isPrivate: true,
            },
            breadcrumb: [{ id: folderPrivateId, name: "管理层私密" }],
            folders: [],
            documents: [
              {
                id: docInPrivateFolderId,
                title: "私密目录文档",
                folderId: folderPrivateId,
                isPublic: false,
                isPrivate: false,
                version: 1,
                updatedAt: "2026-11-21T00:00:00Z",
              },
            ],
            aliases: [],
          }),
        );

        return;
      }

      res.end(
        JSON.stringify({
          folder: { id: folderPublicId, name: "公开区", isPrivate: false },
          breadcrumb: [{ id: folderPublicId, name: "公开区" }],
          folders: [],
          documents: [],
          aliases: [],
        }),
      );

      return;
    }

    if (url.pathname === "/api/v1/tree/path") {
      const docId = url.searchParams.get("documentId");

      res.end(
        JSON.stringify({
          breadcrumb:
            docId === docInPrivateFolderId
              ? [{ id: folderPrivateId, name: "管理层私密" }]
              : [],
        }),
      );

      return;
    }

    if (url.pathname.endsWith("/access")) {
      const docId = url.pathname.split("/")[4];
      const map: Record<string, unknown> = {
        [docPublicId]: {
          custom: false,
          rules: [],
          isPublic: true,
          isPrivate: false,
          folderId: null,
        },
        [docMemberId]: {
          custom: false,
          rules: [],
          isPublic: false,
          isPrivate: false,
          folderId: null,
        },
        [docPrivateId]: {
          custom: false,
          rules: [],
          isPublic: false,
          isPrivate: true,
          folderId: null,
        },
        [docDeptOnlyId]: {
          custom: true,
          rules: [
            {
              principalType: "department",
              principalId: "techdept",
              permission: "read",
            },
          ],
          isPublic: false,
          isPrivate: false,
          folderId: null,
        },
        [docInPrivateFolderId]: {
          custom: false,
          rules: [],
          isPublic: false,
          isPrivate: false,
          folderId: folderPrivateId,
        },
      };

      res.end(JSON.stringify(map[docId ?? ""] ?? map[docPrivateId]));

      return;
    }

    if (url.pathname.endsWith("/content") && req.method === "GET") {
      res.end(
        JSON.stringify({
          markdown: "# 正文\n测试内容",
          materialized: true,
          version: 1,
          headVersion: 1,
          stale: false,
        }),
      );

      return;
    }

    if (url.pathname.endsWith("/content/append") && req.method === "POST") {
      const docId = url.pathname.split("/")[4] ?? "";
      const payload = JSON.parse(bodyText) as { markdown: string };

      appendedCalls.push({
        docId,
        key: String(req.headers["idempotency-key"] ?? ""),
        markdown: payload.markdown,
      });
      res.end(JSON.stringify({ version: 2 }));

      return;
    }

    if (url.pathname === "/api/v1/documents" && req.method === "POST") {
      const payload = JSON.parse(bodyText) as {
        title: string;
        folderId?: string;
        markdown?: string;
      };

      createdDocs.push(payload);
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          document: {
            id: "01950000-0000-7000-8000-000000000999",
            title: payload.title,
            folderId: payload.folderId ?? null,
            isPublic: false,
            isPrivate: false,
            version: 1,
            updatedAt: "2026-11-21T00:00:00Z",
          },
        }),
      );

      return;
    }

    if (url.pathname.startsWith("/api/v1/documents/") && req.method === "GET") {
      const docId = url.pathname.split("/")[4] ?? "";

      res.end(
        JSON.stringify({
          document: {
            id: docId,
            title: "测试文档",
            folderId: null,
            isPublic: docId === docPublicId,
            isPrivate: docId === docPrivateId,
            version: 1,
            updatedAt: "2026-11-21T00:00:00Z",
          },
        }),
      );

      return;
    }

    if (
      url.pathname.startsWith("/api/v1/documents/") &&
      req.method === "DELETE"
    ) {
      const docId = url.pathname.split("/")[4] ?? "";

      deletedDocs.push(docId);
      res.end(JSON.stringify({ deleted: true, hard: false }));

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

  const llmStub = await startStubServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(chatReply({ brief: "- 讨论了 Bunko 迁移方案" })));
  }, t);

  const { app } = await createTestBerryApp(
    {
      bunkoApiUrl: bunkoStub.url,
      bunkoApiKey: "bunko_app_test_token",
      bunkoPublicUrl: "https://docs.bitnp.net",
      bunkoWorkspaceSlug: "bitnp",
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {
      groupDigest: {
        minMessages: 1,
        folderId: folderPublicId,
      },
    },
    t,
  );
  const services = makeServices(app);
  const ids = new ModelIds();

  const externalActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "5001",
    actorSubject: null,
    actorName: "路人",
    actorIsAdmin: false,
    actorIsPrivileged: false,
    actorAdmitted: false,
  };
  const memberActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "6001",
    actorSubject: "sub-member",
    actorName: "普通部员",
    actorIsAdmin: false,
    actorIsPrivileged: false,
    actorAdmitted: true,
  };
  const managementActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "7001",
    actorSubject: "sub-mgmt",
    actorName: "管理层",
    actorIsAdmin: false,
    actorIsPrivileged: true,
    actorAdmitted: true,
  };

  // Standard users only get read tools resolved via Tool.guard.
  assert.deepEqual(
    resolveTools(bunkoTools, makeCtx(services, ids, memberActor)).map(
      (tool) => tool.name,
    ),
    ["bunko_list_tree", "bunko_read_document"],
  );
  assert.equal(
    resolveTools(bunkoTools, makeCtx(services, ids, managementActor)).length,
    5,
  );

  // External user: sees only public docs & non-private folders.
  const extTree = (await bunkoListTreeTool
    .bind(makeCtx(services, ids, externalActor))
    .execute({})) as {
    folders: { id: string }[];
    documents: { id: string }[];
  };

  assert.deepEqual(
    extTree.folders.map((f) => f.id),
    [folderPublicId],
  );
  assert.deepEqual(
    extTree.documents.map((d) => d.id),
    [docPublicId],
  );
  await assert.rejects(
    () =>
      bunkoReadDocumentTool
        .bind(makeCtx(services, ids, externalActor))
        .execute({ documentId: docMemberId }),
    /私密或受限文档/,
  );

  // Ordinary bound member: sees public + all-member non-private doc, blocked from private, dept-only, and private-folder docs.
  const memberTree = (await bunkoListTreeTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({})) as { documents: { id: string }[] };

  assert.deepEqual(
    memberTree.documents.map((d) => d.id),
    [docPublicId, docMemberId],
  );
  await assert.rejects(
    () =>
      bunkoReadDocumentTool
        .bind(makeCtx(services, ids, memberActor))
        .execute({ documentId: docPrivateId }),
    /私密或受限文档/,
  );
  await assert.rejects(
    () =>
      bunkoReadDocumentTool
        .bind(makeCtx(services, ids, memberActor))
        .execute({ documentId: docDeptOnlyId }),
    /私密或受限文档/,
  );
  await assert.rejects(
    () =>
      bunkoReadDocumentTool
        .bind(makeCtx(services, ids, memberActor))
        .execute({ documentId: docInPrivateFolderId }),
    /私密或受限文档/,
  );
  await assert.rejects(
    () =>
      bunkoCreateDocumentTool
        .bind(makeCtx(services, ids, memberActor))
        .execute({ title: "禁止新建" }),
    /仅管理员或网协管理层/,
  );

  // Privileged user can read private docs and create/append/soft-delete.
  const privRead = (await bunkoReadDocumentTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({ documentId: docPrivateId })) as { content: string; url: string };

  assert.match(privRead.content, /测试内容/);
  assert.equal(
    privRead.url,
    `https://docs.bitnp.net/bitnp/doc/${docPrivateId}`,
  );

  await bunkoCreateDocumentTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({
      title: "会议纪要",
      folderId: folderPublicId,
      markdown: "## 要点\n\n- 已迁移",
    });
  await bunkoAppendDocumentTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({
      documentId: docMemberId,
      markdown: "- 补充一条",
    });
  await bunkoDeleteDocumentTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({ documentId: docMemberId });

  assert.equal(createdDocs[0]?.title, "会议纪要");
  assert.equal(appendedCalls.length, 1);
  assert.ok(appendedCalls[0]?.key.startsWith("berry:"));
  assert.deepEqual(deletedDocs, [docMemberId]);

  // Group digest publishes directly to Bunko folderId.
  await app.store.chats.upsert({
    kind: "group",
    chatId: "8888",
    title: "核心技术群",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await captureText(app, {
    kind: "group",
    chatId: "8888",
    id: "m-digest-1",
    userId: "7001",
    senderName: "管理层",
    text: "周报和群聊摘要都迁到 Bunko 了",
    sentAt: Date.now() - 10_000,
  });

  await app.scheduler.enqueueDigestNow("8888", 24);
  await app.worker.drainOnce();
  await waitUntil(() =>
    createdDocs.some(
      (d) =>
        d.folderId === folderPublicId &&
        d.title.includes("核心技术群 讨论摘要") &&
        (d.markdown ?? "").includes("Bunko 迁移方案"),
    ),
  );
});

test("ShortLinkClient shortens long URLs via p.bitnp.net form protocol, caches, validates responses, and gates shorten_url to privileged users", async (t) => {
  let requests = 0;
  let mode: "ok" | "bad_origin" | "error" = "ok";

  const shortStub = await startStubServer((req, res, bodyText) => {
    requests++;

    if (mode === "error") {
      res.statusCode = 503;
      res.end("down");

      return;
    }

    assert.equal(req.method, "POST");
    assert.equal(req.url, "/create");
    assert.equal(req.headers.origin, shortStub.url);
    const form = new URLSearchParams(bodyText);

    assert.ok(form.get("url")?.startsWith("https://"));

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (mode === "bad_origin") {
      res.end(
        `<input id="short-url" value="https://evil.example/abc123" readonly />`,
      );

      return;
    }

    res.end(
      `<input value='${shortStub.url}/b1tnp9' id='short-url' readonly />`,
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      shortlinkOrigin: shortStub.url,
    },
    {},
    t,
  );
  const services = makeServices(app);
  const ids = new ModelIds();

  const memberActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "6001",
    actorSubject: "sub-member",
    actorName: "普通部员",
    actorIsAdmin: false,
    actorIsPrivileged: false,
    actorAdmitted: true,
  };
  const managementActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "7001",
    actorSubject: "sub-mgmt",
    actorName: "管理层",
    actorIsAdmin: false,
    actorIsPrivileged: true,
    actorAdmitted: true,
  };

  // Standard user cannot see or invoke shorten_url.
  assert.deepEqual(
    resolveTools([shortenUrlTool], makeCtx(services, ids, memberActor)),
    [],
  );
  await assert.rejects(
    () =>
      shortenUrlTool.bind(makeCtx(services, ids, memberActor)).execute({
        url: "https://docs.bit-staging.bitnp.net/bitnp/doc/123456",
      }),
    /仅管理员或网协管理层/,
  );

  // Privileged user shortens long URL and second call hits cache.
  const longUrl =
    "https://docs.bit-staging.bitnp.net/bitnp/doc/01a1fd0b-4ba6-727a-a903-37abe65ec987";
  const first = (await shortenUrlTool
    .bind(makeCtx(services, ids, managementActor))
    .execute({ url: longUrl })) as { shortUrl: string };
  const second = await app.shortlink.shortenOrFallback(longUrl);

  assert.equal(first.shortUrl, `${shortStub.url}/b1tnp9`);
  assert.equal(second, `${shortStub.url}/b1tnp9`);
  assert.equal(requests, 1);

  // Already-shortened origin returns as-is without network calls.
  assert.equal(
    await app.shortlink.shortenOrFallback(`${shortStub.url}/b1tnp9`),
    `${shortStub.url}/b1tnp9`,
  );
  assert.equal(requests, 1);

  // Invalid shortlink response is rejected by shorten() and gracefully falls back in shortenOrFallback().
  mode = "bad_origin";
  const anotherLongUrl =
    "https://docs.bit-staging.bitnp.net/bitnp/doc/01a1fd0b-4ba6-727a-a903-37abe65ec988";

  await assert.rejects(
    () => app.shortlink.shorten(anotherLongUrl),
    /未返回有效的短链接/,
  );
  mode = "error";
  assert.equal(
    await app.shortlink.shortenOrFallback(anotherLongUrl),
    anotherLongUrl,
  );
});
