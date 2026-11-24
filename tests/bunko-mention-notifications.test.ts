import assert from "node:assert/strict";
import test from "node:test";

import { BunkoMentionNotifications } from "../src/bunko/mention-notifications.ts";
import { permissionsFromRoles } from "../src/identity/permissions.ts";
import type { ChatKey, OutputUnit } from "../src/types.ts";
import { startStubServer, waitUntil } from "./helpers.ts";

test("Bunko notifications resume with the service token and send one private message", async (t) => {
  const cursorKey = "bunko_mention_event_cursor";
  const state = new Map([
    ["bunko_mention_last_dispatch", "already-queued"],
    [cursorKey, "41"],
  ]);
  const requests: string[] = [];
  const sent: { chatKey: ChatKey; unit: OutputUnit }[] = [];
  const stream = await startStubServer((req, res) => {
    requests.push(
      req.url ?? "",
      req.headers.authorization ?? "",
      req.headers["last-event-id"] as string,
    );
    res.writeHead(200, { "Content-Type": "text/event-stream" });

    function event(
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

    res.write(event(41, "old-event"));
    res.write(event(42, "already-queued"));
    res.write(event(43, "unbound-event", "unbound-member"));
    res.write(event(44, "new-event"));
    res.end(event(44, "new-event"));
  }, t);
  const runner = new BunkoMentionNotifications(
    {
      bunkoApiUrl: stream.url,
      bunkoPublicUrl: "https://docs.example.com",
      bunkoWorkspaceSlug: "bitnp",
      bunkoNotificationToken: "bunko_notify_test",
    },
    {
      get: async (key) => state.get(key) ?? null,
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    {
      enabled: true,
      bySubject: async (subject) =>
        subject === "keycloak-member"
          ? {
              subject,
              username: "member",
              name: "成员",
              qq: "123456",
              enabled: true,
              permissions: permissionsFromRoles([]),
            }
          : null,
    },
    {
      configured: true,
      dispatchUnit: async (chatKey, unit) => {
        sent.push({ chatKey, unit });

        return {
          id: 1,
          chatKey,
          kind: unit.kind,
          payload: unit,
          gatewayDeliveryId: "gateway-1",
          status: "queued",
          attempts: 0,
          error: null,
          onebotMessageId: null,
          createdAt: 0,
          updatedAt: 0,
        };
      },
    },
    () => "999",
  );

  runner.start();
  try {
    await waitUntil(() => state.get(cursorKey) === "44");
    assert.deepEqual(requests, [
      "/api/v1/internal/mention-notifications/stream?after=41",
      "Bearer bunko_notify_test",
      "41",
    ]);
    assert.deepEqual(sent, [
      {
        chatKey: "private:123456",
        unit: {
          kind: "qq_reply",
          text: "编辑者 在《值班表》中提及了你。\nhttps://docs.example.com/bitnp/doc/doc-id",
        },
      },
    ]);
  } finally {
    await runner.stop();
  }
});
