
import type Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export function loadSqliteVec(db: Database.Database): void {
    sqliteVec.load(db);
}
