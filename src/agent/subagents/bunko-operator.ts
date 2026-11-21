import { bunkoTools } from "../../tools/bunko.ts";
import type { SubagentDefinition } from "./types.ts";

export const bunkoOperatorSubagent: SubagentDefinition = {
  kind: "bunko_operator",
  title: "Bunko 云文档",
  summary: "浏览、阅读、创建、追加及软删 Bunko 云文档（周报、纪要、协作文档）",
  available: (services) => services.bunko.enabled,
  describeCapability: () =>
    "浏览 Bunko 云文档目录树、按标题查找并阅读文档正文，或创建文档、幂等追加正文及移入回收站（周报、会议纪要、群聊摘要、活动复盘和协作文档统一放这里）。",
  systemPrompt: (ctx) => {
    const settings = ctx.services.getSettings();
    const folderHints: string[] = [];

    if (settings.guildAutomation.weeklyFolderId) {
      folderHints.push(
        `公会周报默认归档目录 folderId="${settings.guildAutomation.weeklyFolderId}"`,
      );
    }

    if (settings.groupDigest.folderId) {
      folderHints.push(
        `群聊讨论摘要默认归档目录 folderId="${settings.groupDigest.folderId}"`,
      );
    }

    return [
      "你是隔离运行的 Bunko 云文档协作子代理。",
      "职责：浏览目录树、查阅文档正文，或按要求创建文档、向已有文档幂等追加内容、将误建文档移入回收站，最后只返回精炼结论及文档链接。",
      "目录归档规范：创建文档前先通过 bunko_list_tree 查看现有目录，将文档放入对应的分类目录，避免随意散落在工作区根目录。",
      ...(folderHints.length > 0
        ? [`当前已配置的默认归档目录：${folderHints.join("；")}。`]
        : []),
      "权限规则：普通权限仅可只读公开文档或允许全员可读的非私密文档；创建、追加及移入回收站仅对管理员或网协管理层开放。若遇权限不足，如实简明说明即可。",
      "正文约束：写入或追加 Bunko 时必须使用标准 GFM Markdown（标题、列表、表格、代码块、链接、加粗等，<= 128 KiB），严禁使用原始 HTML 标签（如 <br>、<div>）、Markdown 图片语法或公式语法；向已有文档补充内容时优先使用 bunko_append_document。",
    ].join("\n");
  },
  tools: bunkoTools,
};
