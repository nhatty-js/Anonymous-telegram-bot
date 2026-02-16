import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
import { initDb, pool } from "./db.js";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN || !GROUP_CHAT_ID) {
  throw new Error("BOT_TOKEN and GROUP_CHAT_ID are required in .env.");
}

const GROUP_TOPICS = {
  discussion1: { id: 170, label: "Discussion 1" },
  discussion2: { id: 171, label: "Discussion 2" },
  discussion3: { id: 172, label: "Discussion 3" },
};

const userSessions = new Map();

const bot = WEBHOOK_URL
  ? new TelegramBot(BOT_TOKEN, { polling: false })
  : new TelegramBot(BOT_TOKEN, { polling: true });

async function getPostByTelegramMessageId(telegramMessageId) {
  const postResult = await pool.query(
    `select * from posts where telegram_message_id = $1`,
    [telegramMessageId]
  );
  return postResult.rows[0] || null;
}

async function getCommentWithReactionCounts(postId) {
  const commentResult = await pool.query(
    `
    select
      c.*,
      coalesce(sum(case when r.reaction = 'love' then 1 else 0 end), 0) as love,
      coalesce(sum(case when r.reaction = 'support' then 1 else 0 end), 0) as support,
      coalesce(sum(case when r.reaction = 'amen' then 1 else 0 end), 0) as amen,
      coalesce(sum(case when r.reaction = 'agree' then 1 else 0 end), 0) as agree,
      coalesce(sum(case when r.reaction = 'disagree' then 1 else 0 end), 0) as disagree
    from comments c
    left join reactions r on r.comment_id = c.id
    where c.post_id = $1
    group by c.id
    order by c.created_at asc
    `,
    [postId]
  );

  const byParent = new Map();
  const byId = new Map();

  for (const row of commentResult.rows) {
    const node = {
      id: row.id,
      parent_comment_id: row.parent_comment_id,
      text: row.content,
      media: row.media_type
        ? { type: row.media_type, id: row.media_file_id }
        : null,
      reactions: {
        love: Number(row.love),
        support: Number(row.support),
        amen: Number(row.amen),
        agree: Number(row.agree),
        disagree: Number(row.disagree),
      },
      replies: [],
    };

    byId.set(node.id, node);
    const key = node.parent_comment_id || 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }

  for (const [id, node] of byId.entries()) {
    node.replies = byParent.get(id) || [];
  }

  return byParent.get(0) || [];
}

function commentKeyboard(postTelegramId, commentId, reactions) {
  return {
    inline_keyboard: [
      [
        { text: `❤️ ${reactions.love}`, callback_data: `react_love_${postTelegramId}_${commentId}` },
        { text: `🙌 ${reactions.support}`, callback_data: `react_support_${postTelegramId}_${commentId}` },
        { text: `🙏 ${reactions.amen}`, callback_data: `react_amen_${postTelegramId}_${commentId}` },
      ],
      [
        { text: `🤝 ${reactions.agree}`, callback_data: `react_agree_${postTelegramId}_${commentId}` },
        { text: `🙅 ${reactions.disagree}`, callback_data: `react_disagree_${postTelegramId}_${commentId}` },
      ],
      [{ text: "↩️ Reply", callback_data: `reply_${postTelegramId}_${commentId}` }],
    ],
  };
}

async function sendCommentTree(chatId, postTelegramId, comments, prefix = "") {
  for (let i = 0; i < comments.length; i += 1) {
    const c = comments[i];
    const label = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;

    await bot.sendMessage(chatId, `💭 *Comment ${label}:*`, { parse_mode: "Markdown" });

    const replyMarkup = commentKeyboard(postTelegramId, c.id, c.reactions);
    if (c.media) {
      if (c.media.type === "photo") await bot.sendPhoto(chatId, c.media.id, { reply_markup: replyMarkup });
      if (c.media.type === "video") await bot.sendVideo(chatId, c.media.id, { reply_markup: replyMarkup });
      if (c.media.type === "animation") await bot.sendAnimation(chatId, c.media.id, { reply_markup: replyMarkup });
      if (c.media.type === "sticker") await bot.sendSticker(chatId, c.media.id, { reply_markup: replyMarkup });
      if (c.media.type === "document") await bot.sendDocument(chatId, c.media.id, { reply_markup: replyMarkup });
    }
    if (c.text) {
      await bot.sendMessage(chatId, c.text, {
        reply_markup: replyMarkup,
      });
    }

    if (c.replies.length) {
      await sendCommentTree(chatId, postTelegramId, c.replies, label);
    }
  }
}

async function updateCommentButton(postTelegramMessageId) {
  const post = await getPostByTelegramMessageId(postTelegramMessageId);
  if (!post) return;

  const countResult = await pool.query(
    `select count(*)::int as count from comments where post_id = $1 and parent_comment_id is null`,
    [post.id]
  );

  const total = countResult.rows[0].count;
  const me = await bot.getMe();
  await bot.editMessageReplyMarkup(
    {
      inline_keyboard: [
        [{ text: `💬 ${total} Comments`, url: `https://t.me/${me.username}?start=comment_${postTelegramMessageId}` }],
      ],
    },
    { chat_id: GROUP_CHAT_ID, message_id: Number(postTelegramMessageId) }
  );
}

function extractMedia(msg) {
  if (msg.photo?.length) return { type: "photo", id: msg.photo.at(-1).file_id };
  if (msg.video) return { type: "video", id: msg.video.file_id };
  if (msg.animation) return { type: "animation", id: msg.animation.file_id };
  if (msg.sticker) return { type: "sticker", id: msg.sticker.file_id };
  if (msg.document) return { type: "document", id: msg.document.file_id };
  return null;
}

bot.setMyCommands([
  { command: "start", description: "Start" },
  { command: "post", description: "Create anonymous post" },
  { command: "help", description: "Help" },
]);

bot.onText(/\/start$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  await bot.sendMessage(msg.chat.id, "Welcome! Choose an action.", {
    reply_markup: {
      keyboard: [[{ text: "📝 Post" }, { text: "ℹ️ Help" }]],
      resize_keyboard: true,
    },
  });
});

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Use 📝 Post in private chat to publish anonymously.");
});

bot.onText(/\/start comment_(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramMessageId = Number(match[1]);

  const post = await getPostByTelegramMessageId(telegramMessageId);
  if (!post) {
    await bot.sendMessage(chatId, "⚠️ Post not found.");
    return;
  }

  if (post.media_type) {
    const caption = post.content || "";
    if (post.media_type === "photo") await bot.sendPhoto(chatId, post.media_file_id, { caption });
    if (post.media_type === "video") await bot.sendVideo(chatId, post.media_file_id, { caption });
    if (post.media_type === "animation") await bot.sendAnimation(chatId, post.media_file_id, { caption });
    if (post.media_type === "sticker") await bot.sendSticker(chatId, post.media_file_id);
    if (post.media_type === "document") await bot.sendDocument(chatId, post.media_file_id, { caption });
  } else {
    await bot.sendMessage(chatId, `🗣 *Post:*\n${post.content || ""}`, { parse_mode: "Markdown" });
  }

  const comments = await getCommentWithReactionCounts(post.id);
  if (comments.length) {
    await sendCommentTree(chatId, telegramMessageId, comments);
  } else {
    await bot.sendMessage(chatId, "No comments yet. Be the first one.");
  }

  userSessions.set(chatId, { step: "commenting", postTelegramMessageId: telegramMessageId });
  await bot.sendMessage(chatId, "💬 Write your comment, or /cancel.");
});

bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const media = extractMedia(msg);
  const session = userSessions.get(chatId) || {};

  if (text === "/cancel" || text === "🚫 Cancel" || text === "❌ Cancel") {
    userSessions.delete(chatId);
    await bot.sendMessage(chatId, "Cancelled.");
    return;
  }

  if (text === "📝 Post" || text === "/post") {
    userSessions.set(chatId, { step: "typing" });
    await bot.sendMessage(chatId, "Send text or media for your anonymous post.");
    return;
  }

  if (session.step === "typing") {
    if (!text && !media) return;
    userSessions.set(chatId, {
      step: "choose_topic",
      text: media ? "" : text,
      media,
      caption: "",
    });

    if (media && media.type !== "sticker") {
      userSessions.set(chatId, { ...userSessions.get(chatId), step: "captioning" });
      await bot.sendMessage(chatId, "Send caption now, or type Skip.");
      return;
    }

    await bot.sendMessage(chatId, "Select topic:", {
      reply_markup: {
        keyboard: [
          [{ text: GROUP_TOPICS.discussion1.label }],
          [{ text: GROUP_TOPICS.discussion2.label }],
          [{ text: GROUP_TOPICS.discussion3.label }],
          [{ text: "🚫 Cancel" }],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (session.step === "captioning") {
    const updated = { ...session, caption: text === "Skip" ? "" : text, step: "choose_topic" };
    userSessions.set(chatId, updated);
    await bot.sendMessage(chatId, "Select topic:", {
      reply_markup: {
        keyboard: [
          [{ text: GROUP_TOPICS.discussion1.label }],
          [{ text: GROUP_TOPICS.discussion2.label }],
          [{ text: GROUP_TOPICS.discussion3.label }],
          [{ text: "🚫 Cancel" }],
        ],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (session.step === "choose_topic") {
    const topic = Object.values(GROUP_TOPICS).find((x) => x.label === text);
    if (!topic) return;

    const finalSession = { ...session, topicId: topic.id, step: "confirming" };
    userSessions.set(chatId, finalSession);

    if (finalSession.media) {
      await bot.sendMessage(chatId, `Preview ready. Topic: ${topic.label}`);
    } else {
      await bot.sendMessage(chatId, `🕵️ Preview:\n\n${finalSession.text || ""}`);
    }

    await bot.sendMessage(chatId, "Submit?", {
      reply_markup: {
        keyboard: [[{ text: "✅ Submit" }, { text: "✏️ Edit" }], [{ text: "🚫 Cancel" }]],
        resize_keyboard: true,
      },
    });
    return;
  }

  if (session.step === "confirming" && text === "✏️ Edit") {
    userSessions.set(chatId, { step: "typing" });
    await bot.sendMessage(chatId, "Send new content.");
    return;
  }

  if (session.step === "confirming" && text === "✅ Submit") {
    const member = await bot.getChatMember(GROUP_CHAT_ID, msg.from.id);
    if (!["member", "administrator", "creator"].includes(member.status)) {
      await bot.sendMessage(chatId, "🚫 You must be a group member.");
      return;
    }

    let sent;
    const caption = session.caption || "";
    if (session.media) {
      if (session.media.type === "photo") {
        sent = await bot.sendPhoto(GROUP_CHAT_ID, session.media.id, { caption, message_thread_id: session.topicId });
      }
      if (session.media.type === "video") {
        sent = await bot.sendVideo(GROUP_CHAT_ID, session.media.id, { caption, message_thread_id: session.topicId });
      }
      if (session.media.type === "animation") {
        sent = await bot.sendAnimation(GROUP_CHAT_ID, session.media.id, { caption, message_thread_id: session.topicId });
      }
      if (session.media.type === "sticker") {
        sent = await bot.sendSticker(GROUP_CHAT_ID, session.media.id, { message_thread_id: session.topicId });
      }
      if (session.media.type === "document") {
        sent = await bot.sendDocument(GROUP_CHAT_ID, session.media.id, { caption, message_thread_id: session.topicId });
      }
    } else {
      sent = await bot.sendMessage(GROUP_CHAT_ID, session.text, { parse_mode: "Markdown", message_thread_id: session.topicId });
    }

    await pool.query(
      `insert into posts (telegram_message_id, chat_id, content, media_type, media_file_id, topic_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [sent.message_id, GROUP_CHAT_ID, session.media ? caption : session.text, session.media?.type || null, session.media?.id || null, session.topicId]
    );

    await updateCommentButton(sent.message_id);
    userSessions.delete(chatId);
    await bot.sendMessage(chatId, "✅ Posted successfully.");
    return;
  }

  if (session.step === "commenting" && (text || media)) {
    const post = await getPostByTelegramMessageId(session.postTelegramMessageId);
    if (!post) {
      userSessions.delete(chatId);
      await bot.sendMessage(chatId, "⚠️ Post not found.");
      return;
    }

    await pool.query(
      `insert into comments (post_id, content, media_type, media_file_id) values ($1, $2, $3, $4)`,
      [post.id, media ? "" : text, media?.type || null, media?.id || null]
    );

    await updateCommentButton(session.postTelegramMessageId);
    userSessions.delete(chatId);
    await bot.sendMessage(chatId, "✅ Comment sent.");
    return;
  }

  if (session.step === "replying" && (text || media)) {
    const post = await getPostByTelegramMessageId(session.postTelegramMessageId);
    if (!post) {
      userSessions.delete(chatId);
      await bot.sendMessage(chatId, "⚠️ Post not found.");
      return;
    }

    await pool.query(
      `insert into comments (post_id, parent_comment_id, content, media_type, media_file_id)
       values ($1, $2, $3, $4, $5)`,
      [post.id, session.parentCommentId, media ? "" : text, media?.type || null, media?.id || null]
    );

    userSessions.delete(chatId);
    await bot.sendMessage(chatId, "✅ Reply sent.");
  }
});

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const chatId = query.message?.chat.id;

  if (data.startsWith("reply_")) {
    const [, postTelegramMessageId, parentCommentId] = data.split("_");
    userSessions.set(chatId, {
      step: "replying",
      postTelegramMessageId: Number(postTelegramMessageId),
      parentCommentId: Number(parentCommentId),
    });
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, "Write your reply now, or /cancel.");
    return;
  }

  if (data.startsWith("react_")) {
    const [, reaction, postTelegramMessageId, commentId] = data.split("_");
    const userId = query.from.id;

    const exists = await pool.query(
      `select id from reactions where comment_id = $1 and user_id = $2 and reaction = $3`,
      [commentId, userId, reaction]
    );

    if (exists.rows.length) {
      await pool.query(`delete from reactions where id = $1`, [exists.rows[0].id]);
      await bot.answerCallbackQuery(query.id, { text: `Removed ${reaction}` });
    } else {
      await pool.query(
        `insert into reactions (comment_id, user_id, reaction) values ($1, $2, $3) on conflict do nothing`,
        [commentId, userId, reaction]
      );
      await bot.answerCallbackQuery(query.id, { text: `Added ${reaction}` });
    }

    const countResult = await pool.query(
      `
      select
        coalesce(sum(case when reaction = 'love' then 1 else 0 end),0) as love,
        coalesce(sum(case when reaction = 'support' then 1 else 0 end),0) as support,
        coalesce(sum(case when reaction = 'amen' then 1 else 0 end),0) as amen,
        coalesce(sum(case when reaction = 'agree' then 1 else 0 end),0) as agree,
        coalesce(sum(case when reaction = 'disagree' then 1 else 0 end),0) as disagree
      from reactions
      where comment_id = $1
      `,
      [commentId]
    );

    await bot.editMessageReplyMarkup(commentKeyboard(postTelegramMessageId, commentId, countResult.rows[0]), {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
  }
});

async function start() {
  await initDb();

  if (WEBHOOK_URL) {
    const app = express();
    app.use(bodyParser.json());

    const webhookPath = "/webhook";
    await bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`);

    app.post(webhookPath, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    app.listen(PORT, () => {
      console.log(`Webhook mode listening on ${PORT}`);
    });
  } else {
    console.log("Polling mode started.");
  }
}

start().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
