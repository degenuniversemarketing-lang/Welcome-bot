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

// ============ SIMPLE BUTTON CAPTCHA (GUARANTEED TO WORK) ============
function generateButtonCaptcha() {
    // Generate a random 4-digit code
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    
    return {
        question: `🔐 **Verification Required**\n\nPlease click the button below to verify you're human.`,
        answer: code,
        buttons: [
            Markup.button.callback('✅ Click to Verify', `verify_${code}`)
        ]
    };
}

// ============ PUNISHMENT HANDLER ============
async function applyPunishment(ctx, groupId, userId, action, reason = 'Failed captcha') {
    try {
        switch(action) {
            case 'ban':
                await ctx.telegram.banChatMember(groupId, parseInt(userId));
                await ctx.reply(`🚫 User banned for: ${reason}`);
                console.log(`🚫 User ${userId} banned for: ${reason}`);
                break;
                
            case 'kick':
                await ctx.telegram.kickChatMember(groupId, parseInt(userId));
                await ctx.telegram.unbanChatMember(groupId, parseInt(userId)); // Unban to allow rejoin
                await ctx.reply(`👢 User kicked for: ${reason}`);
                console.log(`👢 User ${userId} kicked for: ${reason}`);
                break;
                
            case 'mute':
                const untilDate = Math.floor(Date.now() / 1000) + 3600; // 1 hour mute
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
                console.log(`🔇 User ${userId} muted for: ${reason}`);
                break;
                
            case 'remove':
                // Just remove from pending, no actual punishment
                await ctx.reply(`⚠️ User removed from verification for: ${reason}`);
                console.log(`⚠️ User ${userId} removed from verification for: ${reason}`);
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
                
                if (settings && settings.punishment_action && settings.captcha_enabled) {
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
🎯 Captcha: ${settings.captcha_enabled ? '✅ Enabled' : '❌ Disabled'}
⏰ Timeout: ${settings.captcha_time}s
✅ Verify Delete: ${settings.verify_delete_time}s
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
            Markup.button.callback('🎯 Toggle Captcha', `toggle_captcha_${groupId}`)
        ],
        [
            Markup.button.callback('⏰ Timeout', `edit_time_${groupId}`),
            Markup.button.callback('✅ Verify Delete', `edit_verify_delete_${groupId}`)
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

// Toggle Captcha
bot.action(/toggle_captcha_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const settings = await db.getGroupSettings(groupId);
    const newValue = !settings.captcha_enabled;
    
    await db.updateGroupSettings(groupId, { captcha_enabled: newValue });
    await ctx.answerCbQuery(`✅ Captcha ${newValue ? 'enabled' : 'disabled'}`);
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// Edit Verify Delete Time
bot.action(/edit_verify_delete_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `✅ **Set Verification Message Delete Time**\n\n` +
        `Send the time in seconds after which the welcome message will be deleted (5-60).\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).verify_delete_time || 5} seconds_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForVerifyDelete = groupId;
    await ctx.answerCbQuery();
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

// ============ BUTTON CAPTCHA HANDLER ============
bot.action(/verify_(\d+)/, async (ctx) => {
    try {
        const userId = ctx.from.id.toString();
        const groupId = ctx.chat.id.toString();
        const verificationCode = ctx.match[1];
        
        console.log(`🔘 Button clicked by ${ctx.from.first_name} with code: ${verificationCode}`);
        
        // Get captcha info for this user
        const captchaInfo = await db.getCaptchaInfo(userId, groupId);
        
        if (!captchaInfo) {
            await ctx.answerCbQuery('❌ No active captcha found!');
            return;
        }
        
        // Get settings for verify delete time
        const settings = await db.getGroupSettings(groupId);
        const deleteTime = settings.verify_delete_time || 5; // Default 5 seconds
        
        // Check if the code matches
        if (captchaInfo.correct_answer === verificationCode) {
            // ✅ Correct verification
            await ctx.answerCbQuery('✅ Verified! Welcome to the group!');
            
            // Delete the captcha message
            await ctx.deleteMessage(captchaInfo.message_id).catch(e => {});
            
            // Send welcome message that will auto-delete
            const welcomeMsg = await ctx.reply(`✅ **Verified!** Welcome to the group, ${ctx.from.first_name}! 🎉`);
            
            // Remove from database
            await db.deleteCaptcha(userId, groupId);
            
            console.log(`✅ ${ctx.from.first_name} verified via button!`);
            
            // Auto-delete the welcome message after set time
            setTimeout(async () => {
                try {
                    await ctx.deleteMessage(welcomeMsg.message_id);
                    console.log(`🗑️ Auto-deleted welcome message for ${ctx.from.firstName}`);
                } catch (e) {
                    console.log('Could not auto-delete message:', e.message);
                }
            }, deleteTime * 1000);
            
        } else {
            await ctx.answerCbQuery('❌ Invalid verification!');
        }
    } catch (error) {
        console.error('Error in button handler:', error);
        await ctx.answerCbQuery('❌ Error occurred');
    }
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
    
    // Handle waiting for verify delete time
    if (session.waitingForVerifyDelete) {
        const groupId = session.waitingForVerifyDelete;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForVerifyDelete;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForVerifyDelete;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const deleteTime = parseInt(ctx.message.text);
        if (isNaN(deleteTime) || deleteTime < 5 || deleteTime > 60) {
            return ctx.reply('❌ Please send a number between 5 and 60.');
        }
        
        await db.updateGroupSettings(groupId, { verify_delete_time: deleteTime });
        delete session.waitingForVerifyDelete;
        
        await ctx.reply(`✅ Verification message will now delete after ${deleteTime} seconds!`);
        
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
    
    // Check if captcha is enabled
    if (!settings.captcha_enabled) {
        console.log(`Captcha disabled for group ${groupId}, skipping verification`);
        return;
    }
    
    for (const member of newMembers) {
        if (member.id === ctx.botInfo.id) continue;
        
        const joinKey = `${groupId}:${member.id}:${ctx.message.message_id}`;
        if (processedJoins.has(joinKey)) continue;
        processedJoins.add(joinKey);
        setTimeout(() => processedJoins.delete(joinKey), 60000);
        
        // Generate button captcha
        const captcha = generateButtonCaptcha();
        
        let welcomeText = settings.welcome_text;
        welcomeText = welcomeText.replace(/{user}/g, member.first_name);
        welcomeText = welcomeText.replace(/{group}/g, ctx.chat.title);
        
        // Create inline keyboard with verify button
        const keyboard = Markup.inlineKeyboard([captcha.buttons]);
        
        const captchaMessage = `${welcomeText}\n\n${captcha.question}\n\n_⏰ Timeout: ${settings.captcha_time} seconds_`;
        
        try {
            let sentMessage;
            
            if (settings.welcome_image) {
                sentMessage = await ctx.replyWithPhoto(settings.welcome_image, {
                    caption: captchaMessage,
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                });
            } else {
                sentMessage = await ctx.reply(captchaMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
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
            
            console.log(`🆕 Button captcha sent to ${member.first_name} in ${ctx.chat.title} with code: ${captcha.answer}`);
        } catch (error) {
            console.error('Error sending captcha:', error);
        }
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
