import assert from "node:assert/strict";
import test from "node:test";

import { ModelIds } from "../src/agent/model-ids.ts";
import { listChatsTool, readChatWindowTool } from "../src/tools/chat.ts";
import { memoryManageTool } from "../src/tools/memory.ts";
import { qqDirectoryTool } from "../src/tools/qq.ts";
import { scheduleManageTool } from "../src/tools/schedule.ts";
import type {
  AgentServices,
  ToolActor,
  ToolContext,
} from "../src/tools/types.ts";
import {
  mcpToolsSource,
  notebookDeleteTool,
  notebookWriteTool,
} from "../src/tools/workspace.ts";
import {
  captureText,
  chatReply,
  createTestBerryApp,
  startStubServer,
} from "./helpers.ts";

const makeServices = (
  app: Awaited<ReturnType<typeof createTestBerryApp>>["app"],
): AgentServices => ({
  store: app.store,
  gateway: app.gateway,
  media: app.media,
  knowledge: app.knowledge,
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

test("three-tier tool guards enforce chat, internal group, memory, schedule, workspace, and qq_directory boundaries", async (t) => {
  const { app } = await createTestBerryApp({}, {}, t);
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
  const externalUserRef = ids.userRef("5001");
  const otherUserRef = ids.userRef("6001");

  const externalActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "5001",
    actorSubject: null,
    actorName: "路人",
    actorIsAdmin: false,
    actorIsManager: false,
    actorAdmitted: false,
  };
  const externalInInternalActor: ToolActor = {
    ...externalActor,
    chatKey: "group:2002",
  };
  const memberActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "6001",
    actorSubject: "sub-member",
    actorName: "部员",
    actorIsAdmin: false,
    actorIsManager: false,
    actorAdmitted: true,
  };
  const managerActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "7001",
    actorSubject: "sub-manager",
    actorName: "部长",
    actorIsAdmin: false,
    actorIsManager: true,
    actorAdmitted: true,
  };
  const adminActor: ToolActor = {
    chatKey: "group:1001",
    senderQQ: "9999",
    actorSubject: "sub-admin",
    actorName: "管理员",
    actorIsAdmin: true,
    actorIsManager: true,
    actorAdmitted: true,
  };

  // 1) Chat visibility, cross-group read, and internal group protection.
  const externalChats = (await listChatsTool
    .bind(makeCtx(services, ids, externalActor))
    .execute({})) as { chats: { targetRef: string }[] };

  assert.equal(
    externalChats.chats.some((c) => c.targetRef === internalRef),
    false,
  );
  assert.equal(
    externalChats.chats.some((c) => c.targetRef === publicRef),
    true,
  );

  await assert.rejects(
    () =>
      readChatWindowTool
        .bind(makeCtx(services, ids, externalActor))
        .execute({ targetRef: internalRef }),
    /无权跨群/,
  );
  await assert.rejects(
    () =>
      readChatWindowTool
        .bind(makeCtx(services, ids, externalInInternalActor))
        .execute({}),
    /内部工作群/,
  );

  const memberInternalRead = (await readChatWindowTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({ targetRef: internalRef })) as { count: number };

  assert.equal(memberInternalRead.count, 1);

  // qq_directory blocks external users from enumerating groups/friends.
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
        .bind(makeCtx(gwServices, ids, externalActor))
        .execute({ scope: "groups" }),
    /无权查询/,
  );
  await assert.rejects(
    () =>
      qqDirectoryTool
        .bind(makeCtx(gwServices, ids, externalActor))
        .execute({ scope: "friends" }),
    /无权查询/,
  );

  // 2) Memory guards: global (admin/manager), chat (admitted in current chat), user (self or admin).
  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, externalActor)).execute({
        action: "upsert",
        scope: "global",
        key: "k1",
        content: "bad",
      }),
    /全局记忆/,
  );
  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, memberActor)).execute({
        action: "upsert",
        scope: "global",
        key: "k1",
        content: "bad",
      }),
    /全局记忆/,
  );
  const managerGlobal = (await memoryManageTool
    .bind(makeCtx(services, ids, managerActor))
    .execute({
      action: "upsert",
      scope: "global",
      key: "k1",
      summary: "共识",
      content: "有效全局记忆",
    })) as { mutated: boolean };

  assert.equal(managerGlobal.mutated, true);

  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, externalActor)).execute({
        action: "upsert",
        scope: "chat",
        key: "c1",
        content: "bad",
      }),
    /网协在籍成员/,
  );
  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, memberActor)).execute({
        action: "upsert",
        scope: "chat",
        targetRef: internalRef,
        key: "c1",
        content: "cross",
      }),
    /禁止跨会话/,
  );
  const memberChatMem = (await memoryManageTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({
      action: "upsert",
      scope: "chat",
      key: "c1",
      summary: "本群约定",
      content: "周五例会",
    })) as { mutated: boolean };

  assert.equal(memberChatMem.mutated, true);

  await assert.rejects(
    () =>
      memoryManageTool.bind(makeCtx(services, ids, externalActor)).execute({
        action: "upsert",
        scope: "user",
        userRef: otherUserRef,
        key: "u1",
        content: "tamper",
      }),
    /本人的个人记忆/,
  );
  const selfUserMem = (await memoryManageTool
    .bind(makeCtx(services, ids, externalActor))
    .execute({
      action: "upsert",
      scope: "user",
      userRef: externalUserRef,
      key: "u1",
      summary: "偏好",
      content: "喜欢简短回复",
    })) as { mutated: boolean };

  assert.equal(selfUserMem.mutated, true);

  // 3) Schedule guards: external denied, member scoped to current chat & >= 5m interval.
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, externalActor)).execute({
        action: "create",
        title: "外部定时",
        content: "ping",
        schedule: { kind: "interval", everyMinutes: 30 },
      }),
    /无权创建/,
  );
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, memberActor)).execute({
        action: "create",
        title: "高频刷屏",
        content: "spam",
        schedule: { kind: "interval", everySeconds: 30 },
      }),
    /不得短于 5 分钟/,
  );
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, memberActor)).execute({
        action: "create",
        title: "跨群提醒",
        content: "hi",
        targetRef: internalRef,
        schedule: { kind: "interval", everyMinutes: 30 },
      }),
    /非管理员禁止为其他群/,
  );

  const memberTaskRes = (await scheduleManageTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({
      action: "create",
      title: "本群提醒",
      content: "开会",
      schedule: { kind: "interval", everyMinutes: 30 },
    })) as { task: { id: string } };

  assert.ok(memberTaskRes.task.id);

  const adminOtherTaskRes = (await scheduleManageTool
    .bind(makeCtx(services, ids, adminActor))
    .execute({
      action: "create",
      title: "内部群提醒",
      content: "值班",
      targetRef: internalRef,
      schedule: { kind: "interval", everySeconds: 10 },
    })) as { task: { id: string } };

  // Member cannot list, update, or delete another chat's task.
  const memberListed = (await scheduleManageTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({ action: "list" })) as { tasks: { id: string }[] };

  assert.deepEqual(
    memberListed.tasks.map((task) => task.id),
    [memberTaskRes.task.id],
  );
  await assert.rejects(
    () =>
      scheduleManageTool.bind(makeCtx(services, ids, memberActor)).execute({
        action: "delete",
        id: adminOtherTaskRes.task.id,
      }),
    /禁止删除其他会话/,
  );

  // 4) Workspace notebook writes & MCP tools blocked for external, allowed for members.
  await assert.rejects(
    () =>
      notebookWriteTool
        .bind(makeCtx(services, ids, externalActor))
        .execute({ path: "hack.md", content: "nope" }),
    /仅网协在籍成员或管理员/,
  );
  await assert.rejects(
    () =>
      notebookDeleteTool
        .bind(makeCtx(services, ids, externalActor))
        .execute({ path: "hack.md" }),
    /仅网协在籍成员或管理员/,
  );
  assert.deepEqual(
    mcpToolsSource.resolve(makeCtx(services, ids, externalActor)),
    [],
  );

  await notebookWriteTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({ path: "ok.md", content: "hello" });
  await notebookDeleteTool
    .bind(makeCtx(services, ids, memberActor))
    .execute({ path: "ok.md" });
});

test("knownGroups hides other groups from external users and privateAccessMode gates stranger DMs at L0", async (t) => {
  const capturedPayloads: string[] = [];
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

    capturedPayloads.push(reqJson.messages.at(-1)?.content ?? "");
    res.end(JSON.stringify(chatReply({ units: [] })));
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
      req.url?.includes("/users/sub-member-1/role-mappings/realm/composite")
    ) {
      res.end(JSON.stringify([{ name: "permission-techdept-access" }]));

      return;
    }

    res.end(JSON.stringify([]));
  }, t);

  const { app } = await createTestBerryApp(
    {
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
      keycloakAdminUrl: `${kcStub.url}/admin/realms/bitnp`,
      oidcIssuer: `${kcStub.url}/realms/bitnp`,
      keycloakClientId: "berry",
      keycloakClientSecret: "secret",
    },
    {
      policy: {
        adminQQs: ["10001"],
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
    triggerMode: "mention_only",
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "200",
    title: "机密内部群",
    enabled: true,
    triggerMode: "smart_observe",
    internal: true,
  });

  // External user invoke in group:100 should NOT see group:200 in knownGroups.
  const extMsg = await captureText(app, {
    kind: "group",
    chatId: "100",
    id: "ob-ext-1",
    userId: "50005",
    senderName: "路人",
    text: "你好",
    mentionedBot: true,
  });

  await app.agent.invoke({
    source: "qq_batch",
    chatKey: "group:100",
    kind: "group",
    chatId: "100",
    triggerMessageIds: [extMsg.message.id],
    senderId: "50005",
    senderName: "路人",
  });

  const payloadJson = capturedPayloads[0] ?? "";

  assert.doesNotMatch(payloadJson, /机密内部群/);
  assert.match(payloadJson, /"role":"external"/);

  // Stranger DM is ignored at L0 without queueing a gate_batch job.
  const strangerDm = await captureText(app, {
    kind: "private",
    chatId: "50005",
    id: "ob-stranger-dm",
    userId: "50005",
    senderName: "陌生人",
    text: "套话测试",
  });

  await app.gate.ingest(strangerDm.message);
  const strangerJobs = await app.store.jobs.list({ chatKey: "private:50005" });

  assert.equal(strangerJobs.length, 0);
  const strangerDecisions = await app.store.gate.list({
    chatKey: "private:50005",
    limit: 5,
  });

  assert.equal(strangerDecisions.items[0]?.action, "ignore");
  assert.equal(strangerDecisions.items[0]?.stage, "l0_rule");

  // Admitted member DM passes L0 under members_and_admins.
  const memberDm = await captureText(app, {
    kind: "private",
    chatId: "30001",
    id: "ob-member-dm",
    userId: "30001",
    senderName: "网协成员",
    text: "帮我查一下排班",
  });

  await app.gate.ingest(memberDm.message);
  const memberJobs = await app.store.jobs.list({ chatKey: "private:30001" });

  assert.equal(memberJobs.length, 1);

  // Under admins_only, admitted non-admin member DM is also ignored at L0, while admin passes.
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
  assert.match(memberDecisions.items[0]?.reason ?? "", /仅管理员/);

  const adminDm = await captureText(app, {
    kind: "private",
    chatId: "10001",
    id: "ob-admin-dm",
    userId: "10001",
    senderName: "管理员",
    text: "检查状态",
  });

  await app.gate.ingest(adminDm.message);
  const adminJobs = await app.store.jobs.list({ chatKey: "private:10001" });

  assert.equal(adminJobs.length, 1);
});
