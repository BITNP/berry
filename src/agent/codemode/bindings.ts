import { bunkoListTreeTool, bunkoReadDocumentTool } from "../../tools/bunko.ts";
import {
  listChatsTool,
  readChatWindowTool,
  searchChatMessagesTool,
} from "../../tools/chat.ts";
import {
  guildGetNodeTool,
  guildListTreeTool,
  guildNodeProgressTool,
  guildResolveMemberTool,
} from "../../tools/guild.ts";
import type { ToolContext } from "../../tools/types.ts";
import type { HostBindingTree } from "./sandbox.ts";

const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

export function createReadonlyBindings(ctx: ToolContext): HostBindingTree {
  const chatsList = listChatsTool.bind(ctx);
  const chatsSearch = searchChatMessagesTool.bind(ctx);
  const chatsWindow = readChatWindowTool.bind(ctx);

  const guildListTree = guildListTreeTool.bind(ctx);
  const guildGetNode = guildGetNodeTool.bind(ctx);
  const guildNodeProgress = guildNodeProgressTool.bind(ctx);
  const guildResolveMember = guildResolveMemberTool.bind(ctx);

  const bunkoListTree = bunkoListTreeTool.bind(ctx);
  const bunkoReadDocument = bunkoReadDocumentTool.bind(ctx);

  function requireGuildEnabled() {
    if (!ctx.services.guild.enabled) {
      throw new Error("公会看板 API 当前未配置");
    }
  }

  function requireBunkoEnabled() {
    if (!ctx.services.bunko.enabled) {
      throw new Error("Bunko 云文档当前未配置");
    }
  }

  return {
    chats: {
      list: (opts?: unknown) => chatsList.execute(asRecord(opts)),
      search: (opts?: unknown) => chatsSearch.execute(asRecord(opts)),
      window: (opts?: unknown) => chatsWindow.execute(asRecord(opts)),
    },
    guild: {
      listTree: (opts?: unknown) => {
        requireGuildEnabled();

        return guildListTree.execute(asRecord(opts));
      },
      getNode: (nodeId?: unknown) => {
        requireGuildEnabled();

        const id =
          typeof nodeId === "object" && nodeId !== null && "nodeId" in nodeId
            ? Number(nodeId.nodeId)
            : Number(nodeId);

        if (!Number.isInteger(id) || id < 1) {
          throw new Error("nodeId 必须为正整数");
        }

        return guildGetNode.execute({ nodeId: id });
      },
      nodeProgress: (nodeId?: unknown, limit?: unknown) => {
        requireGuildEnabled();

        const opts =
          typeof nodeId === "object" && nodeId !== null
            ? asRecord(nodeId)
            : {
                nodeId: Number(nodeId),
                ...(limit === undefined ? {} : { limit: Number(limit) }),
              };

        if (!Number.isInteger(opts.nodeId) || Number(opts.nodeId) < 1) {
          throw new Error("nodeId 必须为正整数");
        }

        return guildNodeProgress.execute(opts);
      },
      resolveMember: (opts?: unknown) => {
        const params =
          typeof opts === "string" ? { query: opts } : asRecord(opts);

        return guildResolveMember.execute(params);
      },
    },
    bunko: {
      listTree: (opts?: unknown) => {
        requireBunkoEnabled();

        return bunkoListTree.execute(asRecord(opts));
      },
      readDocument: (opts?: unknown) => {
        requireBunkoEnabled();

        const params =
          typeof opts === "string" ? { documentId: opts } : asRecord(opts);

        return bunkoReadDocument.execute(params);
      },
    },
  };
}
