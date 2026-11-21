import type { BerryDatabase } from "./database.ts";

export class CursorsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async get(name: string): Promise<string | null> {
    const row = await this.#database.db
      .selectFrom("cursors")
      .select(["value"])
      .where("name", "=", name)
      .executeTakeFirst();

    return row?.value ?? null;
  }

  public async set(name: string, value: string): Promise<void> {
    const now = Date.now();

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("cursors")
        .values({ name, value, updated_at: now })
        .onConflict((oc) =>
          oc.column("name").doUpdateSet({ value, updated_at: now }),
        )
        .execute();
    });
  }
}
