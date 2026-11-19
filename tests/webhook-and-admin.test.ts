import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { SECRET_MASK } from "../src/config/settings.ts";
import { createTestBerryApp, startStubServer } from "./helpers.ts";

test("webhook auth (Bearer + HMAC-SHA1), admin CSRF, secret masking, and TypeBox validation", async (t) => {
  const { app } = await createTestBerryApp(
    {
      webhookToken: "wh-secret-123",
      devAuthBypass: false,
    },
    {},
    t,
  );
  const { url } = await app.listen();

  const unauthWebhook = await fetch(`${url}/api/webhooks/onebot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ post_type: "meta_event" }),
  });

  assert.equal(unauthWebhook.status, 401);

  const bearerRes = await fetch(`${url}/api/webhooks/onebot`, {
    method: "POST",
    headers: {
      "Authorization": "Bearer wh-secret-123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ post_type: "meta_event" }),
  });

  assert.equal(bearerRes.status, 200);

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

  assert.equal(saved?.mentionedBot, true);

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

  assert.equal(settingsJson.settings.mainModel.apiKey, SECRET_MASK);

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
