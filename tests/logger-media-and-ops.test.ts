import assert from "node:assert/strict";
import test from "node:test";

import { parseOneBotSegments } from "../src/gateway/segments.ts";
import { Logger } from "../src/utils/logger.ts";
import { createTestBerryApp, startStubServer } from "./helpers.ts";

test("Pino LogHub redaction, filtering, SSE stream and /api/admin/logs", async () => {
  const { app, cleanup } = await createTestBerryApp({
    devAuthBypass: true,
    webhookToken: "wh-super-secret-xyz",
  });

  try {
    const seenSseLogs: { scope: string; message: string }[] = [];
    const unsubscribe = app.events.subscribe((ev) => {
      if (ev.type === "log") {
        seenSseLogs.push({
          scope: ev.data.scope,
          message: ev.data.message,
        });
      }
    });

    app.logs.clear();

    const logger = new Logger("ops-test");

    logger.info("Connected with token wh-super-secret-xyz", {
      apiKey: "test-main-key",
      host: "127.0.0.1",
    });
    logger.warn("Gateway timeout warning", { retries: 2 });

    unsubscribe();

    const { items, scopes } = app.logs.list({
      scope: "ops-test",
    });

    assert.equal(items.length, 2);
    assert.ok(scopes.includes("ops-test"));
    assert.equal(
      items[0]!.message.includes("wh-super-secret-xyz"),
      false,
      "Configured secret must be redacted",
    );
    assert.ok(items[0]!.message.includes("[已脱敏]"));
    assert.equal(items[0]!.context.apiKey, "[已脱敏]");

    assert.equal(
      seenSseLogs.some((e) => e.scope === "ops-test"),
      true,
    );

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

    const statusRes = await fetch(`${url}/api/auth/status`);
    const statusJson = (await statusRes.json()) as { csrfToken?: string };

    const clearRes = await fetch(`${url}/api/admin/logs/clear`, {
      method: "POST",
      headers: { "X-CSRF-Token": statusJson.csrfToken ?? "" },
    });

    assert.equal(clearRes.status, 200);
    assert.equal(app.logs.list().items.length, 0);
  } finally {
    await cleanup();
  }
});

test("QFace, JSON card parsing, emoji_like notice, qq_reaction dispatch and pause/backfill", async () => {
  const gatewayCalls: { path: string; body: unknown }[] = [];
  const gatewayStub = await startStubServer((req, res, bodyText) => {
    const parsedBody = bodyText ? JSON.parse(bodyText) : {};

    gatewayCalls.push({ path: req.url ?? "", body: parsedBody });
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
  });

  const { app, cleanup } = await createTestBerryApp({
    devAuthBypass: true,
    gatewayUrl: gatewayStub.url,
    gatewayAccount: "qq-bot",
    gatewayToken: "gw-token",
  });

  try {
    // 1) Parse QFace and JSON share card segments.
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
        { type: "face", data: { id: "76" } },
        { type: "text", data: { text: " 看这个 " } },
        { type: "json", data: { data: jsonCard } },
      ],
      "999999",
    );

    assert.ok(parsed.text.includes("[表情: 赞]"));
    assert.ok(parsed.text.includes("BITNP 纳新公告"));
    assert.ok(parsed.text.includes("https://bitnp.net/join"));

    // 2) Inbound group_msg_emoji_like notice updates reactions aggregation.
    await app.store.messages.capture({
      kind: "group",
      chatId: "555666",
      onebotMessageId: "ob-react-1",
      userId: "10001",
      senderName: "测试君",
      text: "好耶",
      segments: [{ type: "text", data: { text: "好耶" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: Date.now(),
    });

    await app.webhook.handle({
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

    // 3) Outbound qq_reaction dispatches set_msg_emoji_like.
    const delivery = await app.gateway.dispatchUnit(
      "group:555666",
      {
        kind: "qq_reaction",
        messageId: "ob-react-1",
        emojiId: "76",
      },
      "999999",
    );

    assert.equal(delivery.status, "sent");
    assert.equal(
      gatewayCalls.some((c) => c.path.endsWith("/set_msg_emoji_like")),
      true,
    );

    // 4) Pause bot -> messages are archived without enqueuing gate jobs.
    const { url } = await app.listen();
    const statusRes = await fetch(`${url}/api/auth/status`);
    const { csrfToken } = (await statusRes.json()) as { csrfToken: string };

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

    const pausedWebhook = await app.webhook.handle({
      post_type: "message",
      message_type: "group",
      group_id: 555_666,
      user_id: 10_002,
      message_id: "ob-paused-1",
      time: 1_700_000_200,
      message: "[CQ:at,qq=999999] 在吗？",
      sender: { card: "小王" },
    });

    assert.equal(pausedWebhook.accepted, true);
    const savedPaused = await app.store.messages.findByOnebotId(
      "group:555666",
      "ob-paused-1",
    );

    assert.ok(savedPaused);
    assert.equal(await app.store.jobs.countPending(), 0);

    // 5) History backfill pulls once and deduplicates on repeat.
    const backfillRes = await fetch(
      `${url}/api/admin/chats/group%3A555666/backfill`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ count: 20 }),
      },
    );

    assert.equal(backfillRes.status, 200);
    const backfillJson = (await backfillRes.json()) as {
      total: number;
      imported: number;
    };

    assert.equal(backfillJson.total, 1);
    assert.equal(backfillJson.imported, 1);

    const repeatRes = await fetch(
      `${url}/api/admin/chats/group%3A555666/backfill`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ count: 20 }),
      },
    );
    const repeatJson = (await repeatRes.json()) as {
      total: number;
      imported: number;
    };

    assert.equal(repeatJson.imported, 0);
  } finally {
    await gatewayStub.close();
    await cleanup();
  }
});

test("MaintenanceStore.purgeOldData preserves memory-referenced messages", async () => {
  const { app, cleanup } = await createTestBerryApp();

  try {
    const oldTs = Date.now() - 45 * 86_400_000;

    const { message: referenced } = await app.store.messages.capture({
      kind: "group",
      chatId: "888",
      onebotMessageId: "old-keep",
      userId: "1",
      senderName: "甲",
      text: "记住这条服务器密码规则",
      segments: [{ type: "text", data: { text: "记住" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: oldTs,
      receivedAt: oldTs,
    });

    const { message: disposable } = await app.store.messages.capture({
      kind: "group",
      chatId: "888",
      onebotMessageId: "old-drop",
      userId: "2",
      senderName: "乙",
      text: "水群消息",
      segments: [{ type: "text", data: { text: "水群消息" } }],
      replyToMessageId: null,
      isBot: false,
      mentionedBot: false,
      sentAt: oldTs,
      receivedAt: oldTs,
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

    const kept = await app.store.messages.findByOnebotId(
      "group:888",
      "old-keep",
    );
    const removed = await app.store.messages.findByOnebotId(
      "group:888",
      "old-drop",
    );

    assert.ok(kept);
    assert.equal(removed, null);
  } finally {
    await cleanup();
  }
});
