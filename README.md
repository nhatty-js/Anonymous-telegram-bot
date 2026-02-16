# Anonymous Telegram Bot

A Telegram bot that lets users post and comment anonymously in a group, backed by Supabase PostgreSQL.

## 1) Setup

```bash
npm install
```

Create `.env`:

```env
BOT_TOKEN=123456:telegram-token
GROUP_CHAT_ID=-1001234567890
DATABASE_URL=postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres?sslmode=require
WEBHOOK_URL=https://your-render-service.onrender.com
PORT=3000
```

Notes:
- Use Supabase **Connection string** from `Project Settings -> Database`.
- Keep `sslmode=require` in the URL.
- For local polling mode, omit `WEBHOOK_URL`.

## 2) Run

```bash
npm start
```

The bot will:
- Create missing tables (`posts`, `comments`, `reactions`) automatically.
- Use webhook mode when `WEBHOOK_URL` exists.
- Otherwise use long polling mode.

## 3) Supported features

- Anonymous text or media posts to configured group/topic.
- Post comments via deep-link button.
- Nested replies.
- Reaction toggles persisted in Postgres.
- Comment count button updates on each new top-level comment.
