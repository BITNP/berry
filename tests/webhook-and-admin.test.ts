import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { SECRET_MASK } from "../src/config/settings.ts";
import { createTestBerryApp } from "./helpers.ts";

test("webhook auth (Bearer + HMAC-SHA1) and admin CSRF + secret masking", async () => {
  const { app, cleanup } = await createTestBerryApp({
    webhookToken: "wh-secret-123",
    devAuthBypass: false,
  });

  try {
    const { url } = await app.listen();

    // 1) Webhook rejects unauthorized request.
    const unauthWebhook = await fetch(`${url}/api/webhooks/onebot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post_type: "meta_event" }),
    });

    assert.equal(unauthWebhook.status, 401);

    // 2) Webhook accepts Bearer token.
    const bearerRes = await fetch(`${url}/api/webhooks/onebot`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer wh-secret-123",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ post_type: "meta_event" }),
    });

    assert.equal(bearerRes.status, 200);

    // 3) Webhook accepts X-Signature sha1=<hmac> and captures message + recall.
    const msgPayload = JSON.stringify({
      post_type: "message",
      message_type: "group",
      group_id: 777,
      user_id: 888,
      message_id: "ob-1",
      time: 1_700_000_000,
      message: "[CQ:at,qq=999999] 你好",
      sender: { card: "群成员" },
    });
    const sig = createHmac("sha1", "wh-secret-123")
      .update(msgPayload)
      .digest("hex");

    const hmacRes = await fetch(`${url}/api/webhooks/onebot`, {
      method: "POST",
      headers: {
        "X-Signature": `sha1=${sig}`,
        "Content-Type": "application/json",
      },
      body: msgPayload,
    });

    assert.equal(hmacRes.status, 200);
    const saved = await app.store.messages.findByOnebotId("group:777", "ob-1");

    assert.ok(saved);
    assert.equal(saved.mentionedBot, true);

    // 4) Admin routes require session (401 when anonymous).
    const adminUnauth = await fetch(`${url}/api/admin/settings`);

    assert.equal(adminUnauth.status, 401);

    // 5) With valid session cookie, GET masks secrets and PUT requires CSRF token.
    const session = await app.store.sessions.create({
      subject: "admin-1",
      name: "Admin",
      email: "",
      avatar: "",
      permissions: {
        admitted: true,
        systemAdmin: true,
        manager: true,
        accessDepartments: ["techdept"],
        managedDepartments: ["techdept"],
        positions: [],
      },
    });
    const cookieHeader = `berry_session=${session.id}`;

    const settingsRes = await fetch(`${url}/api/admin/settings`, {
      headers: { Cookie: cookieHeader },
    });

    assert.equal(settingsRes.status, 200);
    const settingsJson = (await settingsRes.json()) as {
      settings: { mainModel: { apiKey: string } };
    };

    assert.equal(settingsJson.settings.mainModel.apiKey, SECRET_MASK);

    // Missing CSRF -> 403
    const badCsrf = await fetch(`${url}/api/admin/settings`, {
      method: "PUT",
      headers: {
        "Cookie": cookieHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settingsJson.settings),
    });

    assert.equal(badCsrf.status, 403);

    // Valid CSRF + masked apiKey preserves original secret in store.
    const goodCsrf = await fetch(`${url}/api/admin/settings`, {
      method: "PUT",
      headers: {
        "Cookie": cookieHeader,
        "X-CSRF-Token": session.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settingsJson.settings),
    });

    assert.equal(goodCsrf.status, 200);
    assert.equal(app.settings.mainModel.apiKey, "test-main-key");
  } finally {
    await cleanup();
  }
});
