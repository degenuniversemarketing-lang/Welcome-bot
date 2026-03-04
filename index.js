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
                // Mute for 1 hour (or configured time)
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
                // Just remove from pending, no punishment
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
                
                // Apply configured punishment
                if (settings && settings.punishment_action) {
                    await applyPunishment(
                        { telegram: bot.telegram },
                        captcha.group_id,
                        captcha.user_id,
                        settings.punishment_action,
                        'Captcha timeout'
                    );
                }
                
                // Delete the captcha message
                await bot.telegram.deleteMessage(captcha.group_id, captcha.message_id).catch(() => {});
                
                // Remove from database
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
        // Check if user is super admin
        if (userId.toString() === SUPER_ADMIN_ID) {
            return true;
        }
        
        // Check if user is group admin in database
        const isAdmin = await db.isGroupAdmin(groupId, userId.toString());
        if (isAdmin) return true;
        
        // Check if user is actual Telegram group admin
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

// ============ NEW MEMBER HANDLER ============
bot.on(message('new_chat_members'), async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    const groupId = ctx.chat.id.toString();
    
    const allowed = await db.isGroupAllowed(groupId);
    if (!allowed) return;
    
    const settings = await db.getGroupSettings(groupId);
    if (!settings) return;
    
    // Delete Telegram's join message if enabled
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
        
        // Format welcome message
        let welcomeText = settings.welcome_text;
        welcomeText = welcomeText.replace(/{user}/g, member.first_name);
        welcomeText = welcomeText.replace(/{group}/g, ctx.chat.title);
        
        // Prepare message with optional image
        let captchaMessage = `${welcomeText}\n\n${captcha.question}\n\n_⏰ Timeout: ${settings.captcha_time} seconds_`;
        
        try {
            let sentMessage;
            
            // Send with image if configured
            if (settings.welcome_image) {
                sentMessage = await ctx.replyWithPhoto(settings.welcome_image, {
                    caption: captchaMessage,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        force_reply: true
                    }
                });
            } else {
                sentMessage = await ctx.reply(captchaMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        force_reply: true
                    }
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

// ============ CAPTCHA ANSWER HANDLER ============
bot.on('text', async (ctx) => {
    if (ctx.chat.type === 'private') return;
    
    const groupId = ctx.chat.id.toString();
    const userId = ctx.from.id.toString();
    const answer = ctx.message.text.trim();
    
    if (!ctx.message.reply_to_message) return;
    
    const captchaInfo = await db.getCaptchaInfo(userId, groupId);
    
    if (!captchaInfo) return;
    
    if (ctx.message.reply_to_message.message_id !== captchaInfo.message_id) return;
    
    const settings = await db.getGroupSettings(groupId);
    const result = await db.verifyCaptcha(userId, groupId, answer);
    
    if (result.success) {
        try {
            await ctx.deleteMessage(captchaInfo.message_id);
            await ctx.reply(`✅ **Verified!** Welcome to the group, ${ctx.from.first_name}!`, {
                parse_mode: 'Markdown',
                reply_to_message_id: ctx.message.message_id
            });
            console.log(`✅ ${ctx.from.first_name} verified in ${ctx.chat.title}`);
        } catch (error) {
            console.error('Error handling correct answer:', error);
        }
    } else if (result.reason === 'wrong_answer') {
        const attemptsLeft = settings.max_attempts - (result.attempts || 0);
        
        if (attemptsLeft > 0) {
            await ctx.reply(`❌ Wrong answer! ${attemptsLeft} attempts remaining.`, {
                reply_to_message_id: ctx.message.message_id
            });
        } else {
            try {
                await ctx.deleteMessage(captchaInfo.message_id);
                await applyPunishment(ctx, groupId, userId, settings.punishment_action, 'Too many wrong attempts');
                await db.deleteCaptcha(userId, groupId);
            } catch (error) {
                console.error('Error applying punishment:', error);
            }
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
