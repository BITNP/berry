import assert from "node:assert/strict";
import test from "node:test";

import { ModelIds } from "../src/agent/model-ids.ts";
import {
  qfaceName,
  resolveReactionEmojiId,
  searchQFaceCatalog,
} from "../src/gateway/qface.ts";
import {
  parseOneBotSegments,
  renderMessageTextForModel,
} from "../src/gateway/segments.ts";
import { previousNaturalWeek } from "../src/guild/automation.ts";
import { computeNextRunAt } from "../src/store/schedules.ts";
import {
  readChatWindowTool,
  searchChatMessagesTool,
} from "../src/tools/chat.ts";
import { memoryManageTool } from "../src/tools/memory.ts";
import type { ToolContext } from "../src/tools/types.ts";
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

  assert.match(prettyLine, /ERROR │ \[gateway\]\s+› Delivery failed/);
  assert.match(prettyLine, /deliveryId=7/);
  assert.match(prettyLine, /retry=false/);
  assert.match(prettyLine, /└─ timeout/);
  assert.match(prettyLine, /at line 2/);

  const infoLine = formatPrettyLogLine(
    {
      time: Date.UTC(2026, 10, 21, 1, 2, 3, 45),
      level: "info",
      scope: "main",
      message: "berry ready",
      context: {},
    },
    false,
  );
  const warnLine = formatPrettyLogLine(
    {
      time: Date.UTC(2026, 10, 21, 1, 2, 3, 45),
      level: "warn",
      scope: "main",
      message: "slow request",
      context: {},
    },
    false,
  );

  assert.match(infoLine, /│ {2}INFO │ \[main\]/);
  assert.match(warnLine, /│ {2}WARN │ \[main\]/);
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

  // Contact cards, group share cards, native contact segments, mqqapi:// links,
  // and @ mentions never leak raw QQ/group IDs to the model and register u_*/g_* handles.
  const friendCardJson = JSON.stringify({
    app: "com.tencent.contact.lua",
    prompt: "推荐联系人：Kat",
    view: "contact",
    meta: {
      contact: {
        nickname: "Kat",
        contact: "账号：1215926530",
        tag: "推荐好友",
        jumpUrl:
          "mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=1215926530",
      },
    },
  });
  const groupCardJson = JSON.stringify({
    app: "com.tencent.troopsharecard",
    prompt: "推荐群聊：技术群",
    view: "contact",
    meta: {
      contact: {
        nickname: "技术群",
        tag: "推荐群聊",
        jumpUrl:
          "mqqapi://card/show_pslcard?card_type=group&group_code=88776655",
      },
    },
  });
  const internalLinkCardJson = JSON.stringify({
    app: "com.tencent.structmsg",
    prompt: "群活动",
    meta: {
      news: {
        title: "活动卡片",
        jumpUrl: "mqqapi://internal/action?uin=987654321",
      },
    },
  });

  const storedFriendCard = parseOneBotSegments(
    [{ type: "json", data: { data: friendCardJson } }],
    "999999",
  );

  assert.equal(storedFriendCard.text, "[推荐好友: Kat]");
  assert.equal(storedFriendCard.text.includes("1215926530"), false);
  assert.equal(storedFriendCard.text.includes("mqqapi://"), false);

  const ids = new ModelIds();
  const modelText = renderMessageTextForModel(
    {
      text: "[分享: mqqapi://card/show_pslcard?uin=1215926530]",
      segments: [
        { type: "json", data: { data: friendCardJson } },
        { type: "text", data: { text: " " } },
        { type: "json", data: { data: groupCardJson } },
        { type: "text", data: { text: " " } },
        { type: "contact", data: { type: "qq", id: "555666777" } },
        { type: "text", data: { text: " " } },
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " " } },
        { type: "json", data: { data: internalLinkCardJson } },
      ],
    },
    { botQQ: "999999", ids },
  );

  const katRef = ids.userRef("1215926530");
  const groupRef = ids.groupRef("88776655");
  const nativeContactRef = ids.userRef("555666777");
  const atRef = ids.userRef("12345");

  assert.ok(modelText.includes(`[推荐好友: Kat (${katRef})]`));
  assert.ok(modelText.includes(`[推荐群聊: 技术群 (${groupRef})]`));
  assert.ok(modelText.includes(`[推荐好友: ${nativeContactRef}]`));
  assert.ok(modelText.includes(`@${atRef}`));
  assert.ok(modelText.includes("[分享: 活动卡片]"));
  assert.equal(modelText.includes("1215926530"), false);
  assert.equal(modelText.includes("88776655"), false);
  assert.equal(modelText.includes("555666777"), false);
  assert.equal(modelText.includes("12345"), false);
  assert.equal(modelText.includes("987654321"), false);
  assert.equal(modelText.includes("mqqapi://"), false);
  assert.equal(ids.resolveUser(katRef), "1215926530");
  assert.equal(ids.resolveTargetChatKey(katRef), "private:1215926530");
  assert.equal(ids.resolveTargetChatKey(groupRef), "group:88776655");

  // Even previously stored messages with legacy unsanitized text are desensitized via segments.
  const { message: legacyCardMsg } = await app.store.messages.capture({
    kind: "private",
    chatId: "20001",
    onebotMessageId: "ob-card-legacy-1",
    userId: "20001",
    senderName: "主席",
    text: "[分享: mqqapi://card/show_pslcard?uin=1215926530]",
    segments: [{ type: "json", data: { data: friendCardJson } }],
    replyToMessageId: null,
    isBot: false,
    mentionedBot: false,
    sentAt: Date.now(),
  });
  const enrichIds = new ModelIds();
  const enrichedMap = await app.media.enrichMessagesText(
    "private:20001",
    [legacyCardMsg],
    enrichIds,
  );
  const enrichedCardText = enrichedMap.get(legacyCardMsg.id)!;

  assert.equal(
    enrichedCardText,
    `[推荐好友: Kat (${enrichIds.userRef("1215926530")})]`,
  );
  assert.equal(enrichedCardText.includes("1215926530"), false);

  await captureText(app, {
    kind: "group",
    chatId: "555666",
    id: "ob-react-speaker",
    userId: "20001",
    senderName: "李哲",
    text: "围观一下",
  });

  const reactMsg = await captureText(app, {
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
  assert.equal((reactionCall.body as { set?: boolean }).set, true);

  // Bot's own reaction is stored and an explicit OutputResult receipt is pushed for the next turn.
  const pendingAfterReact = await app.store.conversations.drainPendingResults();

  assert.ok(
    pendingAfterReact.some(
      (item) => item.status === "ok" && item.detail === "qq_reaction sent",
    ),
  );

  const reactIds = new ModelIds();
  const enrichedReactMap = await app.media.enrichMessagesText(
    "group:555666",
    [reactMsg.message],
    reactIds,
  );
  const enrichedReactText = enrichedReactMap.get(reactMsg.message.id) ?? "";

  assert.match(
    enrichedReactText,
    new RegExp(`赞×1\\(李哲\\(${reactIds.userRef("20001")}\\)\\)`),
  );
  assert.match(enrichedReactText, /㊗️×1\(树莓娘\)/);
  assert.equal(enrichedReactText.includes("20001"), false);

  const removeDelivery = await app.gateway.dispatchUnit(
    "group:555666",
    {
      kind: "qq_reaction",
      messageId: "ob-react-1",
      emojiId: "㊗️",
      remove: true,
    },
    "999999",
  );

  assert.equal(removeDelivery.status, "sent");
  const removeCall = gatewayCalls.findLast((c) =>
    c.path.endsWith("/set_msg_emoji_like"),
  );

  assert.ok(removeCall);
  assert.equal((removeCall.body as { emoji_id?: string }).emoji_id, "12951");
  assert.equal((removeCall.body as { set?: boolean }).set, false);

  const afterRemoveMap = await app.store.reactions.aggregateForMessages(
    "group:555666",
    ["ob-react-1"],
  );

  assert.deepEqual(
    (afterRemoveMap.get("ob-react-1") ?? []).map((r) => r.emojiName),
    ["赞"],
  );

  const privReactionDelivery = await app.gateway.dispatchUnit(
    "private:12345",
    { kind: "qq_reaction", messageId: "ob-priv-1", emojiId: "👍" },
    "999999",
  );

  assert.equal(privReactionDelivery.status, "failed");
  assert.match(privReactionDelivery.error ?? "", /仅支持群聊消息/);

  // QQNT catalog & supported Unicode reaction whitelist.
  assert.equal(qfaceName("12951"), "㊗️");
  assert.equal(qfaceName("129397"), "🥵");
  assert.equal(qfaceName("478"), "对的对的");
  assert.equal(qfaceName("179"), "doge");
  assert.equal(resolveReactionEmojiId("㊗️"), "12951");
  assert.equal(resolveReactionEmojiId("❤️"), "10084");
  assert.equal(resolveReactionEmojiId("👍"), "128077");
  assert.equal(resolveReactionEmojiId("对的对的"), "478");
  assert.equal(resolveReactionEmojiId("狗头"), "179");
  assert.equal(resolveReactionEmojiId("76"), "76");
  assert.equal(resolveReactionEmojiId("12951"), "12951");
  assert.throws(() => resolveReactionEmojiId("🥵"), /不支持的表情回应/);
  assert.throws(() => resolveReactionEmojiId("129397"), /不支持的表情数字 ID/);
  assert.throws(
    () => resolveReactionEmojiId("99999999"),
    /不支持的表情数字 ID/,
  );
  assert.throws(() => resolveReactionEmojiId("99999"), /不支持的表情数字 ID/);
  assert.throws(
    () => resolveReactionEmojiId("不存在的乱码文字"),
    /不支持的表情回应/,
  );

  const searchRes = searchQFaceCatalog("西格玛");

  assert.ok(searchRes.items.some((item) => item.id === "469"));
  assert.equal(searchQFaceCatalog("㊗️").resolvedUnicodeId, "12951");
  assert.equal(searchQFaceCatalog("🥵").resolvedUnicodeId, undefined);

  // Supported Unicode reaction emojis are searchable by emoji char, Chinese name, and associate words.
  const breadByChar = searchQFaceCatalog("🍞");

  assert.equal(breadByChar.resolvedUnicodeId, "127838");
  assert.equal(breadByChar.total, 1);
  assert.equal(breadByChar.items[0]?.emoji, "🍞");
  assert.equal(breadByChar.items[0]?.kind, "unicode");
  assert.ok(
    searchQFaceCatalog("面包").items.some((item) => item.id === "127838"),
  );
  assert.ok(
    searchQFaceCatalog("吐司").items.some((item) => item.id === "127838"),
  );
  assert.ok(
    searchQFaceCatalog("庆祝").items.some((item) => item.id === "127881"),
  );
  assert.equal(resolveReactionEmojiId("面包"), "127838");
  assert.equal(resolveReactionEmojiId("🎉"), "127881");
  assert.equal(resolveReactionEmojiId("庆祝"), "320");

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
  const jobCounts = await app.store.jobs.counts();

  assert.equal(jobCounts.pending + jobCounts.running, 0);

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

  const windowRes = (await readChatWindowTool
    .bind({
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
        chatKey: "group:555666",
        senderQQ: "10001",
        actorSubject: null,
        actorName: "测试君",
        role: "member",
      },
      ids: reactIds,
    })
    .execute({ limit: 10 })) as {
    messages: {
      text: string;
      reactions: {
        emojiName: string;
        count: number;
        users: { userRef: string | null; name: string | null }[];
      }[];
    }[];
  };
  const winReactMsg = windowRes.messages.find((m) => m.text.includes("好耶"));

  assert.ok(winReactMsg);
  assert.deepEqual(
    winReactMsg.reactions.map((r) => [r.emojiName, r.users]),
    [["赞", [{ userRef: reactIds.userRef("20001"), name: "李哲" }]]],
  );
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

test("search_chat_messages supports regex OR, userRef filter, and contextLines; memories support expiresAt and automatic cleanup", async (t) => {
  const { app } = await createTestBerryApp({}, {}, t);
  const baseTs = Date.now() - 60_000;

  await app.store.chats.upsert({
    kind: "group",
    chatId: "600",
    title: "运维值班群",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const timeline = [
    { id: "m1", userId: "101", senderName: "甲", text: "大家早安" },
    { id: "m2", userId: "102", senderName: "乙", text: "机房刚刚监控告警" },
    { id: "m3", userId: "101", senderName: "甲", text: "好像是 UPS 切电池了" },
    { id: "m4", userId: "102", senderName: "乙", text: "我去楼下看一眼" },
    { id: "m5", userId: "103", senderName: "丙", text: "中午吃什么" },
    { id: "m6", userId: "102", senderName: "乙", text: "反代开始报 502 了" },
    { id: "m7", userId: "101", senderName: "甲", text: "已重启恢复" },
  ];

  for (const [idx, item] of timeline.entries()) {
    await captureText(app, {
      kind: "group",
      chatId: "600",
      id: item.id,
      userId: item.userId,
      senderName: item.senderName,
      text: item.text,
      sentAt: baseTs + idx * 1000,
    });
  }

  const ids = new ModelIds();
  const ctx: ToolContext = {
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
      chatKey: "group:600",
      senderQQ: "101",
      actorSubject: "sub-admin",
      actorName: "甲",
      role: "admin",
    },
    ids,
  };

  // 1) Regex multi-keyword OR + contextLines=1 returns merged chronological context with matched flags.
  const rgRes = (await searchChatMessagesTool.bind(ctx).execute({
    query: "断电|UPS|502",
    regex: true,
    contextLines: 1,
  })) as {
    matchCount: number;
    count: number;
    messages: { text: string; matched?: boolean }[];
  };

  assert.equal(rgRes.matchCount, 2);
  assert.deepEqual(
    rgRes.messages.map((m) => [m.text, m.matched]),
    [
      ["机房刚刚监控告警", false],
      ["好像是 UPS 切电池了", true],
      ["我去楼下看一眼", false],
      ["中午吃什么", false],
      ["反代开始报 502 了", true],
      ["已重启恢复", false],
    ],
  );

  // 2) userRef filter narrows search to a single speaker.
  const user102Ref = ids.userRef("102");
  const byUserRes = (await searchChatMessagesTool.bind(ctx).execute({
    query: "UPS|502",
    regex: true,
    userRef: user102Ref,
  })) as { messages: { text: string }[] };

  assert.deepEqual(
    byUserRes.messages.map((m) => m.text),
    ["反代开始报 502 了"],
  );

  // 3) Invalid regex reports clear error.
  await assert.rejects(
    () =>
      searchChatMessagesTool
        .bind(ctx)
        .execute({ query: "[unclosed", regex: true }),
    /无效的正则表达式/,
  );

  // 4) Memories expiration: expired entries are hidden from index/get/list and purged on cleanup.
  const pastIso = new Date(Date.now() - 60_000).toISOString();

  await memoryManageTool.bind(ctx).execute({
    action: "upsert",
    scope: "chat",
    key: "temp_event",
    summary: "已结束的临时排期",
    content: "昨晚值班",
    expiresAt: pastIso,
  });
  await memoryManageTool.bind(ctx).execute({
    action: "upsert",
    scope: "chat",
    key: "active_event",
    summary: "进行中的短期活动",
    content: "本周六招新",
    ttlDays: 7,
  });

  const idx = await app.store.memories.index("group:600");

  assert.deepEqual(
    idx.chat.map((m) => m.key),
    ["active_event"],
  );
  assert.equal(
    await app.store.memories.get("chat", "group:600", "temp_event"),
    null,
  );
  assert.equal(
    (await app.store.memories.list({ scope: "chat", ownerId: "group:600" }))
      .length,
    1,
  );

  const purgedCount = await app.store.memories.purgeExpired();

  assert.equal(purgedCount, 1);
  assert.equal(
    (
      await app.store.memories.list({
        scope: "chat",
        ownerId: "group:600",
        includeExpired: true,
      })
    ).length,
    1,
  );
});

test("Vision empty output fails asset instead of caching placeholder, and AI trace APIs link messages to multi-step calls", async (t) => {
  const visionRequests: { maxTokens?: number }[] = [];
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
  );

  const stub = await startStubServer((req, res, bodyText) => {
    if (req.url === "/img.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(tinyPng);

      return;
    }

    if (req.url === "/v1/chat/completions") {
      const parsed = JSON.parse(bodyText) as { max_tokens?: number };

      visionRequests.push({ maxTokens: parsed.max_tokens });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-empty",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "thinking only...",
              },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 400,
            total_tokens: 520,
          },
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

  const { app } = await createTestBerryApp(
    {
      devAuthBypass: true,
    },
    {
      media: {
        autoAnalyzeImages: true,
        visionBaseURL: `${stub.url}/v1`,
        visionApiKey: "test-vision-key",
        visionModel: "vision-test-model",
      },
    },
    t,
  );

  await app.store.chats.upsert({
    kind: "group",
    chatId: "8801",
    title: "技术保障中心",
    enabled: true,
    triggerMode: "smart_observe",
  });

  const { message: userMsg } = await app.store.messages.capture({
    kind: "group",
    chatId: "8801",
    onebotMessageId: "ob-u-1",
    userId: "12345",
    senderName: "测试同学",
    text: "[图片] 这张图写了啥",
    segments: [],
    replyToMessageId: null,
    isBot: false,
    mentionedBot: true,
    sentAt: Date.now() - 2000,
  });

  // Enqueue image where vision model returns null content (e.g. exhausted reasoning tokens).
  await app.media.enqueueMessageAssets(userMsg, [
    { kind: "image", rawUrl: `${stub.url}/img.png`, name: "img.png" },
  ]);
  await app.media.waitForMessages([userMsg.id]);

  assert.equal(visionRequests.length, 1);
  assert.ok((visionRequests[0]?.maxTokens ?? 0) >= 2048);

  const [updatedAsset] =
    (await app.store.assets.listForMessages([userMsg.id])).get(userMsg.id) ??
    [];

  assert.equal(updatedAsset?.status, "failed");
  assert.match(updatedAsset?.error ?? "", /空内容/);

  // Record a gate decision + dialog call linked to the same message, plus bot reply.
  await app.store.gate.record({
    chatKey: "group:8801",
    messageId: userMsg.id,
    action: "reply",
    stage: "l0_rule",
    reason: "@提及了树莓娘",
    confidence: 1,
    model: "rule",
    durationMs: 1,
  });

  await app.store.usage.record({
    purpose: "dialog",
    model: "test-main",
    chatKey: "group:8801",
    jobId: 42,
    messageIds: [userMsg.id],
    inputTokens: 1000,
    outputTokens: 80,
    cachedInputTokens: 512,
    durationMs: 1200,
    status: "ok",
    error: null,
    toolCalls: [],
    requestPreview: null,
    responseText: JSON.stringify({
      units: [{ kind: "qq_reply", text: "图片刚下载失败了，再发一次试试" }],
    }),
  });

  await app.store.messages.capture({
    kind: "group",
    chatId: "8801",
    onebotMessageId: "ob-bot-1",
    userId: "999999",
    senderName: "树莓娘",
    text: "图片刚下载失败了，再发一次试试",
    segments: [],
    replyToMessageId: "ob-u-1",
    isBot: true,
    mentionedBot: false,
    sentAt: Date.now() - 500,
  });

  const { url } = await app.listen();

  // 1) /api/admin/ai/traces groups vision + dialog under the same message with real chat title & reply.
  const tracesRes = await fetch(`${url}/api/admin/ai/traces?limit=20`);

  assert.equal(tracesRes.status, 200);
  const tracesJson = (await tracesRes.json()) as {
    items: {
      chatTitle: string;
      triggerMessages: { id: number; text: string }[];
      replyMessages: { text: string }[];
      gateDecisions: { action: string }[];
      steps: { purpose: string }[];
      outcome: { kind: string; label: string };
    }[];
  };

  assert.equal(tracesJson.items.length, 1);
  const trace = tracesJson.items[0]!;

  assert.equal(trace.chatTitle, "技术保障中心");
  assert.equal(trace.triggerMessages[0]?.id, userMsg.id);
  assert.equal(trace.replyMessages[0]?.text, "图片刚下载失败了，再发一次试试");
  assert.equal(trace.gateDecisions[0]?.action, "reply");
  assert.deepEqual(trace.steps.map((s) => s.purpose).toSorted(), [
    "dialog",
    "vision",
  ]);
  assert.equal(trace.outcome.kind, "reply");

  // 2) /api/admin/messages/:id/trace returns the same correlated trace.
  const msgTraceRes = await fetch(
    `${url}/api/admin/messages/${userMsg.id}/trace`,
  );

  assert.equal(msgTraceRes.status, 200);
  const msgTraceJson = (await msgTraceRes.json()) as {
    chatTitle: string;
    steps: { purpose: string }[];
  };

  assert.equal(msgTraceJson.chatTitle, "技术保障中心");
  assert.equal(msgTraceJson.steps.length, 2);

  // 3) /api/admin/chats/:chatKey/messages attaches traceSummary to the user message.
  const chatMsgsRes = await fetch(
    `${url}/api/admin/chats/${encodeURIComponent("group:8801")}/messages`,
  );

  assert.equal(chatMsgsRes.status, 200);
  const chatMsgsJson = (await chatMsgsRes.json()) as {
    items: {
      id: number;
      traceSummary?: {
        hasTrace: boolean;
        gateAction: string | null;
        aiCalls: number;
      };
    }[];
  };
  const fetchedUserMsg = chatMsgsJson.items.find((m) => m.id === userMsg.id);

  assert.equal(fetchedUserMsg?.traceSummary?.hasTrace, true);
  assert.equal(fetchedUserMsg?.traceSummary?.gateAction, "reply");
  assert.equal(fetchedUserMsg?.traceSummary?.aiCalls, 2);
});

test("QQ poke notice ingests group/private pokes at bot, ignores others/self, and qq_poke dispatches send_poke", async (t) => {
  const gatewayCalls: { action: string; body: Record<string, unknown> }[] = [];

  const gwStub = await startStubServer((req, res, bodyText) => {
    const action = req.url?.split("/").pop() ?? "";
    const body = bodyText
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};

    gatewayCalls.push({ action, body });
    res.setHeader("Content-Type", "application/json");

    if (action === "get_group_member_list") {
      res.end(
        JSON.stringify({
          status: "ok",
          data: [{ user_id: 20_001, card: "小甲", nickname: "甲" }],
        }),
      );

      return;
    }

    if (action === "get_stranger_info") {
      res.end(
        JSON.stringify({
          status: "ok",
          data: { user_id: 20_002, nickname: "私聊乙" },
        }),
      );

      return;
    }

    res.end(JSON.stringify({ status: "ok", data: {} }));
  }, t);

  const llmStub = await startStubServer((_req, res, bodyText) => {
    const reqJson = JSON.parse(bodyText) as {
      messages: { role: string; content: string }[];
    };
    const userContent = reqJson.messages.at(-1)?.content ?? "";

    res.setHeader("Content-Type", "application/json");

    if (userContent.includes('"candidates"')) {
      const parsed = JSON.parse(userContent) as {
        candidates: { messageId: number }[];
      };

      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  decisions: parsed.candidates.map((c) => ({
                    messageId: c.messageId,
                    action: "reply",
                    confidence: 0.95,
                    reason: "戳了戳树莓娘",
                  })),
                }),
              },
            },
          ],
        }),
      );

      return;
    }

    // Main dialog pokes back (omitting userRef in single-speaker turn to test default resolution).
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                units: [
                  { kind: "qq_poke" },
                  { kind: "qq_reply", text: "戳回去～" },
                ],
              }),
            },
          },
        ],
      }),
    );
  }, t);

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: gwStub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
      mainBaseUrl: `${llmStub.url}/v1`,
      gateBaseUrl: `${llmStub.url}/v1`,
      botQQ: "999999",
    },
    { policy: { groupDefaultMode: "mention_only", adminQQs: ["20001"] } },
    t,
  );

  // 1) Poke targeting another human is ignored.
  const ignoredOther = await app.gatewayEvents.handleEvent({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    group_id: 777,
    user_id: 20_001,
    target_id: 20_002,
    self_id: 999_999,
    time: 1_700_000_001,
  });

  assert.equal(ignoredOther.reason, "poke_other_target");

  // 2) Self-poke echo from bot is ignored.
  const ignoredSelf = await app.gatewayEvents.handleEvent({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    group_id: 777,
    user_id: 999_999,
    target_id: 20_001,
    self_id: 999_999,
    time: 1_700_000_002,
  });

  assert.equal(ignoredSelf.reason, "poke_ignored_self");

  // 3) Group poke at bot is captured with mentionedBot=true and triggers qq_poke back.
  const groupPoke = await app.gatewayEvents.handleEvent({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    group_id: 777,
    user_id: 20_001,
    target_id: 999_999,
    self_id: 999_999,
    time: 1_700_000_003,
  });

  assert.equal(groupPoke.reason, "poke");
  assert.ok(groupPoke.messageId);

  const capturedGroup = await app.store.messages.get(groupPoke.messageId);

  assert.equal(capturedGroup?.text, "[戳了戳树莓娘]");
  assert.equal(capturedGroup?.senderName, "小甲");
  assert.equal(capturedGroup?.mentionedBot, true);

  await app.worker.drainOnce();

  const groupPokeCall = gatewayCalls.find((c) => c.action === "send_poke");

  assert.deepEqual(groupPokeCall?.body, {
    user_id: 20_001,
    group_id: 777,
  });

  // 4) Private poke at bot is captured and direct qq_poke dispatch omits group_id.
  const privatePoke = await app.gatewayEvents.handleEvent({
    post_type: "notice",
    notice_type: "notify",
    sub_type: "poke",
    user_id: 20_002,
    target_id: 999_999,
    self_id: 999_999,
    time: 1_700_000_004,
  });

  assert.equal(privatePoke.reason, "poke");
  const privDelivery = await app.gateway.dispatchUnit(
    "private:20002",
    { kind: "qq_poke", userId: "20002" },
    "999999",
  );

  assert.equal(privDelivery.status, "sent");
  const privPokeCall = gatewayCalls.filter((c) => c.action === "send_poke")[1];

  assert.deepEqual(privPokeCall?.body, { user_id: 20_002 });
});
