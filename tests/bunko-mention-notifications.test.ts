import assert from "node:assert/strict";
import test from "node:test";

import { createTestBerryApp, startStubServer, waitUntil } from "./helpers.ts";

test("Bunko mention notifications resume from cursor, ignore malformed/duplicate events, and dispatch one private message", async (t) => {
  const cursorKey = "bunko_mention_event_cursor";
  const requests: { url: string; auth: string; lastEventId: string }[] = [];
  const sentDms: { userId: number; text: string }[] = [];

  const kcStub = await startStubServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/realms/bitnp/protocol/openid-connect/token") {
      res.end(JSON.stringify({ access_token: "kc-tok", expires_in: 300 }));

      return;
    }

    if (url.pathname === "/admin/realms/bitnp/users/keycloak-member") {
      res.end(
        JSON.stringify({
          id: "keycloak-member",
          username: "member",
          firstName: "成员",
          enabled: true,
          attributes: { qq_number: ["123456"] },
        }),
      );

      return;
    }

    if (
      url.pathname ===
      "/admin/realms/bitnp/users/keycloak-member/role-mappings/realm/composite"
    ) {
      res.end(JSON.stringify([]));

      return;
    }

    res.statusCode = 404;
    res.end();
  }, t);

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

  const streamStub = await startStubServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      auth: req.headers.authorization ?? "",
      lastEventId: String(req.headers["last-event-id"] ?? ""),
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    function frame(
      id: number,
      notificationId: string,
      recipientSubject = "keycloak-member",
    ) {
      const data = {
        id,
        notificationId,
        recipientSubject,
        documentId: "doc-id",
        documentTitle: "值班表",
        senderName: "编辑者",
      };

      return `id: ${id}\nevent: mention.requested\ndata: ${JSON.stringify(data)}\n\n`;
    }

    res.write("event: heartbeat\ndata: {}\n\n");
    res.write("event: mention.requested\ndata: {invalid-json\n\n");
    res.write(frame(41, "old-event"));
    res.write(frame(42, "unbound-event", "unbound-member"));
    res.write(frame(43, "new-event"));
    res.end(frame(43, "new-event"));
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
      bunkoApiUrl: streamStub.url,
      bunkoPublicUrl: "https://docs.example.com",
      bunkoWorkspaceSlug: "bitnp",
      bunkoNotificationToken: "bunko_notify_test",
    },
    {},
    t,
  );

  await app.store.cursors.set(cursorKey, "41");
  app.bunkoMentions.start();

  await waitUntil(
    async () => (await app.store.cursors.get(cursorKey)) === "43",
  );
  await app.bunkoMentions.stop();

  assert.deepEqual(requests[0], {
    url: "/api/v1/internal/mention-notifications/stream?after=41",
    auth: "Bearer bunko_notify_test",
    lastEventId: "41",
  });
  assert.deepEqual(sentDms, [
    {
      userId: 123_456,
      text: "编辑者 在《值班表》中提及了你。\nhttps://docs.example.com/bitnp/doc/doc-id",
    },
  ]);
});
