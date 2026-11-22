import type { $Fetch } from "ofetch";
import { ofetch } from "ofetch";

import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import { isGroupAllowed } from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatConfig,
  ChatKey,
  ChatKind,
  DeliveryRecord,
  GroupTriggerMode,
  OneBotSegment,
  OutputUnit,
} from "../types.ts";
import { errorMessage } from "../utils/time.ts";
import type {
  GatewayEnvelope,
  GatewayTransport,
  GroupInfo,
  GroupMemberProfile,
  StrangerInfo,
} from "./directory.ts";
import { GatewayDirectory } from "./directory.ts";
import { GatewayDispatcher } from "./dispatcher.ts";
import type { SyncHistoryOptions, SyncHistoryResult } from "./history.ts";
import { GatewayHistorySync } from "./history.ts";

export type {
  GroupInfo,
  GroupMemberProfile,
  QqGroupRole,
  StrangerInfo,
} from "./directory.ts";
export { cleanOneBotName } from "./directory.ts";
export type { SyncHistoryOptions, SyncHistoryResult } from "./history.ts";

const LOGIN_INFO_FAILURE_COOLDOWN_MS = 10_000;

export interface GatewayClientOptions {
  pollDelaysMs?: number[];
  maxTrackMs?: number;
  getSettings?: () => RuntimeSettings;
}

export class MessageGatewayClient {
  #baseUrl: string;
  #account: string;
  #token: string;
  #api: $Fetch;
  #getSettings?: () => RuntimeSettings;
  #loginInfo: { user_id: number; nickname: string } | null = null;
  #loginInfoRetryAfter = 0;
  #directory: GatewayDirectory;
  #history: GatewayHistorySync;
  #dispatcher: GatewayDispatcher;

  constructor(
    env: Pick<EnvConfig, "gatewayUrl" | "gatewayAccount" | "gatewayToken">,
    store: Store,
    options: GatewayClientOptions = {},
  ) {
    this.#baseUrl = env.gatewayUrl.replace(/\/+$/, "");
    this.#account = env.gatewayAccount || "qq";
    this.#token = env.gatewayToken;
    this.#api = ofetch.create({
      baseURL: this.#baseUrl,
      retry: 0,
      headers: { Authorization: `Bearer ${this.#token}` },
    });
    this.#getSettings = options.getSettings;

    const isConfigured = this.configured;
    const transport: GatewayTransport = {
      configured: isConfigured,
      isGroupAllowed: (groupId) =>
        !this.#getSettings || isGroupAllowed(this.#getSettings(), groupId),
      getSettings: () => this.#getSettings?.(),
      callAction: (action, params) => this.callAction(action, params),
    };

    this.#directory = new GatewayDirectory(transport, store);
    this.#history = new GatewayHistorySync(transport, this.#directory, store);
    this.#dispatcher = new GatewayDispatcher({
      transport,
      directory: this.#directory,
      store,
      api: this.#api,
      account: this.#account,
      pollDelaysMs: options.pollDelaysMs,
      maxTrackMs: options.maxTrackMs,
    });
  }

  public get configured(): boolean {
    return Boolean(this.#baseUrl && this.#account && this.#token);
  }

  public async checkHealth(): Promise<{
    configured: boolean;
    reachable: boolean;
    error?: string;
  }> {
    if (!this.configured) {
      return { configured: false, reachable: false, error: "网关未配置" };
    }

    try {
      const res = await ofetch.raw(`${this.#baseUrl}/healthz`, {
        timeout: 4000,
        retry: 0,
        ignoreResponseError: true,
      });

      if (!res.ok) {
        return {
          configured: true,
          reachable: false,
          error: `HTTP ${res.status}`,
        };
      }

      return { configured: true, reachable: true };
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        error: errorMessage(error),
      };
    }
  }

  public async callAction<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<{ httpStatus: number; body: GatewayEnvelope<T> }> {
    if (!this.configured) {
      throw new Error("message-gateway is not configured");
    }

    const res = await this.#api.raw<GatewayEnvelope<T>>(
      `/api/v1/accounts/${encodeURIComponent(this.#account)}/${action}`,
      {
        method: "POST",
        body: params,
        timeout: 30_000,
        ignoreResponseError: true,
      },
    );

    const body =
      res._data && typeof res._data === "object"
        ? res._data
        : ({} as GatewayEnvelope<T>);

    if (res.status >= 400) {
      throw new Error(
        `Gateway ${action} failed (HTTP ${res.status}): ${body.message ?? res.statusText}`,
      );
    }

    return { httpStatus: res.status, body };
  }

  public clearLoginInfoCache(): void {
    this.#loginInfo = null;
    this.#loginInfoRetryAfter = 0;
    this.#directory.clearNegativeCaches();
  }

  public async getLoginInfo(): Promise<{
    user_id: number;
    nickname: string;
  } | null> {
    if (!this.configured) {
      return null;
    }

    if (this.#loginInfo) {
      return this.#loginInfo;
    }

    if (Date.now() < this.#loginInfoRetryAfter) {
      return null;
    }

    try {
      const { body } = await this.callAction<{
        user_id: number;
        nickname: string;
      }>("get_login_info");

      if (body.data) {
        this.#loginInfo = body.data;
        this.#loginInfoRetryAfter = 0;

        return body.data;
      }
    } catch {
      // Fall through to short negative cooldown.
    }

    this.#loginInfoRetryAfter = Date.now() + LOGIN_INFO_FAILURE_COOLDOWN_MS;

    return null;
  }

  public getGroupList(): Promise<GroupInfo[]> {
    return this.#directory.getGroupList();
  }

  public getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    return this.#directory.getGroupInfo(groupId);
  }

  public getGroupName(groupId: string): Promise<string | null> {
    return this.#directory.getGroupName(groupId);
  }

  public getGroupMemberList(groupId: string) {
    return this.#directory.getGroupMemberList(groupId);
  }

  public getGroupMemberProfile(
    groupId: string,
    userId: string,
  ): Promise<GroupMemberProfile | null> {
    return this.#directory.getGroupMemberProfile(groupId, userId);
  }

  public getGroupMemberName(
    groupId: string,
    userId: string,
  ): Promise<string | null> {
    return this.#directory.getGroupMemberName(groupId, userId);
  }

  public enrichMentionNames(
    kind: ChatKind,
    chatId: string,
    segments: OneBotSegment[],
    botQQ: string,
  ): Promise<boolean> {
    return this.#directory.enrichMentionNames(kind, chatId, segments, botQQ);
  }

  public getFriendList() {
    return this.#directory.getFriendList();
  }

  public getStrangerInfo(userId: string): Promise<StrangerInfo | null> {
    return this.#directory.getStrangerInfo(userId);
  }

  public getUserDisplayName(userId: string): Promise<string | null> {
    return this.#directory.getUserDisplayName(userId);
  }

  public resolveChatTitle(
    kind: ChatKind,
    chatId: string,
  ): Promise<string | null> {
    return this.#directory.resolveChatTitle(kind, chatId);
  }

  public resolveSenderName(input: {
    userId: string;
    isBot: boolean;
    card?: string | null;
    nickname?: string | null;
  }): Promise<string> {
    return this.#directory.resolveSenderName(input);
  }

  public ensureChatWithTitle(
    kind: ChatKind,
    chatId: string,
    options: {
      titleHint?: string | null;
      enabled: boolean;
      triggerMode: GroupTriggerMode;
    },
  ): Promise<ChatConfig> {
    return this.#directory.ensureChatWithTitle(kind, chatId, options);
  }

  public backfillEmptyChatTitles(): Promise<number> {
    return this.#directory.backfillEmptyChatTitles();
  }

  public getForwardMsg(forwardId: string): Promise<unknown[]> {
    return this.#history.getForwardMsg(forwardId);
  }

  public syncChatHistory(
    kind: ChatKind,
    chatId: string,
    options?: SyncHistoryOptions,
  ): Promise<SyncHistoryResult> {
    return this.#history.syncChatHistory(kind, chatId, options);
  }

  public warmChatHistory(
    kind: ChatKind,
    chatId: string,
    count?: number,
  ): Promise<void> {
    return this.#history.warmChatHistory(kind, chatId, count);
  }

  public dispatchUnit(
    chatKey: ChatKey,
    unit: OutputUnit,
    botQQ: string,
  ): Promise<DeliveryRecord> {
    return this.#dispatcher.dispatchUnit(chatKey, unit, botQQ);
  }

  public waitForPendingTracks(): Promise<void> {
    return this.#dispatcher.waitForPendingTracks();
  }

  public close(): Promise<void> {
    return this.#dispatcher.close();
  }
}
