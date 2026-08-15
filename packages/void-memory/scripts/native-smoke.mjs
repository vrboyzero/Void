import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// Minimal smoke: prove better-sqlite3 + sqlite-vec native deps load and a
// FTS5 + vec0 hybrid round-trip works on this platform.
const db = new Database(":memory:");
sqliteVec.load(db);

db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
db.prepare("INSERT INTO docs (content) VALUES (?)").run("hello void memory");
const fts = db.prepare("SELECT content FROM docs WHERE docs MATCH ?").get("void");
console.log("FTS5 hit:", fts);

db.exec("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4])");
db.prepare("INSERT INTO vec_items (rowid, embedding) VALUES (?, ?)").run(1n, new Float32Array([0.1, 0.2, 0.3, 0.4]));
const vec = db.prepare("SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? AND k = 1").get(new Float32Array([0.1, 0.2, 0.3, 0.4]));
console.log("vec0 hit:", vec);

db.close();
console.log("native deps OK");
