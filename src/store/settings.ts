import type { EnvConfig } from "../config/env.ts";
import type { RuntimeSettings } from "../config/settings.ts";
import { parseSettings, seedSettingsFromEnv } from "../config/settings.ts";
import type { BerryDatabase } from "./database.ts";

export class SettingsStore {
  #database: BerryDatabase;

  constructor(database: BerryDatabase) {
    this.#database = database;
  }

  public async loadOrSeed(env: EnvConfig): Promise<RuntimeSettings> {
    const row = await this.#database.db
      .selectFrom("settings")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirst();

    if (!row) {
      const seeded = seedSettingsFromEnv(env);

      await this.save(seeded);

      return seeded;
    }

    return parseSettings(JSON.parse(row.data_json));
  }

  public async load(): Promise<RuntimeSettings> {
    const row = await this.#database.db
      .selectFrom("settings")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();

    return parseSettings(JSON.parse(row.data_json));
  }

  public async save(settings: RuntimeSettings): Promise<RuntimeSettings> {
    const validated = parseSettings(settings);
    const now = Date.now();
    const dataJson = JSON.stringify(validated);

    await this.#database.writeTx(async (trx) => {
      await trx
        .insertInto("settings")
        .values({ id: 1, data_json: dataJson, updated_at: now })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({ data_json: dataJson, updated_at: now }),
        )
        .execute();
    });

    return validated;
  }
}
