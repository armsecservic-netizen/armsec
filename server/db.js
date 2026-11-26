// PostgreSQL storage: requests (leads), bot conversations, site settings, price changes, uploaded photos.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add a PostgreSQL database to the Railway project and link it to this service.");
  process.exit(1);
}
const needsSsl = process.env.PGSSL === "1" || /sslmode=require/.test(url);
export const pool = new pg.Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 8 });

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      visitor TEXT,
      lang TEXT,
      ip TEXT,
      page TEXT,
      lead_id INTEGER,
      msg_count INTEGER NOT NULL DEFAULT 0,
      created TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta JSONB,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages(chat_id, id);
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      note TEXT NOT NULL DEFAULT '',
      chat_id TEXT,
      created TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function kvGet(key, fallback) {
  const r = await pool.query("SELECT value FROM kv WHERE key=$1", [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
export async function kvSet(key, value) {
  await pool.query(
    "INSERT INTO kv(key,value,updated) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated=now()",
    [key, JSON.stringify(value)]
  );
}

export async function touchChat({ id, visitor, lang, ip, page }) {
  await pool.query(
    `INSERT INTO chats(id,visitor,lang,ip,page) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(id) DO UPDATE SET lang=EXCLUDED.lang, updated=now()`,
    [id, visitor || null, lang || null, ip || null, page || null]
  );
}
export async function addMessage(chatId, role, content, meta) {
  await pool.query("INSERT INTO messages(chat_id,role,content,meta) VALUES($1,$2,$3,$4)", [chatId, role, content, meta ? JSON.stringify(meta) : null]);
  await pool.query("UPDATE chats SET msg_count=msg_count+1, updated=now() WHERE id=$1", [chatId]);
}
export async function history(chatId, limit = 24) {
  const r = await pool.query("SELECT role, content FROM messages WHERE chat_id=$1 ORDER BY id DESC LIMIT $2", [chatId, limit]);
  return r.rows.reverse();
}

export async function createLead(data, chatId) {
  const r = await pool.query("INSERT INTO leads(data,chat_id) VALUES($1,$2) RETURNING id, created", [JSON.stringify(data), chatId || null]);
  const id = r.rows[0].id;
  if (chatId) await pool.query("UPDATE chats SET lead_id=$1 WHERE id=$2", [id, chatId]);
  return { id, created: r.rows[0].created };
}
