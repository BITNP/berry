import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

import { Kysely, SqliteDialect } from "kysely";

import type { BerryDb, BerryTables } from "./schema.ts";
import { migrateBerryDatabase } from "./schema.ts";

export class BerryDatabase {
  public readonly db: BerryDb;
  public readonly dataDir: string;
  public readonly assetsDir: string;
  public readonly avatarsDir: string;
  #sqlite: DatabaseSync;
  #txQueue: Promise<void> = Promise.resolve();

  private constructor(
    db: BerryDb,
    sqlite: DatabaseSync,
    dirs: {
      dataDir: string;
      assetsDir: string;
      avatarsDir: string;
    },
  ) {
    this.db = db;
    this.#sqlite = sqlite;
    this.dataDir = dirs.dataDir;
    this.assetsDir = dirs.assetsDir;
    this.avatarsDir = dirs.avatarsDir;
  }

  public static async open(dataDir: string): Promise<BerryDatabase> {
    const assetsDir = join(dataDir, "assets");
    const avatarsDir = join(dataDir, "avatars");

    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(join(assetsDir, "images"), { recursive: true }),
      mkdir(avatarsDir, { recursive: true }),
    ]);

    const sqlite = new DatabaseSync(join(dataDir, "berry.sqlite"));

    sqlite.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    sqlite.function("contains_text", { deterministic: true }, (value, query) =>
      Number(
        new RegExp(
          String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        ).test(String(value)),
      ),
    );

    const db = new Kysely<BerryTables>({
      dialect: new SqliteDialect({
        database: {
          close: () => sqlite.close(),
          prepare(query) {
            const statement = sqlite.prepare(query);

            return {
              reader: statement.columns().length > 0,
              all: (parameters) =>
                statement.all(...(parameters as SQLInputValue[])),
              run: (parameters) =>
                statement.run(...(parameters as SQLInputValue[])),
              iterate: (parameters) =>
                statement.iterate(...(parameters as SQLInputValue[])),
            };
          },
        },
      }),
    });

    await migrateBerryDatabase(db);

    return new BerryDatabase(db, sqlite, {
      dataDir,
      assetsDir,
      avatarsDir,
    });
  }

  // Serialize transactions on the single SQLite connection so concurrent workers never nest BEGIN.
  public writeTx<T>(fn: (trx: BerryDb) => Promise<T>): Promise<T> {
    const run = this.#txQueue.then(() =>
      this.db.transaction().execute((trx) => fn(trx)),
    );

    this.#txQueue = run.then(
      () => {},
      () => {},
    );

    return run;
  }

  public async close(): Promise<void> {
    await this.#txQueue;
    await this.db.destroy();
    if (this.#sqlite.isOpen) {
      this.#sqlite.close();
    }
  }
}
