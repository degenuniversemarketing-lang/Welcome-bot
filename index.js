const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const db = require('./db');

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const SUPER_ADMIN_ID = process.env.BOT_ADMIN_ID;

// Simple in-memory session store
const sessions = new Map();

// Track processed joins
const processedJoins = new Set();

// Initialize database and start bot
async function startBot() {
    const dbConnected = await db.initDatabase();
    if (!dbConnected) {
        console.error('Failed to connect to database. Exiting...');
        process.exit(1);
    }
    
    console.log('🚀 Advanced Welcome Bot is starting...');
    
    // Start cleaning expired captchas
    setInterval(cleanExpiredCaptchas, 30000);
    
    // Setup webhook
    if (process.env.WEBHOOK_URL) {
        try {
            await bot.telegram.deleteWebhook();
            const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;
            await bot.telegram.setWebhook(webhookUrl);
            console.log(`✅ Webhook set to: ${webhookUrl}`);
            
            const app = express();
            app.use(express.json());
            
            app.post('/webhook', (req, res) => {
                bot.handleUpdate(req.body, res);
            });
            
            app.get('/', (req, res) => {
                res.send('🤖 Welcome Bot is running!');
            });
            
            const port = process.env.PORT || 3000;
            app.listen(port, () => {
                console.log(`✅ Express server running on port ${port}`);
            });
        } catch (error) {
            console.error('Error setting up webhook:', error);
        }
    } else {
        await bot.launch();
        console.log('✅ Bot started with long polling');
    }
}

// Simple session middleware
function getSession(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, {});
    }
    return sessions.get(userId);
}

// ============ CAPTCHA GENERATORS ============
function generateMathCaptcha(difficulty = 'medium') {
    let a, b;
    
    switch(difficulty) {
        case 'easy':
            a = Math.floor(Math.random() * 5) + 1;
            b = Math.floor(Math.random() * 5) + 1;
            break;
        case 'hard':
            a = Math.floor(Math.random() * 50) + 1;
            b = Math.floor(Math.random() * 50) + 1;
            break;
        case 'medium':
        default:
            a = Math.floor(Math.random() * 10) + 1;
            b = Math.floor(Math.random() * 10) + 1;
    }
    
    return {
        question: `🧮 **Math Problem**\n${a} + ${b} = ?`,
        answer: (a + b).toString()
    };
}

function generateEmojiCaptcha() {
    const emojis = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼'];
    const count = Math.floor(Math.random() * 5) + 3;
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    const emojiString = emoji.repeat(count);
    
    return {
        question: `🔢 **Count the Emojis**\n${emojiString}\n\nHow many ${emoji} do you see?`,
        answer: count.toString()
    };
}

function generateTextCaptcha() {
    const words = ['welcome', 'verify', 'robot', 'human', 'guard', 'security'];
    const word = words[Math.floor(Math.random() * words.length)];
    
    return {
        question: `📝 **Type the Word**\nType this word exactly:\n\`${word}\``,
        answer: word
    };
}

function generateCaptcha(type = 'math', difficulty = 'medium') {
    switch(type) {
        case 'emoji':
            return generateEmojiCaptcha();
        case 'text':
            return generateTextCaptcha();
        case 'math':
        default:
            return generateMathCaptcha(difficulty);
    }
}

// ============ PUNISHMENT HANDLER ============
async function applyPunishment(ctx, groupId, userId, action, reason = 'Failed captcha') {
    try {
        switch(action) {
            case 'ban':
                await ctx.telegram.banChatMember(groupId, parseInt(userId));
                await ctx.reply(`🚫 User banned for: ${reason}`);
                break;
            case 'kick':
                await ctx.telegram.kickChatMember(groupId, parseInt(userId));
                await ctx.telegram.unbanChatMember(groupId, parseInt(userId));
                await ctx.reply(`👢 User kicked for: ${reason}`);
                break;
            case 'mute':
                const untilDate = Math.floor(Date.now() / 1000) + 3600;
                await ctx.telegram.restrictChatMember(groupId, parseInt(userId), {
                    permissions: {
                        can_send_messages: false,
                        can_send_media_messages: false,
                        can_send_polls: false,
                        can_send_other_messages: false,
                        can_add_web_page_previews: false,
                        can_change_info: false,
                        can_invite_users: false,
                        can_pin_messages: false
                    },
                    until_date: untilDate
                });
                await ctx.reply(`🔇 User muted for 1 hour for: ${reason}`);
                break;
            case 'remove':
                await ctx.reply(`⚠️ User removed from verification for: ${reason}`);
                break;
        }
    } catch (error) {
        console.error('Error applying punishment:', error);
    }
}

// ============ CLEAN EXPIRED CAPTCHAS ============
async function cleanExpiredCaptchas() {
    try {
        const expired = await db.getExpiredCaptchas();
        
        for (const captcha of expired) {
            try {
                const settings = await db.getGroupSettings(captcha.group_id);
                
                if (settings && settings.punishment_action) {
                    await applyPunishment(
                        { telegram: bot.telegram },
                        captcha.group_id,
                        captcha.user_id,
                        settings.punishment_action,
                        'Captcha timeout'
                    );
                }
                
                await bot.telegram.deleteMessage(captcha.group_id, captcha.message_id).catch(() => {});
                await db.deleteCaptcha(captcha.user_id, captcha.group_id);
                
                console.log(`⏰ Expired: ${captcha.first_name} (${captcha.user_id}) in ${captcha.group_id}`);
            } catch (error) {
                console.error('Error processing expired captcha:', error);
            }
        }
    } catch (error) {
        console.error('Error in cleanExpiredCaptchas:', error);
    }
}

// ============ CHECK GROUP ADMIN ============
async function checkGroupAdmin(ctx, groupId, userId) {
    try {
        if (userId.toString() === SUPER_ADMIN_ID) {
            return true;
        }
        
        const isAdmin = await db.isGroupAdmin(groupId, userId.toString());
        if (isAdmin) return true;
        
        const chatMember = await ctx.telegram.getChatMember(groupId, parseInt(userId));
        const isTelegramAdmin = ['creator', 'administrator'].includes(chatMember.status);
        
        if (isTelegramAdmin) {
            await db.addGroupAdmin(groupId, userId.toString(), ctx.from.username);
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error checking admin:', error);
        return false;
    }
}

// ============ GROUP ADMIN PANEL ============
async function showGroupAdminPanel(ctx, groupId) {
    const settings = await db.getGroupSettings(groupId);
    if (!settings) {
        return ctx.reply('❌ Group settings not found.');
    }
    
    const admins = await db.getGroupAdmins(groupId);
    
    const adminList = admins.map(a => `👤 @${a.admin_username || a.admin_id}`).join('\n') || 'No additional admins';
    
    const punishmentEmoji = {
        'kick': '👢',
        'ban': '🚫',
        'mute': '🔇',
        'remove': '⚠️'
    };
    
    const message = `
🔧 **Group Admin Panel**
Group: ${ctx.chat.title}

**Current Settings:**
📝 Welcome: ${settings.welcome_text.substring(0, 30)}...
🖼️ Image: ${settings.welcome_image ? '✅' : '❌'}
🔘 Buttons: ${settings.welcome_buttons ? '✅' : '❌'}
🎯 Captcha: ${settings.captcha_type}
⚡ Difficulty: ${settings.captcha_difficulty}
⏰ Timeout: ${settings.captcha_time}s
⚖️ Punishment: ${punishmentEmoji[settings.punishment_action]} ${settings.punishment_action}
🔄 Max Attempts: ${settings.max_attempts}
🗑️ Delete Join: ${settings.delete_join_message ? '✅' : '❌'}

Select an option to configure:
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('📝 Welcome Text', `edit_welcome_${groupId}`),
            Markup.button.callback('🖼️ Welcome Image', `edit_image_${groupId}`)
        ],
        [
            Markup.button.callback('🔘 Welcome Buttons', `edit_buttons_${groupId}`),
            Markup.button.callback('🎯 Captcha Type', `edit_type_${groupId}`)
        ],
        [
            Markup.button.callback('⚡ Difficulty', `edit_diff_${groupId}`),
            Markup.button.callback('⏰ Timeout', `edit_time_${groupId}`)
        ],
        [
            Markup.button.callback('⚖️ Punishment', `edit_punishment_${groupId}`),
            Markup.button.callback('🔄 Max Attempts', `edit_attempts_${groupId}`)
        ],
        [
            Markup.button.callback('🗑️ Join Message', `toggle_join_${groupId}`),
            Markup.button.callback('👥 Admins', `manage_admins_${groupId}`)
        ],
        [
            Markup.button.callback('📊 Stats', `group_stats_${groupId}`),
            Markup.button.callback('❌ Close', `close_panel_${groupId}`)
        ]
    ]);
    
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

// ============ SUPER ADMIN COMMANDS ============
bot.command('add', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== SUPER_ADMIN_ID) {
        return;
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length !== 2) {
        return ctx.reply('❌ Usage: /add -100GROUP_ID');
    }
    
    const groupId = args[1];
    
    try {
        const chat = await bot.telegram.getChat(groupId);
        const botMember = await bot.telegram.getChatMember(groupId, ctx.botInfo.id);
        
        if (!['administrator', 'creator'].includes(botMember.status)) {
            return ctx.reply('❌ Bot must be an admin in the group first.');
        }
        
        const added = await db.addGroup(groupId, chat.title || 'Unknown Group', ctx.from.id.toString());
        
        if (added) {
            await db.addGroupAdmin(groupId, ctx.from.id.toString(), ctx.from.username);
            ctx.reply(`✅ **Group Added Successfully!**\n\n📌 ${chat.title}\n🔗 ID: \`${groupId}\``, {
                parse_mode: 'Markdown'
            });
        } else {
            ctx.reply('❌ Group already exists in database.');
        }
    } catch (error) {
        ctx.reply('❌ Failed to add group. Make sure bot is admin in the group.');
    }
});

bot.command('remove', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== SUPER_ADMIN_ID) {
        return;
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length !== 2) {
        return ctx.reply('❌ Usage: /remove -100GROUP_ID');
    }
    
    const groupId = args[1];
    const removed = await db.removeGroup(groupId);
    
    ctx.reply(removed ? '❌ Group removed successfully.' : '❌ Group not found.');
});

bot.command('stats', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== SUPER_ADMIN_ID) {
        return;
    }
    
    const stats = await db.getStats();
    
    let message = `📊 **Bot Statistics**\n\n`;
    message += `**Total Groups:** ${stats.totalGroups}\n`;
    message += `**Pending Captchas:** ${stats.pendingCaptchas}\n\n`;
    message += `**Groups List:**\n`;
    
    if (stats.groups.length === 0) {
        message += 'No groups added yet.\n';
    } else {
        stats.groups.forEach((group, index) => {
            message += `${index + 1}. ${group.group_title || 'Unknown'} (${group.group_id})\n`;
        });
    }
    
    ctx.reply(message, { parse_mode: 'Markdown' });
});

// ============ GROUP COMMANDS ============
bot.start(async (ctx) => {
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        const groupId = ctx.chat.id.toString();
        const userId = ctx.from.id.toString();
        
        const allowed = await db.isGroupAllowed(groupId);
        if (!allowed) {
            return ctx.reply('❌ This group is not configured. Contact super admin to add it first.');
        }
        
        const isAdmin = await checkGroupAdmin(ctx, groupId, userId);
        if (!isAdmin) {
            return ctx.reply('❌ Only group admins can configure the bot.');
        }
        
        await showGroupAdminPanel(ctx, groupId);
    } else {
        ctx.reply(
            `🤖 **Advanced Welcome Bot**\n\n` +
            `**Super Admin Commands (private only):**\n` +
            `/add -100GROUP_ID - Add a group\n` +
            `/remove -100GROUP_ID - Remove a group\n` +
            `/stats - View bot statistics\n\n` +
            `**Group Admin Commands:**\n` +
            `Send /start in your group to configure settings`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ============ INLINE BUTTON HANDLERS ============

// Edit Welcome Text
bot.action(/edit_welcome_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `📝 **Edit Welcome Text**\n\n` +
        `Send the new welcome message.\n` +
        `Use {user} for member name and {group} for group name.\n\n` +
        `Example: "Welcome {user} to {group}! Please verify:"\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).welcome_text}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForWelcome = groupId;
    await ctx.answerCbQuery();
});

// Edit Welcome Image
bot.action(/edit_image_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🖼️ **Edit Welcome Image**\n\n` +
        `Send a photo or image URL to show with welcome message.\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).welcome_image || 'No image'}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForImage = groupId;
    await ctx.answerCbQuery();
});

// Edit Welcome Buttons
bot.action(/edit_buttons_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Button 1', `add_button1_${groupId}`)],
        [Markup.button.callback('➕ Add Button 2', `add_button2_${groupId}`)],
        [Markup.button.callback('❌ Remove Buttons', `remove_buttons_${groupId}`)],
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText('🔘 **Configure Welcome Buttons**\n\nYou can add up to 2 buttons with custom text and URLs.', {
        parse_mode: 'Markdown',
        ...keyboard
    });
});

// Add Button 1
bot.action(/add_button1_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🔘 **Add Button 1**\n\n` +
        `Send button text and URL in this format:\n` +
        `Button Text | https://example.com\n\n` +
        `Example: "Visit Website | https://google.com"`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForButton1 = groupId;
    await ctx.answerCbQuery();
});

// Add Button 2
bot.action(/add_button2_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🔘 **Add Button 2**\n\n` +
        `Send button text and URL in this format:\n` +
        `Button Text | https://example.com\n\n` +
        `Example: "Join Channel | https://t.me/yourchannel"`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForButton2 = groupId;
    await ctx.answerCbQuery();
});

// Remove Buttons
bot.action(/remove_buttons_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await db.updateGroupSettings(groupId, {
        welcome_buttons: false,
        button1_text: null,
        button1_url: null,
        button2_text: null,
        button2_url: null
    });
    
    await ctx.answerCbQuery('✅ Buttons removed');
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// Captcha Type Selection
bot.action(/edit_type_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🧮 Math', `set_type_${groupId}_math`)],
        [Markup.button.callback('🔢 Emoji Count', `set_type_${groupId}_emoji`)],
        [Markup.button.callback('📝 Text Typing', `set_type_${groupId}_text`)],
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText('🎯 **Select Captcha Type:**', {
        parse_mode: 'Markdown',
        ...keyboard
    });
});

bot.action(/set_type_(.+)_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const captchaType = ctx.match[2];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await db.updateGroupSettings(groupId, { captcha_type: captchaType });
    await ctx.answerCbQuery(`✅ Captcha type set to ${captchaType}`);
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// Difficulty Selection
bot.action(/edit_diff_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🟢 Easy', `set_diff_${groupId}_easy`)],
        [Markup.button.callback('🟡 Medium', `set_diff_${groupId}_medium`)],
        [Markup.button.callback('🔴 Hard', `set_diff_${groupId}_hard`)],
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText('⚡ **Select Difficulty Level:**', {
        parse_mode: 'Markdown',
        ...keyboard
    });
});

bot.action(/set_diff_(.+)_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const difficulty = ctx.match[2];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await db.updateGroupSettings(groupId, { captcha_difficulty: difficulty });
    await ctx.answerCbQuery(`✅ Difficulty set to ${difficulty}`);
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// Timeout Setting
bot.action(/edit_time_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `⏰ **Set Captcha Timeout**\n\n` +
        `Send the timeout in seconds (30-600).\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).captcha_time} seconds_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForTimeout = groupId;
    await ctx.answerCbQuery();
});

// Punishment Selection
bot.action(/edit_punishment_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('👢 Kick', `set_punishment_${groupId}_kick`)],
        [Markup.button.callback('🚫 Ban', `set_punishment_${groupId}_ban`)],
        [Markup.button.callback('🔇 Mute', `set_punishment_${groupId}_mute`)],
        [Markup.button.callback('⚠️ Remove Only', `set_punishment_${groupId}_remove`)],
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText('⚖️ **Select Punishment Action**\n\nChoose what happens when user fails captcha:', {
        parse_mode: 'Markdown',
        ...keyboard
    });
});

bot.action(/set_punishment_(.+)_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    const punishment = ctx.match[2];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await db.updateGroupSettings(groupId, { punishment_action: punishment });
    await ctx.answerCbQuery(`✅ Punishment set to ${punishment}`);
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// Max Attempts Setting
bot.action(/edit_attempts_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🔄 **Set Maximum Attempts**\n\n` +
        `Send the number of allowed attempts (1-5).\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).max_attempts}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForAttempts = groupId;
    await ctx.answerCbQuery();
});

// Toggle Delete Join Message
bot.action(/toggle_join_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const settings = await db.getGroupSettings(groupId);
    const newValue = !settings.delete_join_message;
    
    await db.updateGroupSettings(groupId, { delete_join_message: newValue });
    await ctx.answerCbQuery(`✅ Delete join message: ${newValue ? 'ON' : 'OFF'}`);
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// Manage Admins
bot.action(/manage_admins_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const admins = await db.getGroupAdmins(groupId);
    
    let message = `👥 **Group Admins**\n\n`;
    if (admins.length === 0) {
        message += `No admins found.\n`;
    } else {
        admins.forEach((admin, index) => {
            message += `${index + 1}. @${admin.admin_username || 'Unknown'} (${admin.admin_id})\n`;
        });
    }
    message += `\nTo add an admin, they just need to use /start in this group.`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
});

// Group Stats
bot.action(/group_stats_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const pendingCount = await db.getPendingCountForGroup ? 
        await db.getPendingCountForGroup(groupId) : 0;
    
    const message = `
📊 **Group Statistics**
Group: ${ctx.callbackQuery.message.chat.title}

**Overview:**
👥 Total Admins: ${(await db.getGroupAdmins(groupId)).length}
⏳ Pending Captchas: ${pendingCount}
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
});

// Close Panel
bot.action(/close_panel_(.+)/, async (ctx) => {
    await ctx.deleteMessage();
});

// Back to Panel
bot.action(/back_to_panel_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// ============ TEXT HANDLERS ============
bot.on('text', async (ctx) => {
    const session = getSession(ctx.from.id.toString());
    
    // Handle waiting for welcome text
    if (session.waitingForWelcome) {
        const groupId = session.waitingForWelcome;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForWelcome;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForWelcome;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        await db.updateGroupSettings(groupId, { welcome_text: ctx.message.text });
        delete session.waitingForWelcome;
        
        await ctx.reply('✅ Welcome text updated!');
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
    
    // Handle waiting for image
    if (session.waitingForImage) {
        const groupId = session.waitingForImage;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForImage;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForImage;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const url = ctx.message.text.trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
            await db.updateGroupSettings(groupId, { welcome_image: url });
            delete session.waitingForImage;
            await ctx.reply('✅ Welcome image URL saved!');
        } else {
            return ctx.reply('❌ Please send a valid URL starting with http:// or https://');
        }
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
    
    // Handle waiting for button 1
    if (session.waitingForButton1) {
        const groupId = session.waitingForButton1;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForButton1;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForButton1;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const parts = ctx.message.text.split('|').map(s => s.trim());
        if (parts.length === 2 && parts[1].startsWith('http')) {
            await db.updateGroupSettings(groupId, {
                welcome_buttons: true,
                button1_text: parts[0],
                button1_url: parts[1]
            });
            delete session.waitingForButton1;
            await ctx.reply('✅ Button 1 added!');
        } else {
            return ctx.reply('❌ Invalid format. Use: Button Text | https://example.com');
        }
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
    
    // Handle waiting for button 2
    if (session.waitingForButton2) {
        const groupId = session.waitingForButton2;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForButton2;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForButton2;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const parts = ctx.message.text.split('|').map(s => s.trim());
        if (parts.length === 2 && parts[1].startsWith('http')) {
            await db.updateGroupSettings(groupId, {
                welcome_buttons: true,
                button2_text: parts[0],
                button2_url: parts[1]
            });
            delete session.waitingForButton2;
            await ctx.reply('✅ Button 2 added!');
        } else {
            return ctx.reply('❌ Invalid format. Use: Button Text | https://example.com');
        }
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
    
    // Handle waiting for timeout
    if (session.waitingForTimeout) {
        const groupId = session.waitingForTimeout;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForTimeout;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForTimeout;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const timeout = parseInt(ctx.message.text);
        if (isNaN(timeout) || timeout < 30 || timeout > 600) {
            return ctx.reply('❌ Please send a number between 30 and 600.');
        }
        
        await db.updateGroupSettings(groupId, { captcha_time: timeout });
        delete session.waitingForTimeout;
        
        await ctx.reply(`✅ Timeout set to ${timeout} seconds!`);
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
    
    // Handle waiting for max attempts
    if (session.waitingForAttempts) {
        const groupId = session.waitingForAttempts;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForAttempts;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForAttempts;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const attempts = parseInt(ctx.message.text);
        if (isNaN(attempts) || attempts < 1 || attempts > 5) {
            return ctx.reply('❌ Please send a number between 1 and 5.');
        }
        
        await db.updateGroupSettings(groupId, { max_attempts: attempts });
        delete session.waitingForAttempts;
        
        await ctx.reply(`✅ Max attempts set to ${attempts}!`);
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
});

// ============ NEW MEMBER HANDLER ============
bot.on(message('new_chat_members'), async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    const groupId = ctx.chat.id.toString();
    
    const allowed = await db.isGroupAllowed(groupId);
    if (!allowed) return;
    
    const settings = await db.getGroupSettings(groupId);
    if (!settings) return;
    
    if (settings.delete_join_message) {
        try {
            await ctx.deleteMessage(ctx.message.message_id);
        } catch (error) {
            console.log('Could not delete join message:', error.message);
        }
    }
    
    for (const member of newMembers) {
        if (member.id === ctx.botInfo.id) continue;
        
        const joinKey = `${groupId}:${member.id}:${ctx.message.message_id}`;
        if (processedJoins.has(joinKey)) continue;
        processedJoins.add(joinKey);
        setTimeout(() => processedJoins.delete(joinKey), 60000);
        
        const captcha = generateCaptcha(settings.captcha_type, settings.captcha_difficulty);
        
        let welcomeText = settings.welcome_text;
        welcomeText = welcomeText.replace(/{user}/g, member.first_name);
        welcomeText = welcomeText.replace(/{group}/g, ctx.chat.title);
        
        let replyMarkup = {};
        if (settings.welcome_buttons) {
            const buttons = [];
            if (settings.button1_text && settings.button1_url) {
                buttons.push([Markup.button.url(settings.button1_text, settings.button1_url)]);
            }
            if (settings.button2_text && settings.button2_url) {
                buttons.push([Markup.button.url(settings.button2_text, settings.button2_url)]);
            }
            if (buttons.length > 0) {
                replyMarkup = { inline_keyboard: buttons };
            }
        }
        
        const captchaMessage = `${welcomeText}\n\n${captcha.question}\n\n_⏰ Timeout: ${settings.captcha_time} seconds_`;
        
        try {
            let sentMessage;
            
            if (settings.welcome_image) {
                sentMessage = await ctx.replyWithPhoto(settings.welcome_image, {
                    caption: captchaMessage,
                    parse_mode: 'Markdown',
                    reply_markup: replyMarkup
                });
            } else {
                sentMessage = await ctx.reply(captchaMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: replyMarkup
                });
            }
            
            const expireAt = new Date();
            expireAt.setSeconds(expireAt.getSeconds() + settings.captcha_time);
            
            await db.saveCaptcha(
                member.id.toString(),
                groupId,
                member.first_name,
                member.username,
                captcha.answer,
                sentMessage.message_id,
                expireAt
            );
            
            console.log(`🆕 Captcha sent to ${member.first_name} in ${ctx.chat.title}`);
        } catch (error) {
            console.error('Error sending captcha:', error);
        }
    }
});

// ============ SIMPLIFIED CAPTCHA ANSWER HANDLER - GUARANTEED WORKING ============
bot.on('text', async (ctx) => {
    // Only process in groups
    if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;
    
    try {
        const groupId = ctx.chat.id.toString();
        const userId = ctx.from.id.toString();
        const answer = ctx.message.text.trim();
        
        console.log(`\n🔍 CAPTCHA CHECK:`);
        console.log(`User: ${ctx.from.first_name} (${userId})`);
        console.log(`Answer: "${answer}"`);
        
        // Check if this is a reply to a message
        if (!ctx.message.reply_to_message) {
            console.log('❌ Not a reply message - ignoring');
            return;
        }
        
        console.log(`Reply to message ID: ${ctx.message.reply_to_message.message_id}`);
        
        // Get ALL captchas for this group to debug
        const allCaptchas = await db.pool.query(
            'SELECT * FROM pending_captcha WHERE group_id = $1',
            [groupId]
        );
        console.log(`Total pending captchas in group: ${allCaptchas.rows.length}`);
        
        if (allCaptchas.rows.length > 0) {
            console.log('Pending captchas:');
            allCaptchas.rows.forEach(c => {
                console.log(`  - User: ${c.first_name} (${c.user_id}), MsgID: ${c.message_id}, Answer: "${c.correct_answer}"`);
            });
        }
        
        // Get captcha for this specific user
        const captchaInfo = await db.getCaptchaInfo(userId, groupId);
        
        if (!captchaInfo) {
            console.log(`❌ No captcha found for user ${userId}`);
            
            // Check if they're replying to someone else's captcha
            const repliedToId = ctx.message.reply_to_message.message_id;
            const otherCaptcha = await db.pool.query(
                'SELECT * FROM pending_captcha WHERE group_id = $1 AND message_id = $2',
                [groupId, repliedToId]
            );
            
            if (otherCaptcha.rows.length > 0) {
                const otherUser = otherCaptcha.rows[0];
                await ctx.reply(`❌ This captcha is for ${otherUser.first_name}, not for you!`, {
                    reply_to_message_id: ctx.message.message_id
                });
                console.log(`⚠️ User tried to answer for ${otherUser.first_name}`);
            }
            return;
        }
        
        console.log(`✅ Found captcha for user:`);
        console.log(`  - Expected answer: "${captchaInfo.correct_answer}"`);
        console.log(`  - Message ID: ${captchaInfo.message_id}`);
        console.log(`  - Attempts: ${captchaInfo.attempt_count || 0}`);
        
        // Verify correct message
        if (ctx.message.reply_to_message.message_id !== captchaInfo.message_id) {
            console.log(`❌ Wrong message ID - user replied to ${ctx.message.reply_to_message.message_id}, captcha is at ${captchaInfo.message_id}`);
            await ctx.reply(`❌ Please reply directly to your captcha message.`, {
                reply_to_message_id: ctx.message.message_id
            });
            return;
        }
        
        console.log(`✅ Correct message ID match!`);
        
        // Get settings
        const settings = await db.getGroupSettings(groupId);
        
        // SIMPLE COMPARISON - Convert both to strings and compare
        const userAnswer = answer.toString().trim();
        const correctAnswer = captchaInfo.correct_answer.toString().trim();
        
        console.log(`Comparing: "${userAnswer}" vs "${correctAnswer}"`);
        
        // Try direct string comparison first
        let isCorrect = (userAnswer === correctAnswer);
        
        // If not, try number comparison (for math)
        if (!isCorrect) {
            const userNum = parseInt(userAnswer);
            const correctNum = parseInt(correctAnswer);
            if (!isNaN(userNum) && !isNaN(correctNum) && userNum === correctNum) {
                isCorrect = true;
                console.log('✅ Match via number comparison');
            }
        }
        
        // If still not, try lowercase comparison (for text)
        if (!isCorrect) {
            if (userAnswer.toLowerCase() === correctAnswer.toLowerCase()) {
                isCorrect = true;
                console.log('✅ Match via lowercase comparison');
            }
        }
        
        console.log(`Final result: ${isCorrect ? '✅ CORRECT' : '❌ WRONG'}`);
        
        if (isCorrect) {
            // ✅ CORRECT ANSWER
            console.log(`🎉 ${ctx.from.first_name} answered correctly! Verifying...`);
            
            try {
                // Delete captcha message
                await ctx.deleteMessage(captchaInfo.message_id).catch(e => {
                    console.log('Could not delete message:', e.message);
                });
                
                // Send welcome message
                await ctx.reply(`✅ **Verified!** Welcome to the group, ${ctx.from.first_name}! 🎉`, {
                    parse_mode: 'Markdown',
                    reply_to_message_id: ctx.message.message_id
                });
                
                // Remove from database
                await db.deleteCaptcha(userId, groupId);
                
                console.log(`✅ ${ctx.from.first_name} verified successfully!`);
            } catch (error) {
                console.error('Error in correct answer handling:', error);
            }
        } else {
            // ❌ WRONG ANSWER
            console.log(`❌ ${ctx.from.first_name} gave wrong answer`);
            
            try {
                const currentAttempts = (captchaInfo.attempt_count || 0) + 1;
                const maxAttempts = settings.max_attempts || 3;
                
                console.log(`Attempt ${currentAttempts}/${maxAttempts}`);
                
                // Update attempt count
                await db.pool.query(
                    'UPDATE pending_captcha SET attempt_count = $1 WHERE user_id = $2 AND group_id = $3',
                    [currentAttempts, userId, groupId]
                );
                
                if (currentAttempts >= maxAttempts) {
                    // Too many wrong - punish
                    console.log(`Punishing ${ctx.from.first_name} with ${settings.punishment_action}`);
                    
                    await ctx.deleteMessage(captchaInfo.message_id).catch(e => {});
                    await applyPunishment(ctx, groupId, userId, settings.punishment_action, 'Too many wrong attempts');
                    await db.deleteCaptcha(userId, groupId);
                } else {
                    // Still have attempts left
                    await ctx.reply(`❌ Wrong answer! ${maxAttempts - currentAttempts} attempt(s) left.`, {
                        reply_to_message_id: ctx.message.message_id
                    });
                }
            } catch (error) {
                console.error('Error in wrong answer handling:', error);
            }
        }
    } catch (error) {
        console.error('CRITICAL ERROR in captcha handler:', error);
    }
});

// ============ LEFT MEMBER HANDLER ============
bot.on('left_chat_member', async (ctx) => {
    const groupId = ctx.chat.id.toString();
    const userId = ctx.message.left_chat_member.id.toString();
    await db.deleteCaptcha(userId, groupId).catch(() => {});
});

// ============ ERROR HANDLER ============
bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
});

// Start bot
startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
