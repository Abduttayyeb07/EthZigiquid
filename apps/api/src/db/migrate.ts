import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

const migrationUrl = new URL("./migrations/0001_initial.sql", import.meta.url);
const sql = await readFile(fileURLToPath(migrationUrl), "utf8");
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });

try {
  await pool.query(sql);
  process.stdout.write("Database migration completed.\n");
} finally {
  await pool.end();
}

