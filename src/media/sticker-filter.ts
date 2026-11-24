import { imageSize } from "image-size";

export interface ImageDimensions {
  width: number;
  height: number;
}

const NON_STICKER_TEXT_RE =
  /(?:群聊|聊天|对话|微信|QQ|网页|页面|浏览器|管理后台|后台|控制台|工作流|终端|代码|报错|错误|日志|系统|手机|电脑|桌面|屏幕|通知|弹窗|设置|面板|应用|软件|界面)截图|录屏|聊天记录|对话界面|网页界面|管理后台|后台界面|控制台界面|报错信息|代码片段|终端输出|命令行|二维码|付款码|收款码|行程码|发票|通知横条/;

const SCREENSHOT_CONTEXT_RE =
  /手机屏幕|电脑屏幕|浏览器窗口|微信界面|QQ界面|系统设置页面|通知栏/;

const MIN_STICKER_ASPECT = 0.45;
const MAX_STICKER_ASPECT = 2.8;

export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  try {
    const info = imageSize(bytes);

    if (!info.width || !info.height) {
      return null;
    }

    const rotated = info.orientation !== undefined && info.orientation >= 5;

    return rotated
      ? { width: info.height, height: info.width }
      : { width: info.width, height: info.height };
  } catch {
    return null;
  }
}

export function checkStickerEligibility(input: {
  bytes?: Uint8Array;
  meaning?: string | null;
  transcript?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const combinedText = [input.meaning ?? "", input.transcript ?? ""]
    .join(" ")
    .trim();

  if (
    combinedText &&
    (NON_STICKER_TEXT_RE.test(combinedText) ||
      SCREENSHOT_CONTEXT_RE.test(combinedText))
  ) {
    return {
      ok: false,
      reason: "该图片看起来是截图、界面或普通资料图，不是表情包，已拒绝收录",
    };
  }

  if (input.bytes) {
    const dims = readImageDimensions(input.bytes);

    if (dims) {
      const aspect = dims.width / dims.height;

      if (aspect < MIN_STICKER_ASPECT || aspect > MAX_STICKER_ASPECT) {
        return {
          ok: false,
          reason: `图片尺寸比例异常（${dims.width}×${dims.height}，疑似长截图或通知横条），不符合表情包规格`,
        };
      }
    }
  }

  return { ok: true };
}
