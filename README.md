# Telegram Welcome Guard Bot 🤖

Advanced Telegram bot with captcha verification for new members.

## ✨ Features

- ✅ Admin commands: `/add`, `/remove`, `/stats`
- 👋 Welcome message with math captcha
- ⏰ Auto-kick users who don't solve captcha
- 💾 PostgreSQL database for persistence
- 🔒 Works only in allowed groups
- 📊 Track pending verifications

## 🚀 Deployment on Railway

1. Fork this repository to your GitHub
2. Create a new project on Railway
3. Connect your GitHub repository
4. Add environment variables:
   - `BOT_TOKEN`: Your Telegram bot token
   - `BOT_ADMIN_ID`: Your Telegram user ID
   - `DATABASE_URL`: Railway PostgreSQL URL
   - `WEBHOOK_URL`: Your Railway app URL
5. Deploy!

## 📝 Commands (Admin only)

- `/add -100GROUP_ID` - Add a group
- `/remove -100GROUP_ID` - Remove a group
- `/stats` - Show bot statistics

## ⚙️ How it works

1. Admin adds a group using `/add`
2. When new member joins, bot sends captcha
3. User must reply with correct answer within 120 seconds
4. If correct → verified ✅
5. If wrong/timed out → kicked ⏰

## 🛠️ Technologies

- Node.js
- Telegraf
- PostgreSQL
- Railway
