import type { RuntimeSettings } from "../src/config/settings.ts";

export interface RuntimeSettingsPatch {
  bot?: Partial<RuntimeSettings["bot"]>;
  mainModel?: Partial<RuntimeSettings["mainModel"]>;
  gateModel?: Partial<RuntimeSettings["gateModel"]>;
  policy?: Partial<RuntimeSettings["policy"]>;
  media?: Partial<RuntimeSettings["media"]>;
}
