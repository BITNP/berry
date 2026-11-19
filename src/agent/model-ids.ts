import { createHash } from "node:crypto";

import type { ChatKey } from "../types.ts";
import { makeChatKey } from "../types.ts";

export class ModelIds {
  #toRef = new Map<string, string>();

  #fromRef = new Map<
    string,
    { kind: "user" | "group" | "msg"; rawId: string; chatKey?: ChatKey }
  >();

  public userRef(rawUserId: string): string {
    return this.#register("user", "u", rawUserId);
  }

  public groupRef(rawGroupId: string): string {
    return this.#register("group", "g", rawGroupId);
  }

  public messageRef(rawOnebotMessageId: string, chatKey?: ChatKey): string {
    return this.#register("msg", "m", rawOnebotMessageId, chatKey);
  }

  public resolveUser(ref: string): string {
    return this.#resolve("user", ref).rawId;
  }

  public resolveMessageMeta(ref: string): {
    rawId: string;
    chatKey?: ChatKey;
  } {
    const entry = this.#resolve("msg", ref);

    return { rawId: entry.rawId, chatKey: entry.chatKey };
  }

  public resolveTargetChatKey(ref: string): ChatKey {
    const clean = ref.trim();
    const entry = this.#fromRef.get(clean);

    if (!entry) {
      throw new Error(`Unknown target reference: ${ref}`);
    }

    if (entry.kind === "group") {
      return makeChatKey("group", entry.rawId);
    }

    if (entry.kind === "user") {
      return makeChatKey("private", entry.rawId);
    }

    throw new Error(`Reference ${ref} is a message ref, expected g_* or u_*`);
  }

  #register(
    kind: "user" | "group" | "msg",
    prefix: string,
    rawId: string,
    chatKey?: ChatKey,
  ): string {
    const clean = rawId.trim();

    if (!clean) {
      return "";
    }

    const key =
      kind === "msg" && chatKey
        ? `${kind}:${chatKey}:${clean}`
        : `${kind}:${clean}`;
    const existing = this.#toRef.get(key);

    if (existing) {
      const stored = this.#fromRef.get(existing);

      if (stored && chatKey && !stored.chatKey) {
        stored.chatKey = chatKey;
      }

      return existing;
    }

    const digestHex = createHash("sha256").update(key).digest("hex");
    const slug = BigInt(`0x${digestHex.slice(0, 16)}`)
      .toString(36)
      .padStart(12, "0");

    let len = 6;
    let ref = `${prefix}_${slug.slice(0, len)}`;

    while (this.#fromRef.has(ref)) {
      len++;
      ref =
        len <= slug.length
          ? `${prefix}_${slug.slice(0, len)}`
          : `${prefix}_${slug}_${len}`;
    }

    this.#toRef.set(key, ref);
    this.#fromRef.set(ref, {
      kind,
      rawId: clean,
      ...(chatKey ? { chatKey } : {}),
    });

    return ref;
  }

  #resolve(
    expectedKind: "user" | "group" | "msg",
    ref: string,
  ): { kind: "user" | "group" | "msg"; rawId: string; chatKey?: ChatKey } {
    const entry = this.#fromRef.get(ref.trim());

    if (!entry) {
      throw new Error(`Unknown ${expectedKind} reference: ${ref}`);
    }

    if (entry.kind !== expectedKind) {
      throw new Error(
        `Reference ${ref} has kind ${entry.kind}, expected ${expectedKind}`,
      );
    }

    return entry;
  }
}
