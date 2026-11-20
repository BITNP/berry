import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { WebSocketServer } from "ws";

import { MessageGatewayClient } from "../src/gateway/client.ts";
import { createTestBerryApp, startStubServer, waitUntil } from "./helpers.ts";

test("GatewayEventSubscriber connects to /ws/event with Bearer auth, ingests events, and reconnects after 503 and disconnect", async (t) => {
  const authHeaders: (string | undefined)[] = [];
  let attempts = 0;

  const wss = new WebSocketServer({ noServer: true });
  const gwServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/healthz") {
      res.end(JSON.stringify({ status: "ok" }));

      return;
    }

    res.statusCode = 404;
    res.end();
  });

  gwServer.on("upgrade", (req, socket, head) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (reqUrl.pathname !== "/api/v1/accounts/qq/ws/event") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();

      return;
    }

    authHeaders.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer gw-ws-secret") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();

      return;
    }

    attempts++;

    if (attempts === 1) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();

      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(
        JSON.stringify({
          time: 1_700_000_000,
          self_id: 999_999,
          post_type: "meta_event",
          meta_event_type: "lifecycle",
          sub_type: "connect",
        }),
      );

      if (attempts === 2) {
        ws.send(
          JSON.stringify({
            post_type: "message",
            message_type: "group",
            group_id: 777,
            user_id: 888,
            self_id: 999_999,
            message_id: "ob-ws-1",
            time: 1_700_000_001,
            message: "[CQ:at,qq=999999] 你好",
            sender: { card: "群成员" },
          }),
        );
        ws.send(
          JSON.stringify({
            post_type: "notice",
            notice_type: "group_recall",
            group_id: 777,
            user_id: 888,
            message_id: "ob-ws-1",
            time: 1_700_000_010,
          }),
        );
        setTimeout(() => {
          ws.close(1012, "upstream restart");
        }, 50);

        return;
      }

      ws.send(
        JSON.stringify({
          post_type: "message",
          message_type: "private",
          user_id: 30_001,
          self_id: 999_999,
          message_id: "ob-ws-dm-1",
          time: 1_700_000_020,
          message: "断线重连后的私聊",
          sender: { nickname: "私聊同学" },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    gwServer.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => gwServer.close(() => resolve()));
  });

  const addr = gwServer.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;

  const { app } = await createTestBerryApp(
    {
      gatewayUrl: `http://127.0.0.1:${port}`,
      gatewayAccount: "qq",
      gatewayToken: "gw-ws-secret",
    },
    {},
    t,
  );
  const { url } = await app.listen();

  app.gatewayEvents.start();

  await waitUntil(async () => {
    if (attempts < 3 || !app.gatewayEvents.connected) {
      return false;
    }

    const groupMsg = await app.store.messages.findByOnebotId(
      "group:777",
      "ob-ws-1",
    );
    const dmMsg = await app.store.messages.findByOnebotId(
      "private:30001",
      "ob-ws-dm-1",
    );

    return Boolean(
      groupMsg?.mentionedBot &&
      groupMsg.recalledAt !== null &&
      dmMsg?.text === "断线重连后的私聊",
    );
  }, 6000);

  assert.equal(authHeaders.length >= 3, true);
  assert.ok(authHeaders.every((h) => h === "Bearer gw-ws-secret"));

  const health = (await (await fetch(`${url}/api/healthz`)).json()) as {
    gatewayStreamConnected: boolean;
  };

  assert.equal(health.gatewayStreamConnected, true);

  await app.gatewayEvents.stop();
  assert.equal(app.gatewayEvents.connected, false);

  const healthAfter = (await (await fetch(`${url}/api/healthz`)).json()) as {
    gatewayStreamConnected: boolean;
  };

  assert.equal(healthAfter.gatewayStreamConnected, false);
});

test("admin auth, CSRF, secret masking, TypeBox validation, and removed /api/webhooks/onebot", async (t) => {
  const { app } = await createTestBerryApp(
    {
      devAuthBypass: false,
    },
    {},
    t,
  );
  const { url } = await app.listen();

  const legacyWebhookRes = await fetch(`${url}/api/webhooks/onebot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ post_type: "meta_event" }),
  });

  assert.equal(legacyWebhookRes.status, 404);

  assert.equal((await fetch(`${url}/api/admin/settings`)).status, 401);

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
  const settingsJson = (await (
    await fetch(`${url}/api/admin/settings`, {
      headers: { Cookie: cookieHeader },
    })
  ).json()) as { settings: { mainModel: { apiKey: string } } };

  assert.equal(settingsJson.settings.mainModel.apiKey, "test-main-key");

  const badCsrf = await fetch(`${url}/api/admin/settings`, {
    method: "PUT",
    headers: {
      "Cookie": cookieHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settingsJson.settings),
  });

  assert.equal(badCsrf.status, 403);

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

  // TypeBox query and body validation allow blank filter params and reject invalid inputs with 400.
  const emptyFilterRes = await fetch(
    `${url}/api/admin/logs?level=&scope=&search=`,
    { headers: { Cookie: cookieHeader } },
  );

  assert.equal(emptyFilterRes.status, 200);

  const invalidLimitRes = await fetch(`${url}/api/admin/logs?limit=abc`, {
    headers: { Cookie: cookieHeader },
  });

  assert.equal(invalidLimitRes.status, 400);

  const invalidPurgeRes = await fetch(`${url}/api/admin/storage/purge`, {
    method: "POST",
    headers: {
      "Cookie": cookieHeader,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ olderThanDays: 0 }),
  });

  assert.equal(invalidPurgeRes.status, 400);

  // Record AI calls (ok with tool calls + error) and verify /api/admin/llm-calls filtering.
  await app.store.usage.record({
    purpose: "subagent:chat_analyst",
    model: "deepseek-v4-flash",
    chatKey: "group:1054204419",
    status: "ok",
    inputTokens: 1200,
    cachedInputTokens: 400,
    outputTokens: 180,
    durationMs: 620,
    requestPreview: "[user]\n总结最近话题",
    responseText: '{"brief":"ok"}',
    toolCalls: [{ name: "search_chat_messages", arguments: '{"limit":60}' }],
  });
  await app.store.usage.record({
    purpose: "dialog",
    model: "deepseek-v4-flash",
    chatKey: "group:1054204419",
    status: "error",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    durationMs: 150,
    error: "upstream 429 rate limited",
  });

  const subagentCalls = (await (
    await fetch(`${url}/api/admin/llm-calls?purpose=subagent`, {
      headers: { Cookie: cookieHeader },
    })
  ).json()) as {
    items: {
      purpose: string;
      toolCalls: { name: string }[];
      requestPreview: string | null;
    }[];
    total: number;
  };

  assert.equal(subagentCalls.total, 1);
  assert.equal(subagentCalls.items[0]?.purpose, "subagent:chat_analyst");
  assert.equal(
    subagentCalls.items[0]?.toolCalls[0]?.name,
    "search_chat_messages",
  );
  assert.match(subagentCalls.items[0]?.requestPreview ?? "", /总结最近话题/);

  const errorCalls = (await (
    await fetch(`${url}/api/admin/llm-calls?status=error`, {
      headers: { Cookie: cookieHeader },
    })
  ).json()) as {
    items: { status: string; error: string | null }[];
    total: number;
  };

  assert.equal(errorCalls.total, 1);
  assert.equal(errorCalls.items[0]?.status, "error");
  assert.match(errorCalls.items[0]?.error ?? "", /429/);

  // Leave an active SSE connection open to verify app.close() does not hang on shutdown.
  const sseRes = await fetch(`${url}/api/admin/events`, {
    headers: { Cookie: cookieHeader },
  });

  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
});

test("OIDC PKCE login and callback using openid-client and bitnp-authz", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test-rsa-1",
    use: "sig",
    alg: "RS256",
  };

  let expectedChallenge = "";
  let expectedNonce = "";
  let issuerUrl = "";

  const oidcStub = await startStubServer((req, res, bodyText) => {
    const reqUrl = new URL(req.url ?? "/", issuerUrl || "http://127.0.0.1");

    res.setHeader("Content-Type", "application/json");

    if (reqUrl.pathname === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer: issuerUrl,
          authorization_endpoint: `${issuerUrl}/authorize`,
          token_endpoint: `${issuerUrl}/token`,
          jwks_uri: `${issuerUrl}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        }),
      );

      return;
    }

    if (reqUrl.pathname === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));

      return;
    }

    if (reqUrl.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(bodyText);
      const computedChallenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");

      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_id"), "berry-console");
      assert.equal(form.get("client_secret"), "berry-oidc-secret");
      assert.equal(form.get("code"), "auth-code-1");
      assert.equal(computedChallenge, expectedChallenge);

      const nowSec = Math.floor(Date.now() / 1000);
      const headerB64 = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-rsa-1" }),
      ).toString("base64url");
      const payloadB64 = Buffer.from(
        JSON.stringify({
          iss: issuerUrl,
          sub: "sub-admin-1",
          aud: "berry-console",
          iat: nowSec,
          exp: nowSec + 300,
          nonce: expectedNonce,
          name: "测试管理员",
          email: "admin@bitnp.net",
          realm_access: {
            roles: ["permission-system-admin", "permission-techdept-access"],
          },
        }),
      ).toString("base64url");
      const signingInput = `${headerB64}.${payloadB64}`;
      const sigB64 = sign(
        "RSA-SHA256",
        Buffer.from(signingInput),
        privateKey,
      ).toString("base64url");

      res.end(
        JSON.stringify({
          access_token: "acc-token-1",
          token_type: "Bearer",
          expires_in: 300,
          id_token: `${signingInput}.${sigB64}`,
        }),
      );

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

  issuerUrl = oidcStub.url;

  const { app } = await createTestBerryApp(
    {
      devAuthBypass: false,
      oidcIssuer: oidcStub.url,
      oidcClientId: "berry-console",
      oidcClientSecret: "berry-oidc-secret",
    },
    {},
    t,
  );
  const { url } = await app.listen();

  app.env.publicUrl = url;

  const loginRes = await fetch(`${url}/api/auth/login?returnTo=%2Flogs`, {
    redirect: "manual",
  });

  assert.equal(loginRes.status, 302);
  const authUrl = new URL(loginRes.headers.get("location") ?? "");

  assert.equal(authUrl.origin, oidcStub.url);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  expectedChallenge = authUrl.searchParams.get("code_challenge") ?? "";
  expectedNonce = authUrl.searchParams.get("nonce") ?? "";
  const state = authUrl.searchParams.get("state") ?? "";

  assert.ok(expectedChallenge && expectedNonce && state);

  const cbUrl = new URL(`${url}/api/auth/callback`);

  cbUrl.searchParams.set("code", "auth-code-1");
  cbUrl.searchParams.set("state", state);

  const cbRes = await fetch(cbUrl, { redirect: "manual" });

  assert.equal(cbRes.status, 302);
  assert.equal(cbRes.headers.get("location"), "/logs");
  const sessionPair =
    (cbRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  assert.match(sessionPair, /^berry_session=/);

  const statusJson = (await (
    await fetch(`${url}/api/auth/status`, {
      headers: { Cookie: sessionPair },
    })
  ).json()) as {
    state: string;
    user?: {
      subject: string;
      permissions: { systemAdmin: boolean; accessDepartments: string[] };
    };
  };

  assert.equal(statusJson.state, "active");
  assert.equal(statusJson.user?.subject, "sub-admin-1");
  assert.equal(statusJson.user?.permissions.systemAdmin, true);
  assert.deepEqual(statusJson.user?.permissions.accessDepartments, [
    "techdept",
  ]);
});

test("MessageGatewayClient polls message-status past backoff ramp until terminal state, times out safely, and aborts on close", async (t) => {
  let slowPolls = 0;

  const stub = await startStubServer((req, res, bodyText) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (
      url.pathname === "/api/v1/accounts/qq/send_group_msg_async" &&
      req.method === "POST"
    ) {
      const payload = JSON.parse(bodyText) as {
        message?: { data?: { text?: string } }[];
      };
      const text = payload.message?.[0]?.data?.text ?? "";
      let deliveryId = "del-shutdown";

      if (text.includes("慢速")) {
        deliveryId = "del-slow";
      } else if (text.includes("卡住")) {
        deliveryId = "del-stuck";
      }

      res.statusCode = 202;
      res.end(
        JSON.stringify({
          status: "async",
          retcode: 1,
          data: { delivery_id: deliveryId },
        }),
      );

      return;
    }

    if (url.pathname === "/api/v1/accounts/qq/message-status/del-slow") {
      slowPolls++;

      if (slowPolls <= 2) {
        res.end(JSON.stringify({ id: "del-slow", status: "queued" }));

        return;
      }

      if (slowPolls === 3) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporary unavailable" }));

        return;
      }

      if (slowPolls === 4) {
        res.end(
          JSON.stringify({
            id: "del-slow",
            status: "retrying",
            attempts: 2,
            error: "rate limited",
          }),
        );

        return;
      }

      res.end(
        JSON.stringify({
          id: "del-slow",
          status: "sent",
          receipt: { message_id: "ob-slow-555" },
        }),
      );

      return;
    }

    if (url.pathname === "/api/v1/accounts/qq/message-status/del-stuck") {
      res.end(JSON.stringify({ id: "del-stuck", status: "queued" }));

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

  const { app } = await createTestBerryApp({}, {}, t);
  const client = new MessageGatewayClient(
    {
      gatewayUrl: stub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
    },
    app.store,
    { pollDelaysMs: [10, 20], maxTrackMs: 5000 },
  );

  t.after(() => client.close());

  // 1. Continues past [10, 20] ramp and recovers from HTTP 503 until terminal "sent".
  const slowDelivery = await client.dispatchUnit(
    "group:100",
    { kind: "qq_reply", text: "慢速队列回复" },
    "999999",
  );

  await client.waitForPendingTracks();

  const slowRecord = (await app.store.deliveries.list()).find(
    (d) => d.id === slowDelivery.id,
  );

  assert.equal(slowPolls, 5);
  assert.equal(slowRecord?.status, "sent");
  assert.equal(slowRecord?.onebotMessageId, "ob-slow-555");

  const capturedReply = await app.store.messages.findByOnebotId(
    "group:100",
    "ob-slow-555",
  );

  assert.equal(capturedReply?.isBot, true);
  assert.equal(capturedReply?.text, "慢速队列回复");

  // 2. Marks failed with warn log when maxTrackMs deadline expires.
  app.logs.clear();
  const timeoutClient = new MessageGatewayClient(
    {
      gatewayUrl: stub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
    },
    app.store,
    { pollDelaysMs: [15], maxTrackMs: 65 },
  );

  t.after(() => timeoutClient.close());

  const stuckDelivery = await timeoutClient.dispatchUnit(
    "group:100",
    { kind: "qq_reply", text: "卡住的消息" },
    "999999",
  );

  await timeoutClient.waitForPendingTracks();

  const stuckRecord = (await app.store.deliveries.list()).find(
    (d) => d.id === stuckDelivery.id,
  );

  assert.equal(stuckRecord?.status, "failed");
  assert.match(stuckRecord?.error ?? "", /timed out/);

  const warnLogs = app.logs.list({ level: "warn", scope: "gateway" }).items;

  assert.ok(
    warnLogs.some((entry) =>
      entry.message.includes("Delivery status tracking timed out"),
    ),
  );

  // 3. close() aborts active backoff sleep immediately without waiting for pollDelaysMs.
  const shutdownClient = new MessageGatewayClient(
    {
      gatewayUrl: stub.url,
      gatewayAccount: "qq",
      gatewayToken: "gw-tok",
    },
    app.store,
    { pollDelaysMs: [10_000], maxTrackMs: 60_000 },
  );

  const shutdownDelivery = await shutdownClient.dispatchUnit(
    "group:100",
    { kind: "qq_reply", text: "关闭中断消息" },
    "999999",
  );

  const closeStartedAt = Date.now();

  await shutdownClient.close();
  assert.ok(Date.now() - closeStartedAt < 1000);

  const shutdownRecord = (await app.store.deliveries.list()).find(
    (d) => d.id === shutdownDelivery.id,
  );

  assert.equal(shutdownRecord?.status, "queued");
});
