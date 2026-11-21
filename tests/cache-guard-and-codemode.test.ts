import assert from "node:assert/strict";
import test from "node:test";

import {
  DialogCacheGuard,
  makeCacheSessionKey,
} from "../src/agent/cache-guard.ts";
import { createReadonlyBindings } from "../src/agent/codemode/bindings.ts";
import { runReadonlyScript } from "../src/agent/codemode/sandbox.ts";
import { ModelIds } from "../src/agent/model-ids.ts";
import type { ToolContext } from "../src/tools/types.ts";
import {
  captureText,
  chatReply,
  chatToolCalls,
  createTestBerryApp,
  startStubServer,
} from "./helpers.ts";

test("DialogCacheGuard detects tools/system/history mutations and low hit rate without false alarms on append or baseline switch", async (t) => {
  const guard = new DialogCacheGuard();
  const baseTools = [
    {
      type: "function" as const,
      function: { name: "memory_manage", parameters: {} },
    },
  ];
  const s1 = makeCacheSessionKey("sess-1", "");
  const t0 = 1_700_000_000_000;

  // 1) First turn establishes baseline without warning.
  const c1 = guard.inspect({
    purpose: "dialog",
    sessionKey: s1,
    messages: [
      { role: "system", content: "STATIC_SYS" },
      { role: "user", content: "TURN_1_TRANSIENT_ENVELOPE" },
    ],
    tools: baseTools,
    transientUserIndex: 0,
  });

  assert.equal(
    c1?.commit({ inputTokens: 3000, cachedInputTokens: 0, now: t0 }),
    null,
  );

  // 2) Next turn strips only the prior transient user envelope (index 0) and appends assistant + new user: no warning.
  const c2 = guard.inspect({
    purpose: "dialog",
    sessionKey: s1,
    messages: [
      { role: "system", content: "STATIC_SYS" },
      { role: "user", content: "TURN_1_CLEAN" },
      { role: "assistant", content: '{"units":[]}' },
      { role: "user", content: "TURN_2_TRANSIENT" },
    ],
    tools: baseTools,
    transientUserIndex: 2,
  });

  assert.equal(
    c2?.commit({
      inputTokens: 3000,
      cachedInputTokens: 2100,
      now: t0 + 10_000,
    }),
    null,
  );

  // 3) Same prefix, but low cache hit rate (< 30%) within 5 minutes -> warns.
  const c3 = guard.inspect({
    purpose: "dialog",
    sessionKey: s1,
    messages: [
      { role: "system", content: "STATIC_SYS" },
      { role: "user", content: "TURN_1_CLEAN" },
      { role: "assistant", content: '{"units":[]}' },
      { role: "user", content: "TURN_2_CLEAN" },
      { role: "assistant", content: '{"units":[]}' },
      { role: "user", content: "TURN_3_TRANSIENT" },
    ],
    tools: baseTools,
    transientUserIndex: 4,
  });
  const lowHitWarn = c3?.commit({
    inputTokens: 4000,
    cachedInputTokens: 400,
    now: t0 + 20_000,
  });

  assert.match(lowHitWarn ?? "", /前缀未变但缓存命中率偏低（10%）/);

  // 4) Mutating tools, system prompt, and an earlier history message all report specific reasons.
  const c4 = guard.inspect({
    purpose: "dialog",
    sessionKey: s1,
    messages: [
      { role: "system", content: "CHANGED_SYS" },
      { role: "user", content: "TAMPERED_TURN_1" },
      { role: "assistant", content: '{"units":[]}' },
      { role: "user", content: "TURN_2_CLEAN" },
      { role: "assistant", content: '{"units":[]}' },
      { role: "user", content: "TURN_3_CLEAN" },
    ],
    tools: [
      ...baseTools,
      {
        type: "function" as const,
        function: { name: "extra_tool", parameters: {} },
      },
    ],
    transientUserIndex: 5,
  });
  const mutatedWarn = c4?.commit({
    inputTokens: 4000,
    cachedInputTokens: 200,
    now: t0 + 30_000,
  });

  assert.match(mutatedWarn ?? "", /tools 定义发生变化/);
  assert.match(mutatedWarn ?? "", /system 提示词发生变化/);
  assert.match(mutatedWarn ?? "", /历史消息 #0 发生非追加修改/);
  assert.match(mutatedWarn ?? "", /缓存命中率偏低（5%）/);

  // 5) Baseline switch (#NEW# reset or compaction changing sessionKey) does NOT false alarm.
  const s2 = makeCacheSessionKey("sess-2", "compacted-summary");
  const c5 = guard.inspect({
    purpose: "dialog",
    sessionKey: s2,
    messages: [
      { role: "system", content: "STATIC_SYS" },
      { role: "user", content: "FRESH_TURN" },
    ],
    tools: baseTools,
    transientUserIndex: 0,
  });

  assert.equal(
    c5?.commit({ inputTokens: 3000, cachedInputTokens: 0, now: t0 + 40_000 }),
    null,
  );

  // 6) Non-dialog purposes are ignored.
  assert.equal(
    guard.inspect({
      purpose: "subagent:code_analyst",
      sessionKey: s2,
      messages: [{ role: "user", content: "hi" }],
    }),
    null,
  );

  // 7) UsageStore persists cacheWarning and exposes it via /api/admin/llm-calls.
  const { app } = await createTestBerryApp({ devAuthBypass: true }, {}, t);

  await app.store.usage.record({
    purpose: "dialog",
    model: "test-model",
    chatKey: "group:1",
    inputTokens: 4096,
    cachedInputTokens: 100,
    outputTokens: 32,
    durationMs: 120,
    cacheWarning: "前缀未变但缓存命中率偏低（2%）",
  });

  const { url } = await app.listen();
  const res = (await (
    await fetch(`${url}/api/admin/llm-calls?purpose=dialog`)
  ).json()) as { items: { cacheWarning: string | null }[] };

  assert.equal(res.items[0]?.cacheWarning, "前缀未变但缓存命中率偏低（2%）");
});

test("QuickJS sandbox enforces timeout, microtask loop, memory limit, host call cap, output cap, and isolation", async (t) => {
  // 1) Sync infinite loop interrupted.
  await assert.rejects(
    () =>
      runReadonlyScript({
        code: "while (true) {}",
        bindings: {},
        timeoutMs: 150,
      }),
    /超时/,
  );

  // 2) Microtask infinite loop interrupted cleanly.
  await assert.rejects(
    () =>
      runReadonlyScript({
        code: `
          function spin() {
            return Promise.resolve().then(spin);
          }
          return await spin();
        `,
        bindings: {},
        timeoutMs: 150,
      }),
    /超时|微任务/,
  );

  // 3) Memory limit catches oversized JS heap allocation without crashing Node.
  await assert.rejects(
    () =>
      runReadonlyScript({
        code: `
          const chunks = [];
          for (let i = 0; i < 500000; i++) {
            chunks.push({ i, s: "abcdefghij" + i });
          }
          return chunks.length;
        `,
        bindings: {},
        timeoutMs: 2000,
        maxMemoryBytes: 4 * 1024 * 1024,
      }),
    /out of memory/i,
  );

  // 4) Host call cap rejects calls beyond limit (30).
  await assert.rejects(
    () =>
      runReadonlyScript({
        code: `
          for (let i = 0; i < 35; i++) {
            await api.demo.ping(i);
          }
          return "done";
        `,
        bindings: {
          demo: {
            ping: async (n: unknown) => n,
          },
        },
        maxHostCalls: 30,
      }),
    /宿主调用上限/,
  );

  // 5) Output size cap (> 16 KiB) rejected.
  await assert.rejects(
    () =>
      runReadonlyScript({
        code: `return { big: "a".repeat(20000) };`,
        bindings: {},
        maxOutputBytes: 16_384,
      }),
    /超过上限/,
  );

  // 6) Host globals (process / fetch) are absent in QuickJS.
  const isolation = await runReadonlyScript({
    code: `
      console.log("checking globals");
      return {
        hasProcess: typeof process !== "undefined",
        hasFetch: typeof fetch !== "undefined",
        hasRequire: typeof require !== "undefined",
      };
    `,
    bindings: {},
  });

  assert.deepEqual(isolation.result, {
    hasProcess: false,
    hasFetch: false,
    hasRequire: false,
  });
  assert.deepEqual(isolation.logs, ["checking globals"]);

  // 7) Bindings enforce cross-group access and Keycloak binding inside sandbox scripts.
  const { app } = await createTestBerryApp(
    {
      guildApiUrl: "http://127.0.0.1:9",
      guildInternalToken: "tok",
    },
    {},
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "100",
    title: "本群",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "200",
    title: "他群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const ids = new ModelIds();
  const otherGroupRef = ids.groupRef("200");
  const guestCtx: ToolContext = {
    services: {
      store: app.store,
      gateway: app.gateway,
      media: app.media,
      bunko: app.bunko,
      shortlink: app.shortlink,
      directory: app.directory,
      guild: app.guild,
      mcp: app.mcp,
      getSettings: () => app.settings,
    },
    actor: {
      chatKey: "group:100",
      senderQQ: "55555",
      actorSubject: null,
      actorName: "路人",
      role: "guest",
    },
    ids,
  };
  const guestBindings = createReadonlyBindings(guestCtx);

  await assert.rejects(
    () =>
      runReadonlyScript({
        code: `return await api.chats.window({ targetRef: ${JSON.stringify(otherGroupRef)} });`,
        bindings: guestBindings,
      }),
    /仅管理员或网协管理层可跨群/,
  );

  await assert.rejects(
    () =>
      runReadonlyScript({
        code: "return await api.guild.listTree();",
        bindings: guestBindings,
      }),
    /尚未在网协通行证绑定 QQ 号/,
  );
});

test("code_analyst subagent aggregates multi-node guild and chat data concurrently in a single script round", async (t) => {
  let scriptRounds = 0;

  const guildStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/internal/nodes" && req.method === "GET") {
      res.end(
        JSON.stringify([
          {
            id: 10,
            parentId: null,
            title: "项目 A",
            description: "",
            dueAt: null,
            completedAt: null,
            tags: [],
            sortOrder: 0,
            childCount: 0,
            commentCount: 2,
            myRelation: "leader",
            updatedAt: "2026-11-21T00:00:00Z",
          },
          {
            id: 20,
            parentId: null,
            title: "项目 B",
            description: "",
            dueAt: null,
            completedAt: null,
            tags: [],
            sortOrder: 1,
            childCount: 0,
            commentCount: 1,
            myRelation: "leader",
            updatedAt: "2026-11-21T00:00:00Z",
          },
          {
            id: 30,
            parentId: null,
            title: "项目 C",
            description: "",
            dueAt: null,
            completedAt: "2026-11-20T00:00:00Z",
            tags: [],
            sortOrder: 2,
            childCount: 0,
            commentCount: 0,
            myRelation: "member",
            updatedAt: "2026-11-20T00:00:00Z",
          },
        ]),
      );

      return;
    }

    const nodeMatch = /^\/api\/internal\/nodes\/(\d+)$/.exec(req.url ?? "");

    if (nodeMatch) {
      const id = Number(nodeMatch[1]);
      const leaderMap: Record<number, string> = {
        10: "Alice",
        20: "Alice",
        30: "Bob",
      };

      res.end(
        JSON.stringify({
          id,
          parentId: null,
          title: `项目 #${id}`,
          description: "",
          dueAt: null,
          completedAt: id === 30 ? "2026-11-20T00:00:00Z" : null,
          tags: [],
          sortOrder: 0,
          createdBySubject: "sub-admin",
          breadcrumb: [],
          directLeaders: [
            { subject: `sub-${id}`, displayName: leaderMap[id] ?? "Unknown" },
          ],
          directMembers: [],
          children: [],
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
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
    const toolMsgs = reqJson.messages.filter((m) => m.role === "tool");

    if (toolMsgs.length === 0) {
      scriptRounds++;
      res.end(
        JSON.stringify(
          chatToolCalls([
            {
              id: "call-code-1",
              name: "run_readonly_script",
              args: {
                code: `
                  const [tree, chats] = await Promise.all([
                    api.guild.listTree(),
                    api.chats.list(),
                  ]);
                  const details = await Promise.all(
                    tree.roots.map((n) => api.guild.getNode(n.id)),
                  );
                  const byLeader = {};
                  for (const node of details) {
                    for (const l of node.directLeaders) {
                      byLeader[l.displayName] = (byLeader[l.displayName] || 0) + 1;
                    }
                  }
                  const chatCounts = await Promise.all(
                    chats.chats.map((c) => api.chats.search({ targetRef: c.targetRef, limit: 20 })),
                  );
                  return {
                    totalNodes: details.length,
                    byLeader,
                    totalMessages: chatCounts.reduce((acc, r) => acc + r.count, 0),
                  };
                `,
              },
            },
          ]),
        ),
      );

      return;
    }

    const toolOutput = JSON.parse(toolMsgs.at(-1)?.content ?? "{}") as {
      ok: boolean;
      result?: {
        result: {
          totalNodes: number;
          byLeader: Record<string, number>;
          totalMessages: number;
        };
        hostCalls: number;
      };
    };

    assert.equal(toolOutput.ok, true);
    assert.deepEqual(toolOutput.result?.result, {
      totalNodes: 3,
      byLeader: { Alice: 2, Bob: 1 },
      totalMessages: 2,
    });
    assert.equal(toolOutput.result?.hostCalls, 7);

    res.end(
      JSON.stringify(
        chatReply({
          brief:
            "共统计 3 个公会节点（Alice 负责 2 个、Bob 负责 1 个）及 2 条群消息。",
          references: ["guild", "chats"],
        }),
      ),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      guildApiUrl: guildStub.url,
      guildInternalToken: "guild-secret",
      mainBaseUrl: `${llmStub.url}/v1`,
    },
    {},
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "101",
    title: "群一",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await app.store.chats.upsert({
    kind: "group",
    chatId: "102",
    title: "群二",
    enabled: true,
    triggerMode: "smart_observe",
  });
  await captureText(app, {
    kind: "group",
    chatId: "101",
    id: "c1",
    userId: "1",
    senderName: "Alice",
    text: "群一消息",
  });
  await captureText(app, {
    kind: "group",
    chatId: "102",
    id: "c2",
    userId: "2",
    senderName: "Bob",
    text: "群二消息",
  });

  const result = await app.subagents.run(
    "code_analyst",
    "统计所有公会节点按负责人分组计数以及全部群消息总数",
    {
      services: {
        store: app.store,
        gateway: app.gateway,
        media: app.media,
        bunko: app.bunko,
        shortlink: app.shortlink,
        directory: app.directory,
        guild: app.guild,
        mcp: app.mcp,
        getSettings: () => app.settings,
      },
      actor: {
        chatKey: "group:101",
        senderQQ: "10001",
        actorSubject: "sub-admin",
        actorName: "管理员",
        role: "admin",
      },
      ids: new ModelIds(),
    },
  );

  assert.equal(scriptRounds, 1);
  assert.match(result.brief, /Alice 负责 2 个/);
  assert.equal(result.mutated, false);
  assert.ok(result.sidecarId);
});
