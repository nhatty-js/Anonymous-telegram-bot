import pg from "pg";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "";

if (!connectionString) {
  throw new Error(
    "Missing DATABASE_URL (or SUPABASE_DB_URL). Add your Supabase Postgres connection string in .env."
  );
}

export const pool = new Pool({
  connectionString,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    create table if not exists posts (
      id bigserial primary key,
      telegram_message_id bigint unique not null,
      chat_id text not null,
      content text,
      media_type text,
      media_file_id text,
      topic_id bigint,
      created_at timestamptz default now()
    );
  `);

  await pool.query(`
    create table if not exists comments (
      id bigserial primary key,
      post_id bigint not null references posts(id) on delete cascade,
      parent_comment_id bigint references comments(id) on delete cascade,
      content text,
      media_type text,
      media_file_id text,
      created_at timestamptz default now()
    );
  `);

  await pool.query(`
    create table if not exists reactions (
      id bigserial primary key,
      comment_id bigint not null references comments(id) on delete cascade,
      user_id bigint not null,
      reaction text not null check (reaction in ('love', 'support', 'amen', 'agree', 'disagree')),
      created_at timestamptz default now(),
      unique(comment_id, user_id, reaction)
    );
  `);
}
