const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const express = require('express');
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

// ============ BUTTON CAPTCHA GENERATOR ============
function generateButtonCaptcha() {
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
async function applyPunishment(telegram, groupId, userId, action, reason = 'Failed captcha', chatId = null) {
    try {
        switch(action) {
            case 'ban':
                await telegram.banChatMember(groupId, parseInt(userId));
                if (chatId) {
                    await telegram.sendMessage(chatId, `🚫 User banned for: ${reason}`);
                }
                console.log(`🚫 User ${userId} banned for: ${reason}`);
                break;
                
            case 'kick':
                await telegram.kickChatMember(groupId, parseInt(userId));
                await telegram.unbanChatMember(groupId, parseInt(userId));
                if (chatId) {
                    await telegram.sendMessage(chatId, `👢 User kicked for: ${reason}`);
                }
                console.log(`👢 User ${userId} kicked for: ${reason}`);
                break;
                
            case 'mute':
                const untilDate = Math.floor(Date.now() / 1000) + 3600;
                await telegram.restrictChatMember(groupId, parseInt(userId), {
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
                if (chatId) {
                    await telegram.sendMessage(chatId, `🔇 User muted for 1 hour for: ${reason}`);
                }
                console.log(`🔇 User ${userId} muted for: ${reason}`);
                break;
                
            case 'remove':
                if (chatId) {
                    await telegram.sendMessage(chatId, `⚠️ User removed from verification for: ${reason}`);
                }
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
                    // Delete captcha message first
                    await bot.telegram.deleteMessage(captcha.group_id, captcha.message_id).catch(() => {});
                    
                    // Apply punishment
                    await applyPunishment(
                        bot.telegram,
                        captcha.group_id,
                        captcha.user_id,
                        settings.punishment_action,
                        'Captcha timeout',
                        captcha.group_id
                    );
                }
                
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
📝 Welcome Text: ${settings.welcome_text ? settings.welcome_text.substring(0, 30) + '...' : 'Default'}
🖼️ Captcha Image: ${settings.captcha_image ? '✅' : '❌'}
🖼️ Welcome Image: ${settings.welcome_image ? '✅' : '❌'}
🔘 Buttons: ${settings.welcome_buttons ? '✅' : '❌'}
🎯 Captcha: ${settings.captcha_enabled ? '✅ Enabled' : '❌ Disabled'}
⏰ Captcha Timeout: ${settings.captcha_time}s
⏰ Welcome Delete: ${settings.welcome_delete_time || 10}s
⚖️ Punishment: ${punishmentEmoji[settings.punishment_action]} ${settings.punishment_action}
🗑️ Delete Join: ${settings.delete_join_message ? '✅' : '❌'}

Select an option to configure:
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('📝 Welcome Text', `edit_welcome_${groupId}`),
            Markup.button.callback('🖼️ Captcha Image', `edit_captcha_image_${groupId}`)
        ],
        [
            Markup.button.callback('🖼️ Welcome Image', `edit_welcome_image_${groupId}`),
            Markup.button.callback('🔘 Welcome Buttons', `edit_buttons_${groupId}`)
        ],
        [
            Markup.button.callback('🎯 Toggle Captcha', `toggle_captcha_${groupId}`),
            Markup.button.callback('⏰ Captcha Timeout', `edit_captcha_time_${groupId}`)
        ],
        [
            Markup.button.callback('⏰ Welcome Delete', `edit_welcome_delete_${groupId}`),
            Markup.button.callback('⚖️ Punishment', `edit_punishment_${groupId}`)
        ],
        [
            Markup.button.callback('🗑️ Delete Join', `toggle_join_${groupId}`),
            Markup.button.callback('👥 Manage Admins', `manage_admins_${groupId}`)
        ],
        [
            Markup.button.callback('📊 Group Stats', `group_stats_${groupId}`),
            Markup.button.callback('❌ Close Panel', `close_panel_${groupId}`)
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
            ctx.reply(`✅ **Group Added Successfully!**\n\n📌 ${chat.title}\n🔗 ID: \`${groupId}\`\n\nGroup admins can now configure the bot by sending /start in their group.`, {
                parse_mode: 'Markdown'
            });
        } else {
            ctx.reply('❌ Group already exists in database.');
        }
    } catch (error) {
        ctx.reply('❌ Failed to add group. Make sure:\n1. Group ID is correct\n2. Bot is admin in the group');
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
    message += **Pending Captchas:** ${stats.pendingCaptchas}\n\n`;
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
            return ctx.reply('❌ This group is not configured. Contact super admin to add it first.\n\nSuper admin needs to use: /add ' + groupId);
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
            `1. Add bot to your group as admin\n` +
            `2. Ask super admin to add your group using /add\n` +
            `3. Send /start in your group to configure settings`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ============ INLINE BUTTON HANDLERS ============

// 📝 Edit Welcome Text
bot.action(/edit_welcome_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `📝 **Edit Welcome Text**\n\n` +
        `Send the new welcome message that appears AFTER verification.\n` +
        `Use {user} for member name and {group} for group name.\n\n` +
        `Example: "Welcome {user} to {group}! We're glad to have you!"\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).welcome_text || 'Default'}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForWelcome = groupId;
    await ctx.answerCbQuery();
});

// 🖼️ Edit Captcha Image
bot.action(/edit_captcha_image_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🖼️ **Set Captcha Image**\n\n` +
        `Send an image URL to show with the CAPTCHA message.\n` +
        `This image will appear above the verification button.\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).captcha_image || 'No image'}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForCaptchaImage = groupId;
    await ctx.answerCbQuery();
});

// 🖼️ Edit Welcome Image
bot.action(/edit_welcome_image_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🖼️ **Set Welcome Image**\n\n` +
        `Send an image URL to show with the welcome message AFTER verification.\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).welcome_image || 'No image'}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForWelcomeImage = groupId;
    await ctx.answerCbQuery();
});

// 🔘 Edit Welcome Buttons
bot.action(/edit_buttons_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const settings = await db.getGroupSettings(groupId);
    
    const buttonsKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Button 1', `add_button1_${groupId}`)],
        [Markup.button.callback('➕ Add Button 2', `add_button2_${groupId}`)],
        [Markup.button.callback('❌ Remove All Buttons', `remove_buttons_${groupId}`)],
        [Markup.button.callback('◀️ Back to Main Panel', `back_to_panel_${groupId}`)]
    ]);
    
    let buttonStatus = '';
    if (settings.welcome_buttons) {
        buttonStatus = '✅ Buttons are enabled\n\n';
        if (settings.button1_text) buttonStatus += `Button 1: ${settings.button1_text}\n`;
        if (settings.button2_text) buttonStatus += `Button 2: ${settings.button2_text}\n`;
    } else {
        buttonStatus = '❌ Buttons are disabled\n';
    }
    
    await ctx.editMessageText(
        `🔘 **Welcome Buttons Configuration**\n\n` +
        `${buttonStatus}\n` +
        `You can add up to 2 buttons with custom text and URLs.\n\n` +
        `Format: Button Text | https://example.com`,
        { parse_mode: 'Markdown', ...buttonsKeyboard }
    );
});

// 🎯 Toggle Captcha
bot.action(/toggle_captcha_([0-9-]+)/, async (ctx) => {
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

// ⏰ Edit Captcha Timeout
bot.action(/edit_captcha_time_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `⏰ **Set Captcha Timeout**\n\n` +
        `Send the time in seconds before CAPTCHA expires (30-600).\n` +
        `After this time, user will be punished and CAPTCHA message deleted.\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).captcha_time} seconds_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForCaptchaTime = groupId;
    await ctx.answerCbQuery();
});

// ⏰ Edit Welcome Delete Time
bot.action(/edit_welcome_delete_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `⏰ **Set Welcome Message Delete Time**\n\n` +
        `Send the time in seconds after which the welcome message will be deleted (5-60).\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).welcome_delete_time || 10} seconds_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForWelcomeDelete = groupId;
    await ctx.answerCbQuery();
});

// ⚖️ Edit Punishment
bot.action(/edit_punishment_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const punishmentKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('👢 Kick User', `set_punishment_${groupId}_kick`)],
        [Markup.button.callback('🚫 Ban User', `set_punishment_${groupId}_ban`)],
        [Markup.button.callback('🔇 Mute User (1h)', `set_punishment_${groupId}_mute`)],
        [Markup.button.callback('⚠️ Remove Only', `set_punishment_${groupId}_remove`)],
        [Markup.button.callback('◀️ Back to Main Panel', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText(
        `⚖️ **Select Punishment Action**\n\n` +
        `Choose what happens when a user fails the captcha or times out:`,
        { parse_mode: 'Markdown', ...punishmentKeyboard }
    );
});

// Set Punishment Action
bot.action(/set_punishment_([0-9-]+)_(kick|ban|mute|remove)/, async (ctx) => {
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

// 🗑️ Toggle Delete Join Message
bot.action(/toggle_join_([0-9-]+)/, async (ctx) => {
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

// 👥 Manage Admins
bot.action(/manage_admins_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const admins = await db.getGroupAdmins(groupId);
    
    let adminMessage = `👥 **Group Admins**\n\n`;
    if (admins.length === 0) {
        adminMessage += `No admins found.\n`;
    } else {
        admins.forEach((admin, index) => {
            adminMessage += `${index + 1}. @${admin.admin_username || 'Unknown'} (${admin.admin_id})\n`;
        });
    }
    adminMessage += `\nTo add an admin, they just need to use /start in this group.`;
    
    const adminKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back to Main Panel', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText(adminMessage, { parse_mode: 'Markdown', ...adminKeyboard });
});

// ➕ Add Button 1
bot.action(/add_button1_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🔘 **Add Button 1**\n\n` +
        `Send button text and URL in this format:\n` +
        `Button Text | https://example.com\n\n` +
        `Example: "Visit Website | https://google.com"\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForButton1 = groupId;
    await ctx.answerCbQuery();
});

// ➕ Add Button 2
bot.action(/add_button2_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `🔘 **Add Button 2**\n\n` +
        `Send button text and URL in this format:\n` +
        `Button Text | https://example.com\n\n` +
        `Example: "Join Channel | https://t.me/yourchannel"\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    const session = getSession(ctx.from.id.toString());
    session.waitingForButton2 = groupId;
    await ctx.answerCbQuery();
});

// ❌ Remove All Buttons
bot.action(/remove_buttons_([0-9-]+)/, async (ctx) => {
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
    
    await ctx.answerCbQuery('✅ All buttons removed');
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

// 📊 Group Stats
bot.action(/group_stats_([0-9-]+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const pendingCount = await db.getPendingCountForGroup ? 
        await db.getPendingCountForGroup(groupId) : 0;
    const admins = await db.getGroupAdmins(groupId);
    const settings = await db.getGroupSettings(groupId);
    
    const statsKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back to Main Panel', `back_to_panel_${groupId}`)]
    ]);
    
    const statsMessage = `
📊 **Group Statistics**
Group: ${ctx.callbackQuery.message.chat.title}

**Overview:**
👥 Total Admins: ${admins.length}
⏳ Pending Captchas: ${pendingCount}
✅ Captcha Enabled: ${settings.captcha_enabled ? 'Yes' : 'No'}
🖼️ Captcha Image: ${settings.captcha_image ? '✅ Set' : '❌ Not Set'}
🖼️ Welcome Image: ${settings.welcome_image ? '✅ Set' : '❌ Not Set'}
    `;
    
    await ctx.editMessageText(statsMessage, { parse_mode: 'Markdown', ...statsKeyboard });
});

// ❌ Close Panel
bot.action(/close_panel_([0-9-]+)/, async (ctx) => {
    await ctx.deleteMessage();
});

// ◀️ Back to Main Panel
bot.action(/back_to_panel_([09-]+)/, async (ctx) => {
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
        
        const captchaInfo = await db.getCaptchaInfo(userId, groupId);
        
        if (!captchaInfo) {
            await ctx.answerCbQuery('❌ No active captcha found!');
            return;
        }
        
        const settings = await db.getGroupSettings(groupId);
        const welcomeDeleteTime = settings.welcome_delete_time || 10;
        
        if (captchaInfo.correct_answer === verificationCode) {
            // ✅ Correct verification
            await ctx.answerCbQuery('✅ Verified! Welcome to the group!');
            
            // Delete the captcha message
            await ctx.deleteMessage(captchaInfo.message_id).catch(e => {});
            
            // Prepare welcome message
            let welcomeText = settings.welcome_text || "Welcome {user} to {group}!";
            welcomeText = welcomeText.replace(/{user}/g, ctx.from.first_name);
            welcomeText = welcomeText.replace(/{group}/g, ctx.chat.title);
            
            // Prepare welcome buttons if enabled
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
            
            // Send welcome message with optional image
            let welcomeMsg;
            if (settings.welcome_image) {
                welcomeMsg = await ctx.replyWithPhoto(settings.welcome_image, {
                    caption: welcomeText,
                    parse_mode: 'Markdown',
                    reply_markup: replyMarkup
                });
                console.log(`✅ Welcome with image sent to ${ctx.from.first_name}`);
            } else {
                welcomeMsg = await ctx.reply(welcomeText, {
                    parse_mode: 'Markdown',
                    reply_markup: replyMarkup
                });
            }
            
            // Remove from database
            await db.deleteCaptcha(userId, groupId);
            
            console.log(`✅ ${ctx.from.first_name} verified via button!`);
            
            // Auto-delete the welcome message after set time
            setTimeout(async () => {
                try {
                    await ctx.deleteMessage(welcomeMsg.message_id);
                    console.log(`🗑️ Auto-deleted welcome message for ${ctx.from.first_name}`);
                } catch (e) {
                    console.log('Could not auto-delete message:', e.message);
                }
            }, welcomeDeleteTime * 1000);
            
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
    
    // Handle waiting for captcha image
    if (session.waitingForCaptchaImage) {
        const groupId = session.waitingForCaptchaImage;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForCaptchaImage;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForCaptchaImage;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const url = ctx.message.text.trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
            // FIXED: Save to captcha_image, NOT welcome_text
            await db.updateGroupSettings(groupId, { captcha_image: url });
            delete session.waitingForCaptchaImage;
            await ctx.reply('✅ Captcha image URL saved!');
            
            // Show updated panel immediately
            ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
            await showGroupAdminPanel(ctx, groupId);
        } else {
            return ctx.reply('❌ Please send a valid URL starting with http:// or https://');
        }
        return;
    }
    
    // Handle waiting for welcome image
    if (session.waitingForWelcomeImage) {
        const groupId = session.waitingForWelcomeImage;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForWelcomeImage;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForWelcomeImage;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const url = ctx.message.text.trim();
        if (url.startsWith('http://') || url.startsWith('https://')) {
            await db.updateGroupSettings(groupId, { welcome_image: url });
            delete session.waitingForWelcomeImage;
            await ctx.reply('✅ Welcome image URL saved!');
            
            // Show updated panel immediately
            ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
            await showGroupAdminPanel(ctx, groupId);
        } else {
            return ctx.reply('❌ Please send a valid URL starting with http:// or https://');
        }
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
            
            ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
            await showGroupAdminPanel(ctx, groupId);
        } else {
            return ctx.reply('❌ Invalid format. Use: Button Text | https://example.com');
        }
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
            
            ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
            await showGroupAdminPanel(ctx, groupId);
        } else {
            return ctx.reply('❌ Invalid format. Use: Button Text | https://example.com');
        }
        return;
    }
    
    // Handle waiting for captcha time
    if (session.waitingForCaptchaTime) {
        const groupId = session.waitingForCaptchaTime;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForCaptchaTime;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForCaptchaTime;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const timeout = parseInt(ctx.message.text);
        if (isNaN(timeout) || timeout < 30 || timeout > 600) {
            return ctx.reply('❌ Please send a number between 30 and 600.');
        }
        
        await db.updateGroupSettings(groupId, { captcha_time: timeout });
        delete session.waitingForCaptchaTime;
        
        await ctx.reply(`✅ Captcha timeout set to ${timeout} seconds!`);
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
    
    // Handle waiting for welcome delete time
    if (session.waitingForWelcomeDelete) {
        const groupId = session.waitingForWelcomeDelete;
        
        if (ctx.message.text === '/cancel') {
            delete session.waitingForWelcomeDelete;
            return ctx.reply('❌ Cancelled.');
        }
        
        if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
            delete session.waitingForWelcomeDelete;
            return ctx.reply('❌ You are not an admin of this group');
        }
        
        const deleteTime = parseInt(ctx.message.text);
        if (isNaN(deleteTime) || deleteTime < 5 || deleteTime > 60) {
            return ctx.reply('❌ Please send a number between 5 and 60.');
        }
        
        await db.updateGroupSettings(groupId, { welcome_delete_time: deleteTime });
        delete session.waitingForWelcomeDelete;
        
        await ctx.reply(`✅ Welcome message will now delete after ${deleteTime} seconds!`);
        
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
});

// ============ PRIMARY JOIN HANDLER - WORKS FOR ALL GROUP SIZES ============
// This is the main handler that works for ALL groups, including 100,000+ members
bot.on('chat_member', async (ctx) => {
    try {
        const oldStatus = ctx.chatMember.old_chat_member?.status;
        const newStatus = ctx.chatMember.new_chat_member.status;
        const user = ctx.chatMember.new_chat_member.user;
        const groupId = ctx.chat.id.toString();
        const userId = user.id.toString();
        
        // Skip bots
        if (user.is_bot) return;
        
        // Check if this is a new join - works for ALL join methods:
        // - Public invite links
        // - Private invite links
        // - Added by admin
        // - Approved join requests
        // - Unrestricted after being muted
        const isNewJoin = (oldStatus === 'left' || oldStatus === 'kicked' || !oldStatus) && 
                          (newStatus === 'member' || newStatus === 'administrator');
        
        if (!isNewJoin) return;
        
        console.log(`👤 User joined (chat_member): ${user.first_name} (${userId}) in ${ctx.chat.title}`);
        
        // Check if group is allowed
        const allowed = await db.isGroupAllowed(groupId);
        if (!allowed) {
            console.log(`Group ${groupId} not allowed, skipping`);
            return;
        }
        
        const settings = await db.getGroupSettings(groupId);
        if (!settings) {
            console.log(`No settings for group ${groupId}, skipping`);
            return;
        }
        
        // Check if captcha is enabled
        if (!settings.captcha_enabled) {
            console.log(`Captcha disabled for group ${groupId}, skipping verification`);
            return;
        }
        
        // Prevent duplicate processing
        const joinKey = `${groupId}:${userId}:chat_member`;
        if (processedJoins.has(joinKey)) {
            console.log(`Duplicate join detected for ${user.first_name}, skipping`);
            return;
        }
        processedJoins.add(joinKey);
        setTimeout(() => processedJoins.delete(joinKey), 30000);
        
        // Send captcha
        await sendCaptcha(ctx, user, groupId, settings);
        
    } catch (error) {
        console.error('Error in chat_member handler:', error);
    }
});

// Backup handler for small groups (under 10k members)
bot.on(message('new_chat_members'), async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    const groupId = ctx.chat.id.toString();
    
    console.log(`📢 new_chat_members event in ${ctx.chat.title}`);
    
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
    
    if (!settings.captcha_enabled) return;
    
    for (const member of newMembers) {
        if (member.id === ctx.botInfo.id || member.is_bot) continue;
        
        const joinKey = `${groupId}:${member.id}:${ctx.message.message_id}`;
        if (processedJoins.has(joinKey)) continue;
        processedJoins.add(joinKey);
        setTimeout(() => processedJoins.delete(joinKey), 60000);
        
        await sendCaptcha(ctx, member, groupId, settings);
    }
});

// ============ SHARED CAPTCHA SENDING FUNCTION ============
async function sendCaptcha(ctx, user, groupId, settings) {
    try {
        // Check if user already has pending captcha
        const existing = await db.getCaptchaInfo(user.id.toString(), groupId);
        if (existing) {
            console.log(`User ${user.first_name} already has pending captcha, skipping`);
            return;
        }
        
        // Generate button captcha
        const captcha = generateButtonCaptcha();
        
        // Prepare captcha message text
        const captchaText = `Please verify you're human, ${user.first_name}.\n\n${captcha.question}\n\n_⏰ Timeout: ${settings.captcha_time} seconds_`;
        
        // Create inline keyboard with verify button
        const keyboard = Markup.inlineKeyboard([captcha.buttons]);
        
        let sentMessage;
        
        // Send captcha with optional image
        if (settings.captcha_image) {
            sentMessage = await ctx.replyWithPhoto(settings.captcha_image, {
                caption: captchaText,
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
            console.log(`🆕 CAPTCHA WITH IMAGE sent to ${user.first_name}`);
        } else {
            sentMessage = await ctx.reply(captchaText, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
            console.log(`🆕 Captcha without image sent to ${user.first_name}`);
        }
        
        const expireAt = new Date();
        expireAt.setSeconds(expireAt.getSeconds() + settings.captcha_time);
        
        await db.saveCaptcha(
            user.id.toString(),
            groupId,
            user.first_name,
            user.username,
            captcha.answer,
            sentMessage.message_id,
            expireAt
        );
        
        console.log(`🆕 Captcha sent to ${user.first_name} with code: ${captcha.answer}`);
    } catch (error) {
        console.error('Error sending captcha:', error);
    }
}

// ============ LEFT MEMBER HANDLER ============
bot.on('left_chat_member', async (ctx) => {
    const groupId = ctx.chat.id.toString();
    const userId = ctx.message.left_chat_member.id.toString();
    await db.deleteCaptcha(userId, groupId).catch(() => {});
});

// Leave via chat_member
bot.on('chat_member', async (ctx) => {
    try {
        const newStatus = ctx.chatMember.new_chat_member.status;
        const user = ctx.chatMember.new_chat_member.user;
        const groupId = ctx.chat.id.toString();
        const userId = user.id.toString();
        
        if (user.is_bot) return;
        
        const isLeft = (newStatus === 'left' || newStatus === 'kicked');
        
        if (isLeft) {
            console.log(`👋 User left: ${user.first_name} from ${ctx.chat.title}`);
            await db.deleteCaptcha(userId, groupId).catch(() => {});
        }
    } catch (error) {
        console.error('Error in chat_member leave handler:', error);
    }
});

// ============ ERROR HANDLER ============
bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
});

// Start bot
startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
