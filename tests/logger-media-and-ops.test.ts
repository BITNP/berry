import assert from "node:assert/strict";
import test from "node:test";

import {
  qfaceName,
  resolveReactionEmojiId,
  searchQFaceCatalog,
} from "../src/gateway/qface.ts";
import { parseOneBotSegments } from "../src/gateway/segments.ts";
import { previousNaturalWeek } from "../src/guild/automation.ts";
import { computeNextRunAt } from "../src/store/schedules.ts";
import { Logger, formatPrettyLogLine } from "../src/utils/logger.ts";
import { captureText, createTestBerryApp, startStubServer } from "./helpers.ts";

test("Pino LogHub redaction, level/scope filtering, and clear endpoint", async (t) => {
  const { app } = await createTestBerryApp(
    {
      devAuthBypass: true,
      gatewayToken: "gw-super-secret-xyz",
    },
    {},
    t,
  );

  app.logs.clear();
  const logger = new Logger("ops-test");

  logger.info("Connected with token gw-super-secret-xyz", {
    apiKey: "test-main-key",
    host: "127.0.0.1",
  });
  logger.warn("Gateway timeout warning", { retries: 2 });

  const { items } = app.logs.list({ scope: "ops-test" });

  assert.equal(items.length, 2);
  assert.equal(items[0]!.message.includes("gw-super-secret-xyz"), false);
  assert.ok(items[0]!.message.includes("[已脱敏]"));
  assert.equal(items[0]!.context.apiKey, "[已脱敏]");

  const { url } = await app.listen();
  const listRes = await fetch(
    `${url}/api/admin/logs?level=warn&scope=ops-test`,
  );

  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as {
    items: { level: string; message: string }[];
  };

  assert.equal(listJson.items.length, 1);
  assert.equal(listJson.items[0]!.level, "warn");

  const statusJson = (await (await fetch(`${url}/api/auth/status`)).json()) as {
    csrfToken?: string;
  };
  const clearRes = await fetch(`${url}/api/admin/logs/clear`, {
    method: "POST",
    headers: { "X-CSRF-Token": statusJson.csrfToken ?? "" },
  });

  assert.equal(clearRes.status, 200);
  assert.equal(app.logs.list().items.length, 0);

  // Pretty formatter aligns columns, formats inline key=value pairs, and renders error sub-lines.
  const prettyLine = formatPrettyLogLine(
    {
      time: Date.UTC(2026, 10, 21, 1, 2, 3, 45),
      level: "error",
      scope: "gateway",
      message: "Delivery failed",
      context: { deliveryId: 7, retry: false, error: "timeout\nat line 2" },
    },
    false,
  );

  assert.match(prettyLine, /ERR\s+gateway\s+Delivery failed/);
  assert.match(prettyLine, /deliveryId=7/);
  assert.match(prettyLine, /retry=false/);
  assert.match(prettyLine, /└─ timeout/);
  assert.match(prettyLine, /at line 2/);
});

test("QFace, JSON card parsing, emoji_like notice, qq_reaction dispatch, pause, and backfill", async (t) => {
  const gatewayCalls: { path: string; body: unknown }[] = [];
  const gatewayStub = await startStubServer((req, res, bodyText) => {
    gatewayCalls.push({
      path: req.url ?? "",
      body: bodyText ? JSON.parse(bodyText) : {},
    });
    res.setHeader("Content-Type", "application/json");

    if (req.url?.includes("/get_group_msg_history")) {
      res.end(
        JSON.stringify({
          status: "ok",
          data: {
            messages: [
              {
                message_id: "hist-1",
                user_id: 20_002,
                time: 1_700_000_010,
                message: "[CQ:face,id=76] 历史消息",
                sender: { card: "老群友" },
              },
            ],
          },
        }),
      );

      return;
    }

    res.end(JSON.stringify({ status: "ok", data: {} }));
  }, t);

  const { app } = await createTestBerryApp(
    {
      devAuthBypass: true,
      gatewayUrl: gatewayStub.url,
      gatewayAccount: "qq-bot",
      gatewayToken: "gw-token",
    },
    {},
    t,
  );

  const jsonCard = JSON.stringify({
    meta: {
      news: {
        title: "BITNP 纳新公告",
        desc: "欢迎加入网协",
        jumpUrl: "https://bitnp.net/join",
      },
    },
  });
  const parsed = parseOneBotSegments(
    [
      { type: "at", data: { qq: "999999" } },
      { type: "text", data: { text: " " } },
      { type: "face", data: { id: "76" } },
      { type: "text", data: { text: " 看这个 " } },
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " " } },
      { type: "json", data: { data: jsonCard } },
    ],
    "999999",
  );

  assert.equal(parsed.mentionedBot, true);
  assert.ok(parsed.text.includes("@树莓娘"));
  assert.equal(parsed.text.includes("@999999"), false);
  assert.ok(parsed.text.includes("@12345"));
  assert.ok(parsed.text.includes("[表情: 赞]"));
  assert.ok(parsed.text.includes("BITNP 纳新公告"));
  assert.ok(parsed.text.includes("https://bitnp.net/join"));

  await captureText(app, {
    kind: "group",
    chatId: "555666",
    id: "ob-react-1",
    userId: "10001",
    senderName: "测试君",
    text: "好耶",
  });

  await app.gatewayEvents.handleEvent({
    post_type: "notice",
    notice_type: "group_msg_emoji_like",
    group_id: 555_666,
    user_id: 20_001,
    message_id: "ob-react-1",
    is_add: true,
    likes: [{ emoji_id: 76, count: 1 }],
  });

  const reactionMap = await app.store.reactions.aggregateForMessages(
    "group:555666",
    ["ob-react-1"],
  );
  const agg = reactionMap.get("ob-react-1") ?? [];

  assert.equal(agg.length, 1);
  assert.equal(agg[0]!.emojiName, "赞");
  assert.equal(agg[0]!.count, 1);

  const delivery = await app.gateway.dispatchUnit(
    "group:555666",
    {
      kind: "qq_reaction",
      messageId: "ob-react-1",
      emojiId: "㊗️",
    },
    "999999",
  );

  assert.equal(delivery.status, "sent");
  const reactionCall = gatewayCalls.find((c) =>
    c.path.endsWith("/set_msg_emoji_like"),
  );

  assert.ok(reactionCall);
  assert.equal((reactionCall.body as { emoji_id?: string }).emoji_id, "12951");

  // QQNT catalog & Unicode codepoint resolution.
  assert.equal(qfaceName("12951"), "㊗️");
  assert.equal(qfaceName("478"), "对的对的");
  assert.equal(qfaceName("179"), "doge");
  assert.equal(resolveReactionEmojiId("㊗️"), "12951");
  assert.equal(resolveReactionEmojiId("❤️"), "10084");
  assert.equal(resolveReactionEmojiId("👍"), "128077");
  assert.equal(resolveReactionEmojiId("对的对的"), "478");
  assert.equal(resolveReactionEmojiId("狗头"), "179");
  assert.equal(resolveReactionEmojiId("76"), "76");
  assert.equal(resolveReactionEmojiId("12951"), "12951");
  assert.throws(() => resolveReactionEmojiId("99999999"), /未知的表情数字 ID/);
  assert.throws(() => resolveReactionEmojiId("99999"), /未知的表情数字 ID/);
  assert.throws(() => resolveReactionEmojiId("不存在的乱码文字"), /无法识别/);

  const searchRes = searchQFaceCatalog("西格玛");

  assert.ok(searchRes.items.some((item) => item.id === "469"));
  assert.equal(searchQFaceCatalog("㊗️").resolvedUnicodeId, "12951");

  const { url } = await app.listen();
  const { csrfToken } = (await (
    await fetch(`${url}/api/auth/status`)
  ).json()) as { csrfToken: string };

  const pauseRes = await fetch(`${url}/api/admin/bot/state`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ paused: true }),
  });

  assert.equal(pauseRes.status, 200);
  assert.equal(app.settings.bot.paused, true);

  const pausedEvent = await app.gatewayEvents.handleEvent({
    post_type: "message",
    message_type: "group",
    group_id: 555_666,
    user_id: 10_002,
    message_id: "ob-paused-1",
    time: 1_700_000_200,
    message: "[CQ:at,qq=999999] 在吗？",
    sender: { card: "小王" },
  });

  assert.equal(pausedEvent.accepted, true);
  assert.ok(
    await app.store.messages.findByOnebotId("group:555666", "ob-paused-1"),
  );
  assert.equal(await app.store.jobs.countPending(), 0);

  const backfill = (await (
    await fetch(`${url}/api/admin/chats/group%3A555666/backfill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ count: 20 }),
    })
  ).json()) as { total: number; imported: number };

  assert.equal(backfill.total, 1);
  assert.equal(backfill.imported, 1);

  const repeat = (await (
    await fetch(`${url}/api/admin/chats/group%3A555666/backfill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ count: 20 }),
    })
  ).json()) as { imported: number };

  assert.equal(repeat.imported, 0);
});

test("MaintenanceStore.purgeOldData preserves memory-referenced messages", async (t) => {
  const { app } = await createTestBerryApp({}, {}, t);
  const oldTs = Date.now() - 45 * 86_400_000;

  const { message: referenced } = await captureText(app, {
    kind: "group",
    chatId: "888",
    id: "old-keep",
    userId: "1",
    senderName: "甲",
    text: "记住这条服务器密码规则",
    sentAt: oldTs,
  });

  const { message: disposable } = await captureText(app, {
    kind: "group",
    chatId: "888",
    id: "old-drop",
    userId: "2",
    senderName: "乙",
    text: "水群消息",
    sentAt: oldTs,
  });

  await app.store.memories.upsert({
    scope: "chat",
    ownerId: "group:888",
    key: "rule",
    summary: "引用测试",
    content: "重要规定",
    sourceMessageId: referenced.id,
  });
  await app.store.gate.record({
    chatKey: "group:888",
    messageId: disposable.id,
    action: "ignore",
    stage: "l1_classifier",
    confidence: 0.9,
    reason: "闲聊",
    model: "gpt-test",
    durationMs: 20,
    createdAt: oldTs,
  });

  const purged = await app.store.maintenance.purgeOldData(30);

  assert.equal(purged.deletedMessages, 1);
  assert.equal(purged.deletedDecisions, 1);
  assert.ok(await app.store.messages.findByOnebotId("group:888", "old-keep"));
  assert.equal(
    await app.store.messages.findByOnebotId("group:888", "old-drop"),
    null,
  );
});

test("computeNextRunAt and previousNaturalWeek handle DST/leap-year/boundary rules", () => {
  const beforeNineMs = Date.parse("2026-11-19T08:59:59+08:00");
  const atNineMs = Date.parse("2026-11-19T09:00:00+08:00");
  const afterNineMs = Date.parse("2026-11-19T09:00:00.500+08:00");

  assert.equal(
    computeNextRunAt({ kind: "daily", time: "09:00" }, beforeNineMs),
    atNineMs,
  );
  assert.equal(
    computeNextRunAt({ kind: "daily", time: "09:00" }, atNineMs),
    Date.parse("2026-11-20T09:00:00+08:00"),
  );
  assert.equal(
    computeNextRunAt({ kind: "daily", time: "09:00" }, afterNineMs),
    Date.parse("2026-11-20T09:00:00+08:00"),
  );
  assert.equal(
    computeNextRunAt(
      { kind: "weekly", weekdays: ["mon", "fri"], time: "18:30" },
      beforeNineMs,
    ),
    Date.parse("2026-11-20T18:30:00+08:00"),
  );
  assert.equal(
    computeNextRunAt(
      { kind: "monthly", daysOfMonth: [1, 15], time: "10:00" },
      beforeNineMs,
    ),
    Date.parse("2026-12-01T10:00:00+08:00"),
  );
  assert.equal(
    computeNextRunAt(
      { kind: "yearly", month: 2, day: 29, time: "09:00" },
      beforeNineMs,
    ),
    Date.parse("2028-02-29T09:00:00+08:00"),
  );
  assert.equal(
    computeNextRunAt(
      { kind: "yearly", month: 2, day: 30, time: "09:00" },
      beforeNineMs,
    ),
    null,
  );

  const week = previousNaturalWeek(Date.parse("2026-11-19T12:00:00+08:00"));

  assert.equal(week.label, "2026-11-09");
  assert.equal(week.start.toISOString(), "2026-11-08T16:00:00.000Z");
  assert.equal(week.end.toISOString(), "2026-11-15T16:00:00.000Z");
});

test("MediaProcessor detects MIME via file-type magic bytes rather than headers", async (t) => {
  const minimalPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=",
    "base64",
  );
  const mediaStub = await startStubServer((req, res) => {
    if (req.url === "/valid.png") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(minimalPng);

      return;
    }

    res.setHeader("Content-Type", "image/png");
    res.end("not-real-png-bytes");
  }, t);

  const { app } = await createTestBerryApp(
    {},
    { media: { autoAnalyzeImages: false } },
    t,
  );

  const capOk = await captureText(app, {
    kind: "group",
    chatId: "901",
    id: "img-ok",
    userId: "101",
    senderName: "测试",
    text: "[图片]",
  });
  const capBad = await captureText(app, {
    kind: "group",
    chatId: "901",
    id: "img-bad",
    userId: "101",
    senderName: "测试",
    text: "[图片]",
  });

  await app.media.enqueueMessageAssets(capOk.message, [
    { kind: "image", rawUrl: `${mediaStub.url}/valid.png`, name: "" },
  ]);
  await app.media.enqueueMessageAssets(capBad.message, [
    { kind: "image", rawUrl: `${mediaStub.url}/bad.bin`, name: "" },
  ]);
  await app.media.waitForMessages([capOk.message.id, capBad.message.id]);

  const assetsMap = await app.store.assets.listForMessages([
    capOk.message.id,
    capBad.message.id,
  ]);
  const okAsset = assetsMap.get(capOk.message.id)?.[0];
  const badAsset = assetsMap.get(capBad.message.id)?.[0];

  assert.equal(okAsset?.status, "ready");
  assert.equal(okAsset?.mimeType, "image/png");
  assert.match(okAsset?.filePath ?? "", /\.png$/);

  assert.equal(badAsset?.status, "failed");
  assert.match(badAsset?.error ?? "", /不支持的图片格式/);
});

test("automatic history warm-up, backward pagination, and chronological ordering", async (t) => {
  const historyCalls: Record<string, unknown>[] = [];
  const tOldest = Date.UTC(2026, 10, 18, 10, 0, 0);
  const tOlder = Date.UTC(2026, 10, 19, 10, 0, 0);
  const tRecent = Date.UTC(2026, 10, 20, 10, 0, 0);
  const tLive = Date.UTC(2026, 10, 21, 1, 50, 0);

  const gwStub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    const action = req.url?.split("/").pop() ?? "";
    const body = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    if (action === "get_group_msg_history") {
      historyCalls.push(body);
      const seq = body.message_seq;

      if (seq === undefined) {
        res.end(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: {
              messages: [
                {
                  message_id: 2001,
                  message_seq: 2001,
                  user_id: 201,
                  time: Math.floor(tRecent / 1000),
                  message: [{ type: "text", data: { text: "网关限流讨论" } }],
                  sender: { card: "同学A" },
                },
              ],
            },
          }),
        );

        return;
      }

      if (Number(seq) === 2001 && body.reverseOrder === true) {
        res.end(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: {
              messages: [
                {
                  message_id: 1001,
                  message_seq: 1001,
                  user_id: 202,
                  time: Math.floor(tOlder / 1000),
                  message: [{ type: "text", data: { text: "云文档压测安排" } }],
                  sender: { card: "同学B" },
                },
                {
                  message_id: 2001,
                  message_seq: 2001,
                  user_id: 201,
                  time: Math.floor(tRecent / 1000),
                  message: [{ type: "text", data: { text: "网关限流讨论" } }],
                  sender: { card: "同学A" },
                },
              ],
            },
          }),
        );

        return;
      }

      if (Number(seq) === 1001 && body.reverseOrder === true) {
        res.end(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: {
              messages: [
                {
                  message_id: 900,
                  message_seq: 900,
                  user_id: 203,
                  time: Math.floor(tOldest / 1000),
                  message: [
                    { type: "text", data: { text: "字体吐槽思源黑体" } },
                  ],
                  sender: { card: "同学C" },
                },
              ],
            },
          }),
        );

        return;
      }

      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { messages: [] },
        }),
      );

      return;
    }

    res.end(JSON.stringify({ status: "ok", retcode: 0, data: {} }));
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
    },
    {},
    t,
  );

  // Live message arrives first (smaller auto-increment id, newer sentAt).
  const live = await captureText(app, {
    kind: "group",
    chatId: "777",
    id: "3001",
    userId: "301",
    senderName: "Kat",
    text: "这几天聊了啥",
    sentAt: tLive,
  });

  // Warm-up runs once per chat and deduplicates repeated calls.
  await Promise.all([
    app.gateway.warmChatHistory("group", "777", 100),
    app.gateway.warmChatHistory("group", "777", 100),
  ]);
  await app.gateway.warmChatHistory("group", "777", 100);
  assert.equal(historyCalls.length, 1);

  // Recent context before the live message sees backfilled older message despite larger row id.
  const beforeLive = await app.store.messages.recent("group:777", 10, {
    beforeId: live.message.id,
  });

  assert.deepEqual(
    beforeLive.map((m) => m.text),
    ["网关限流讨论"],
  );

  // Step-back backfill advances to older pages instead of returning 0 forever.
  const step1 = await app.gateway.syncChatHistory("group", "777", {
    count: 200,
    mode: "latest",
    maxPages: 1,
    stepBackIfLatestCached: true,
  });

  assert.equal(step1.imported, 1);

  // Multi-page older sync reaches targetStartTimeMs.
  const older = await app.gateway.syncChatHistory("group", "777", {
    count: 200,
    mode: "older",
    maxPages: 3,
    targetStartTimeMs: tOldest,
  });

  assert.equal(older.imported, 1);
  assert.equal(older.oldestSentAt, tOldest);

  const ordered = await app.store.messages.recent("group:777", 10);

  assert.deepEqual(
    ordered.map((m) => m.text),
    ["字体吐槽思源黑体", "云文档压测安排", "网关限流讨论", "这几天聊了啥"],
  );
});
