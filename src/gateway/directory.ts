import type { RuntimeSettings } from "../config/settings.ts";
import type { Store } from "../store/index.ts";
import type {
  ChatConfig,
  ChatKind,
  GroupTriggerMode,
  OneBotSegment,
} from "../types.ts";

export interface GatewayEnvelope<T = unknown> {
  status?: string;
  retcode?: number;
  data?: T;
  message?: string;
}

export interface GatewayTransport {
  readonly configured: boolean;
  isGroupAllowed: (groupId: string) => boolean;
  getSettings: () => RuntimeSettings | undefined;
  callAction: <T = unknown>(
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<{ httpStatus: number; body: GatewayEnvelope<T> }>;
}

export interface GroupInfo {
  group_id: number;
  group_name: string;
  member_count?: number;
}

export type QqGroupRole = "owner" | "admin" | "member";

export interface GroupMemberProfile {
  name: string | null;
  role: QqGroupRole;
  title: string | null;
}

export interface StrangerInfo {
  user_id: number;
  nickname?: string;
  nick?: string;
  remark?: string;
}

const NAME_CACHE_TTL_MS = 10 * 60 * 1000;
const NAME_FAILURE_COOLDOWN_MS = 30_000;
const PLACEHOLDER_SENDER_NAMES = new Set(["临时会话"]);

export function cleanOneBotName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";

  if (!trimmed || PLACEHOLDER_SENDER_NAMES.has(trimmed)) {
    return null;
  }

  return trimmed;
}

export class GatewayDirectory {
  #transport: GatewayTransport;
  #store: Store;
  #groupNameCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  #userNameCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  #groupMembersCache = new Map<
    string,
    {
      members: Map<string, GroupMemberProfile>;
      ok: boolean;
      expiresAt: number;
    }
  >();

  #inFlightGroupMembers = new Map<
    string,
    Promise<Map<string, GroupMemberProfile> | null>
  >();

  constructor(transport: GatewayTransport, store: Store) {
    this.#transport = transport;
    this.#store = store;
  }

  public clearNegativeCaches(): void {
    for (const [key, entry] of this.#groupNameCache) {
      if (entry.value === null) {
        this.#groupNameCache.delete(key);
      }
    }

    for (const [key, entry] of this.#userNameCache) {
      if (entry.value === null) {
        this.#userNameCache.delete(key);
      }
    }

    for (const [key, entry] of this.#groupMembersCache) {
      if (!entry.ok) {
        this.#groupMembersCache.delete(key);
      }
    }
  }

  public async getGroupList(): Promise<GroupInfo[]> {
    if (!this.#transport.configured) {
      return [];
    }

    const { body } =
      await this.#transport.callAction<GroupInfo[]>("get_group_list");
    const groups = (body.data ?? []).filter((group) =>
      this.#transport.isGroupAllowed(String(group.group_id)),
    );
    const expiresAt = Date.now() + NAME_CACHE_TTL_MS;

    for (const group of groups) {
      const name = cleanOneBotName(group.group_name);

      if (name) {
        this.#groupNameCache.set(String(group.group_id), {
          value: name,
          expiresAt,
        });
      }
    }

    return groups;
  }

  public async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    if (
      !this.#transport.configured ||
      !this.#transport.isGroupAllowed(groupId)
    ) {
      return null;
    }

    const numericId = Number(groupId);

    if (!Number.isFinite(numericId)) {
      return null;
    }

    try {
      const { body } = await this.#transport.callAction<GroupInfo>(
        "get_group_info",
        { group_id: numericId },
      );

      return body.status === "failed" ? null : (body.data ?? null);
    } catch {
      return null;
    }
  }

  public async getGroupName(groupId: string): Promise<string | null> {
    if (
      !this.#transport.configured ||
      !this.#transport.isGroupAllowed(groupId)
    ) {
      return null;
    }

    const now = Date.now();
    const cached = this.#groupNameCache.get(groupId);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const info = await this.getGroupInfo(groupId);
    const name = cleanOneBotName(info?.group_name);

    this.#groupNameCache.set(groupId, {
      value: name,
      expiresAt: now + (name ? NAME_CACHE_TTL_MS : NAME_FAILURE_COOLDOWN_MS),
    });

    return name;
  }

  public async getGroupMemberList(groupId: string): Promise<
    {
      user_id: number;
      nickname: string;
      card?: string;
      role?: string;
      title?: string;
    }[]
  > {
    if (!this.#transport.configured) {
      return [];
    }

    const { body } = await this.#transport.callAction<
      {
        user_id: number;
        nickname: string;
        card?: string;
        role?: string;
        title?: string;
      }[]
    >("get_group_member_list", { group_id: Number(groupId) });
    const members = body.data ?? [];
    const memberMap = new Map<string, GroupMemberProfile>();

    for (const member of members) {
      const name =
        cleanOneBotName(member.card) ?? cleanOneBotName(member.nickname);
      const role: QqGroupRole =
        member.role === "owner" || member.role === "admin"
          ? member.role
          : "member";
      const title = member.title?.trim() || null;

      memberMap.set(String(member.user_id), { name, role, title });
    }

    this.#groupMembersCache.set(groupId, {
      members: memberMap,
      ok: true,
      expiresAt: Date.now() + NAME_CACHE_TTL_MS,
    });

    return members;
  }

  public async getGroupMemberProfile(
    groupId: string,
    userId: string,
  ): Promise<GroupMemberProfile | null> {
    const members = await this.#getCachedGroupMembers(groupId);

    return members?.get(userId) ?? null;
  }

  public async getGroupMemberName(
    groupId: string,
    userId: string,
  ): Promise<string | null> {
    const members = await this.#getCachedGroupMembers(groupId);

    return (
      members?.get(userId)?.name ?? (await this.getUserDisplayName(userId))
    );
  }

  public async enrichMentionNames(
    kind: ChatKind,
    chatId: string,
    segments: OneBotSegment[],
    botQQ: string,
  ): Promise<boolean> {
    if (!this.#transport.configured) {
      return false;
    }

    let changed = false;

    for (const seg of segments) {
      if (seg.type !== "at") {
        continue;
      }

      const qq = String(seg.data.qq ?? "").trim();

      if (!qq || qq === "all" || qq === botQQ || !/^\d+$/.test(qq)) {
        continue;
      }

      const rawName =
        typeof seg.data.name === "string"
          ? seg.data.name.trim().replace(/^@+/, "").trim()
          : "";
      const existingName =
        rawName && rawName !== qq ? cleanOneBotName(rawName) : null;

      if (existingName) {
        if (seg.data.name !== existingName) {
          seg.data.name = existingName;
          changed = true;
        }

        continue;
      }

      const name =
        kind === "group"
          ? await this.getGroupMemberName(chatId, qq)
          : await this.getUserDisplayName(qq);

      if (name) {
        seg.data.name = name;
        changed = true;
      }
    }

    return changed;
  }

  public async getFriendList(): Promise<
    { user_id: number; nickname: string; remark?: string }[]
  > {
    if (!this.#transport.configured) {
      return [];
    }

    const { body } =
      await this.#transport.callAction<
        { user_id: number; nickname: string; remark?: string }[]
      >("get_friend_list");
    const friends = body.data ?? [];
    const expiresAt = Date.now() + NAME_CACHE_TTL_MS;

    for (const friend of friends) {
      const name =
        cleanOneBotName(friend.remark) ?? cleanOneBotName(friend.nickname);

      if (name) {
        this.#userNameCache.set(String(friend.user_id), {
          value: name,
          expiresAt,
        });
      }
    }

    return friends;
  }

  public async getStrangerInfo(userId: string): Promise<StrangerInfo | null> {
    if (!this.#transport.configured) {
      return null;
    }

    const numericId = Number(userId);

    if (!Number.isFinite(numericId)) {
      return null;
    }

    try {
      const { body } = await this.#transport.callAction<StrangerInfo>(
        "get_stranger_info",
        { user_id: numericId },
      );

      return body.status === "failed" ? null : (body.data ?? null);
    } catch {
      return null;
    }
  }

  public async getUserDisplayName(userId: string): Promise<string | null> {
    if (!this.#transport.configured) {
      return null;
    }

    const now = Date.now();
    const cached = this.#userNameCache.get(userId);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const info = await this.getStrangerInfo(userId);
    const name =
      cleanOneBotName(info?.remark) ??
      cleanOneBotName(info?.nickname) ??
      cleanOneBotName(info?.nick);

    this.#userNameCache.set(userId, {
      value: name,
      expiresAt: now + (name ? NAME_CACHE_TTL_MS : NAME_FAILURE_COOLDOWN_MS),
    });

    return name;
  }

  public async resolveChatTitle(
    kind: ChatKind,
    chatId: string,
  ): Promise<string | null> {
    return kind === "group"
      ? this.getGroupName(chatId)
      : this.getUserDisplayName(chatId);
  }

  public async resolveSenderName(input: {
    userId: string;
    isBot: boolean;
    card?: string | null;
    nickname?: string | null;
  }): Promise<string> {
    if (input.isBot) {
      return this.#transport.getSettings()?.bot.names[0]?.trim() || "树莓娘";
    }

    const direct =
      cleanOneBotName(input.card) ?? cleanOneBotName(input.nickname);

    if (direct) {
      return direct;
    }

    return (await this.getUserDisplayName(input.userId)) ?? input.userId;
  }

  public async ensureChatWithTitle(
    kind: ChatKind,
    chatId: string,
    options: {
      titleHint?: string | null;
      enabled: boolean;
      triggerMode: GroupTriggerMode;
    },
  ): Promise<ChatConfig> {
    const hint = cleanOneBotName(options.titleHint);
    const chat = await this.#store.chats.ensure(kind, chatId, {
      ...(hint ? { title: hint } : {}),
      enabled: options.enabled,
      triggerMode: options.triggerMode,
    });

    if (chat.title.trim()) {
      return chat;
    }

    const resolved = await this.resolveChatTitle(kind, chatId);

    if (!resolved) {
      return chat;
    }

    return this.#store.chats.ensure(kind, chatId, {
      title: resolved,
      enabled: chat.enabled,
      triggerMode: chat.triggerMode,
    });
  }

  public async backfillEmptyChatTitles(): Promise<number> {
    if (!this.#transport.configured) {
      return 0;
    }

    const chats = (await this.#store.chats.list()).filter(
      (chat) => !chat.title.trim(),
    );

    if (chats.length === 0) {
      return 0;
    }

    if (chats.some((chat) => chat.kind === "group")) {
      await this.getGroupList().catch(() => []);
    }

    if (chats.some((chat) => chat.kind === "private")) {
      await this.getFriendList().catch(() => []);
    }

    let updated = 0;

    for (const chat of chats) {
      const resolved = await this.resolveChatTitle(chat.kind, chat.chatId);

      if (resolved) {
        await this.#store.chats.ensure(chat.kind, chat.chatId, {
          title: resolved,
          enabled: chat.enabled,
          triggerMode: chat.triggerMode,
        });
        updated++;
      }
    }

    return updated;
  }

  async #getCachedGroupMembers(
    groupId: string,
  ): Promise<Map<string, GroupMemberProfile> | null> {
    if (!this.#transport.configured) {
      return null;
    }

    const now = Date.now();
    const cached = this.#groupMembersCache.get(groupId);

    if (cached && cached.expiresAt > now) {
      return cached.members;
    }

    const existing = this.#inFlightGroupMembers.get(groupId);

    if (existing) {
      return existing;
    }

    const task = (async () => {
      try {
        await this.getGroupMemberList(groupId);

        return this.#groupMembersCache.get(groupId)?.members ?? null;
      } catch {
        this.#groupMembersCache.set(groupId, {
          members: new Map(),
          ok: false,
          expiresAt: Date.now() + NAME_FAILURE_COOLDOWN_MS,
        });

        return null;
      } finally {
        this.#inFlightGroupMembers.delete(groupId);
      }
    })();

    this.#inFlightGroupMembers.set(groupId, task);

    return task;
  }
}
