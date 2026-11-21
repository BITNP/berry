import { Type } from "typebox";

import { createReadonlyBindings } from "../agent/codemode/bindings.ts";
import { runReadonlyScript } from "../agent/codemode/sandbox.ts";
import { defineTool } from "./define.ts";

export const runReadonlyScriptTool = defineTool({
  name: "run_readonly_script",
  description:
    "在隔离的只读 QuickJS WASM 沙盒中执行异步 JavaScript 代码（函数体形式，支持 await 与 Promise.all，末尾用 return 返回精简 JSON 结果，单次最多 80 次 api 调用、超时 10 秒、返回值 <= 16 KiB）。",
  parameters: Type.Object(
    {
      code: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  execute: async (args, ctx) =>
    runReadonlyScript({
      code: args.code,
      bindings: createReadonlyBindings(ctx),
    }),
});
