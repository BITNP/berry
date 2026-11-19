import { randomBytes } from "node:crypto";

import type { SitePermissions } from "bitnp-authz";

import type { BerryDatabase } from "./database.ts";

export interface AdminSession {
  id: string;
  subject: string;
  name: string;
  email: string;
  avatar: string;
  permissions: SitePermissions;
  csrfToken: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class AdminSessionsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async create(input: {
    subject: string;
    name: string;
    email: string;
    avatar: string;
    permissions: SitePermissions;
  }): Promise<AdminSession> {
    const now = Date.now();
    const id = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("admin_sessions")
        .values({
          id,
          subject: input.subject,
          name: input.name,
          email: input.email,
          avatar: input.avatar,
          permissions_json: JSON.stringify(input.permissions),
          csrf_token: csrfToken,
          expires_at: expiresAt,
          created_at: now,
        })
        .execute();
    });

    return {
      id,
      subject: input.subject,
      name: input.name,
      email: input.email,
      avatar: input.avatar,
      permissions: input.permissions,
      csrfToken,
      expiresAt,
    };
  }

  public async get(id: string): Promise<AdminSession | null> {
    if (!id) {
      return null;
    }

    const row = await this.#database.db
      .selectFrom("admin_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    const now = Date.now();

    if (row.expires_at <= now) {
      await this.delete(id);

      return null;
    }

    return {
      id: row.id,
      subject: row.subject,
      name: row.name,
      email: row.email,
      avatar: row.avatar,
      permissions: JSON.parse(row.permissions_json) as SitePermissions,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    };
  }

  public async delete(id: string): Promise<void> {
    await this.#database.writeTx(async (trx) => {
      await trx.deleteFrom("admin_sessions").where("id", "=", id).execute();
    });
  }

  public async pruneExpired(): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .deleteFrom("admin_sessions")
        .where("expires_at", "<=", now)
        .execute();
    });
  }
}
