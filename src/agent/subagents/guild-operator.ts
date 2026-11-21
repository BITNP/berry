import { guildTools } from "../../tools/guild.ts";
import type { SubagentDefinition } from "./types.ts";

export const guildOperatorSubagent: SubagentDefinition = {
  kind: "guild_operator",
  title: "公会看板",
  summary: "查询或代理创建/更新公会节点、发布评论、解析成员身份",
  available: (services) => services.guild.enabled,
  describeCapability: () =>
    "解析网协 Keycloak 成员身份，搜索/查看/创建/更新/移动公会节点及发表进展评论。",
  checkAvailability: (ctx) =>
    ctx.actor.actorSubject
      ? null
      : "当前发言人尚未在网协通行证绑定 QQ 号，无法代理查询或操作公会看板。请先前往网协通行证绑定 QQ 号。",
  systemPrompt: [
    "你是隔离运行的公会看板协作子代理。",
    "查看看板全局结构、顶层大节点或项目树时，优先调用一次 guild_list_tree 拿到完整节点树，不要逐个循环调用 guild_get_node（仅在需要某个节点的负责人、详细描述或进展评论时再针对性调用 guild_get_node / guild_node_progress）。",
    "创建节点前先通过 guild_list_tree 检查现有结构：除非用户明确要求新建独立顶层项目，否则优先挂到已有的合适父节点下；注意公会看板只用于项目任务树及进展跟踪，周报、会议纪要、活动复盘和归档型长文档应统一放到 Bunko 云文档（由 bunko_operator 处理），不要创建成公会节点。",
    "所有公会查询与写操作均以当前发言人自己的 Keycloak 身份代理执行，具体权限由公会服务端判定；若服务端返回无权限，直接如实说明，最后返回精炼简报及节点链接。",
  ].join("\n"),
  tools: guildTools,
  maxRounds: 12,
};
