import dotenv from "dotenv";
dotenv.config();

import { Telegraf } from "telegraf";
import { pool, initDB } from "./db.js";

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.BOT_ADMIN_ID);

await initDB();

function isAdmin(ctx) {
  return ctx.from.id === ADMIN_ID;
}

async function isAllowedGroup(groupId) {
  const res = await pool.query(
    "SELECT 1 FROM allowed_groups WHERE group_id=$1",
    [groupId]
  );
  return res.rowCount > 0;
}

/* ---------------- ADMIN COMMANDS ---------------- */

// ADD GROUP
bot.command("add", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ");
  const groupId = args[1];

  if (!groupId) return ctx.reply("Usage: /add -100xxxxxxxx");

  await pool.query(
    "INSERT INTO allowed_groups (group_id, group_title) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [groupId, "Manual Added"]
  );

  await pool.query(
    "INSERT INTO group_settings (group_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [groupId]
  );

  ctx.reply("✅ Group added successfully.");
});

// REMOVE GROUP
bot.command("remove", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const args = ctx.message.text.split(" ");
  const groupId = args[1];

  if (!groupId) return ctx.reply("Usage: /remove -100xxxxxxxx");

  await pool.query("DELETE FROM allowed_groups WHERE group_id=$1", [groupId]);
  await pool.query("DELETE FROM group_settings WHERE group_id=$1", [groupId]);

  ctx.reply("❌ Group removed.");
});

// STATS
bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const groups = await pool.query("SELECT * FROM allowed_groups");
  const pending = await pool.query("SELECT COUNT(*) FROM pending_captcha");

  let text = `📊 Bot Stats\n\n`;
  text += `Active Groups: ${groups.rowCount}\n`;
  text += `Pending Captchas: ${pending.rows[0].count}\n\n`;

  groups.rows.forEach((g, i) => {
    text += `${i + 1}. ${g.group_id}\n`;
  });

  ctx.reply(text);
});

/* ---------------- WELCOME + CAPTCHA ---------------- */

bot.on("new_chat_members", async (ctx) => {
  const groupId = ctx.chat.id;

  if (!(await isAllowedGroup(groupId))) return;

  const settingsRes = await pool.query(
    "SELECT * FROM group_settings WHERE group_id=$1",
    [groupId]
  );

  const settings = settingsRes.rows[0];
  const captchaTime = settings.captcha_time;

  for (let member of ctx.message.new_chat_members) {
    const a = Math.floor(Math.random() * 10);
    const b = Math.floor(Math.random() * 10);
    const correct = String(a + b);

    const msg = await ctx.reply(
      `👋 Welcome ${member.first_name}\n\nSolve this to stay:\n${a} + ${b} = ?`
    );

    const expireAt = new Date(Date.now() + captchaTime * 1000);

    await pool.query(
      "INSERT INTO pending_captcha VALUES ($1,$2,$3,$4,$5)",
      [member.id, groupId, correct, msg.message_id, expireAt]
    );
  }
});

/* ---------------- CAPTCHA ANSWER CHECK ---------------- */

bot.on("text", async (ctx) => {
  if (!ctx.chat || ctx.chat.type === "private") return;

  const groupId = ctx.chat.id;
  const userId = ctx.from.id;
  const answer = ctx.message.text;

  const res = await pool.query(
    "SELECT * FROM pending_captcha WHERE user_id=$1 AND group_id=$2",
    [userId, groupId]
  );

  if (res.rowCount === 0) return;

  const row = res.rows[0];

  if (answer === row.correct_answer) {
    await pool.query(
      "DELETE FROM pending_captcha WHERE user_id=$1 AND group_id=$2",
      [userId, groupId]
    );

    await ctx.reply("✅ Verified!");

    try {
      await bot.telegram.deleteMessage(groupId, row.message_id);
    } catch {}
  }
});

/* ---------------- CAPTCHA CLEANER ---------------- */

setInterval(async () => {
  const expired = await pool.query(
    "SELECT * FROM pending_captcha WHERE expire_at < NOW()"
  );

  for (let row of expired.rows) {
    try {
      await bot.telegram.banChatMember(row.group_id, row.user_id);
      await bot.telegram.unbanChatMember(row.group_id, row.user_id);
      await bot.telegram.deleteMessage(row.group_id, row.message_id);
    } catch {}

    await pool.query(
      "DELETE FROM pending_captcha WHERE user_id=$1 AND group_id=$2",
      [row.user_id, row.group_id]
    );
  }
}, 30000);

/* ---------------- WEBHOOK ---------------- */

const PORT = process.env.PORT || 3000;

bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/bot`);
bot.startWebhook("/bot", null, PORT);

console.log("🚀 Bot running via webhook...");
