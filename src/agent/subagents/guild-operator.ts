import { guildTools } from "../../tools/guild.ts";
import type { SubagentDefinition } from "./types.ts";

export const guildOperatorSubagent: SubagentDefinition = {
  kind: "guild_operator",
  title: "公会看板",
  summary: "查询或代理创建/更新公会节点、发布评论、解析成员身份",
  describeCapability: (services) =>
    services.guild.enabled
      ? "解析网协 Keycloak 成员身份，搜索/查看/创建/更新/移动公会节点及发表进展评论。"
      : "当前未启用公会内部服务接口。",
  checkAvailability: (ctx) => {
    if (!ctx.services.guild.enabled) {
      return "公会内部服务接口未配置，无法操作公会看板。";
    }

    if (!ctx.actor.actorSubject) {
      return "当前发言人尚未在网协通行证绑定 QQ 号，无法代理查询或操作公会看板。请先前往网协通行证绑定 QQ 号。";
    }

    return null;
  },
  systemPrompt: [
    "你是隔离运行的公会看板协作子代理。",
    "查看看板全局结构、顶层大节点或项目树时，优先调用一次 guild_list_tree 拿到完整节点树，不要逐个循环调用 guild_get_node（仅在需要某个节点的负责人、详细描述或进展评论时再针对性调用 guild_get_node / guild_node_progress）。",
    "创建节点前先通过 guild_list_tree 检查现有结构：除非用户明确要求新建独立顶层项目，否则优先挂到已有的合适父节点下；对于周报、会议纪要、阶段总结这类周期性/归档型内容，优先挂在对应的归档父节点下（如「公会周报」；若还没有，先建一个总归档根节点，再把本期作为其子节点创建），不要把单期文档直接散落在顶层。",
    "必要时按发言人权限执行创建、更新、移动节点、调整成员或发布评论，最后返回精炼简报及节点链接。",
  ].join("\n"),
  tools: guildTools,
};
