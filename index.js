const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
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
    
    // Use long polling
    await bot.launch();
    console.log('✅ Bot started with long polling');
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

// ============ CLEAN EXPIRED CAPTCHAS ============
async function cleanExpiredCaptchas() {
    try {
        const expired = await db.getExpiredCaptchas();
        
        for (const captcha of expired) {
            try {
                const settings = await db.getGroupSettings(captcha.group_id);
                
                if (settings && settings.kick_on_timeout) {
                    // Kick the user
                    await bot.telegram.kickChatMember(captcha.group_id, parseInt(captcha.user_id));
                    await bot.telegram.unbanChatMember(captcha.group_id, parseInt(captcha.user_id));
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
            // Add to database for future
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
        return ctx.reply('❌ Group settings not found. Please contact super admin.');
    }
    
    const admins = await db.getGroupAdmins(groupId);
    
    const adminList = admins.map(a => `👤 @${a.admin_username || a.admin_id}`).join('\n') || 'No additional admins';
    
    const message = `
🔧 **Group Admin Panel**
Group: ${ctx.chat.title}

**Current Settings:**
📝 Welcome: ${settings.welcome_text.substring(0, 50)}${settings.welcome_text.length > 50 ? '...' : ''}
🎯 Captcha Type: ${settings.captcha_type}
⚡ Difficulty: ${settings.captcha_difficulty}
⏰ Timeout: ${settings.captcha_time} seconds
🗑️ Delete Join Msg: ${settings.delete_join_message ? '✅' : '❌'}
👢 Kick on Timeout: ${settings.kick_on_timeout ? '✅' : '❌'}

**Group Admins:**
${adminList}

Select an option to configure:
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('📝 Welcome Text', `edit_welcome_${groupId}`),
            Markup.button.callback('🎯 Captcha Type', `edit_type_${groupId}`)
        ],
        [
            Markup.button.callback('⚡ Difficulty', `edit_diff_${groupId}`),
            Markup.button.callback('⏰ Timeout', `edit_time_${groupId}`)
        ],
        [
            Markup.button.callback('🗑️ Join Message', `toggle_join_${groupId}`),
            Markup.button.callback('👢 Kick Timeout', `toggle_kick_${groupId}`)
        ],
        [
            Markup.button.callback('👥 Manage Admins', `manage_admins_${groupId}`),
            Markup.button.callback('📊 Stats', `group_stats_${groupId}`)
        ],
        [
            Markup.button.callback('❌ Close', `close_panel_${groupId}`)
        ]
    ]);
    
    await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

// ============ MIDDLEWARE ============
// Check if group is allowed
bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'private') {
        return next();
    }
    
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
        const allowed = await db.isGroupAllowed(ctx.chat.id.toString());
        if (!allowed) {
            // Ignore messages from non-allowed groups
            return;
        }
    }
    
    return next();
});

// ============ SUPER ADMIN COMMANDS ============
bot.command('add', async (ctx) => {
    // Check if private chat and super admin
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== SUPER_ADMIN_ID) {
        return ctx.reply('❌ This command is only for super admin in private chat.');
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length !== 2) {
        return ctx.reply('❌ Usage: /add -100GROUP_ID');
    }
    
    const groupId = args[1];
    
    // Validate group ID format
    if (!groupId.startsWith('-100')) {
        return ctx.reply('❌ Invalid group ID. Must start with -100');
    }
    
    try {
        // Try to get chat info to verify group exists and bot is admin
        const chat = await bot.telegram.getChat(groupId);
        
        // Check if bot is admin in the group
        const botMember = await bot.telegram.getChatMember(groupId, ctx.botInfo.id);
        if (!['administrator', 'creator'].includes(botMember.status)) {
            return ctx.reply('❌ Bot must be an admin in the group first. Add bot as admin and try again.');
        }
        
        // Add to database
        const added = await db.addGroup(groupId, chat.title || 'Unknown Group', ctx.from.id.toString());
        
        if (added) {
            // Add super admin as group admin
            await db.addGroupAdmin(groupId, ctx.from.id.toString(), ctx.from.username);
            
            ctx.reply(`✅ **Group Added Successfully!**\n\n📌 ${chat.title}\n🔗 ID: \`${groupId}\`\n\nGroup admins can now configure the bot by sending /start in the group.`, {
                parse_mode: 'Markdown'
            });
        } else {
            ctx.reply('❌ Group already exists in database.');
        }
    } catch (error) {
        console.error('Error adding group:', error);
        ctx.reply('❌ Failed to add group. Make sure:\n1. Group ID is correct\n2. Bot is admin in the group\n3. Group exists');
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

bot.command('globalstats', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== SUPER_ADMIN_ID) {
        return;
    }
    
    const stats = await db.getStats();
    
    if (!stats) {
        return ctx.reply('❌ Error fetching stats.');
    }
    
    let message = `🌍 **Global Statistics**\n\n`;
    message += `**Total Groups:** ${stats.totalGroups}\n`;
    message += `**Pending Captchas:** ${stats.pendingCaptchas}\n\n`;
    message += `**Groups List:**\n`;
    
    if (stats.groups.length === 0) {
        message += 'No groups added yet.\n';
    } else {
        stats.groups.forEach((group, index) => {
            message += `${index + 1}. ${group.group_title || 'Unknown'} (${group.group_id}) - ${group.is_active ? '✅' : '❌'}\n`;
        });
    }
    
    ctx.reply(message, { parse_mode: 'Markdown' });
});

// ============ GROUP COMMANDS ============
bot.start(async (ctx) => {
    // Handle /start in groups
    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        const groupId = ctx.chat.id.toString();
        const userId = ctx.from.id.toString();
        
        // Check if group is allowed
        const allowed = await db.isGroupAllowed(groupId);
        if (!allowed) {
            return ctx.reply('❌ This group is not configured. Contact super admin to add it first.');
        }
        
        // Check if user is admin
        const isAdmin = await checkGroupAdmin(ctx, groupId, userId);
        
        if (!isAdmin) {
            return ctx.reply('❌ Only group admins can configure the bot.');
        }
        
        // Show admin panel
        await showGroupAdminPanel(ctx, groupId);
    } else {
        // Private chat - show help
        ctx.reply(
            `🤖 **Advanced Welcome Bot**\n\n` +
            `This bot helps protect your group with captcha verification.\n\n` +
            `**Super Admin Commands:**\n` +
            `/add -100GROUP_ID - Add a group\n` +
            `/remove -100GROUP_ID - Remove a group\n` +
            `/globalstats - View global stats\n\n` +
            `**Group Admin Commands:**\n` +
            `Send /start in your group to configure settings`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ============ INLINE BUTTON HANDLERS ============
bot.action(/edit_welcome_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    await ctx.editMessageText(
        `📝 **Edit Welcome Text**\n\n` +
        `Send the new welcome message.\n` +
        `Use {user} to mention the new member.\n\n` +
        `Example: "Welcome {user}! Please verify:"\n\n` +
        `_Current: ${(await db.getGroupSettings(groupId)).welcome_text}_\n\n` +
        `Send /cancel to cancel.`,
        { parse_mode: 'Markdown' }
    );
    
    // Set session using in-memory store
    const session = getSession(ctx.from.id.toString());
    session.waitingForWelcome = groupId;
    await ctx.answerCbQuery();
});

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
    
    // Go back to panel
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

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

bot.action(/toggle_kick_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const settings = await db.getGroupSettings(groupId);
    const newValue = !settings.kick_on_timeout;
    
    await db.updateGroupSettings(groupId, { kick_on_timeout: newValue });
    await ctx.answerCbQuery(`✅ Kick on timeout: ${newValue ? 'ON' : 'OFF'}`);
    
    try {
        await ctx.deleteMessage();
    } catch (e) {}
    
    ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.callbackQuery.message.chat.title };
    await showGroupAdminPanel(ctx, groupId);
});

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

bot.action(/group_stats_(.+)/, async (ctx) => {
    const groupId = ctx.match[1];
    
    if (!await checkGroupAdmin(ctx, groupId, ctx.from.id.toString())) {
        return ctx.answerCbQuery('❌ You are not an admin of this group');
    }
    
    const stats = await db.getStats(ctx.from.id.toString());
    
    const message = `
📊 **Group Statistics**
Group: ${ctx.callbackQuery.message.chat.title}

**Overview:**
👥 Total Admins: ${(await db.getGroupAdmins(groupId)).length}
⏳ Pending Captchas: ${stats.pendingCaptchas}
    `;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back', `back_to_panel_${groupId}`)]
    ]);
    
    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
});

bot.action(/close_panel_(.+)/, async (ctx) => {
    await ctx.deleteMessage();
});

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
    // Skip if no session
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
        
        // Show panel again
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
        
        // Show panel again
        ctx.chat = { id: parseInt(groupId), type: 'supergroup', title: ctx.chat.title };
        await showGroupAdminPanel(ctx, groupId);
        return;
    }
});

// ============ NEW MEMBER HANDLER ============
bot.on(message('new_chat_members'), async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    const groupId = ctx.chat.id.toString();
    
    // Check if group is allowed
    const allowed = await db.isGroupAllowed(groupId);
    if (!allowed) return;
    
    // Get group settings
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
        // Skip bot itself
        if (member.id === ctx.botInfo.id) continue;
        
        // Prevent duplicates
        const joinKey = `${groupId}:${member.id}:${ctx.message.message_id}`;
        if (processedJoins.has(joinKey)) continue;
        processedJoins.add(joinKey);
        setTimeout(() => processedJoins.delete(joinKey), 60000);
        
        // Generate captcha based on settings
        const captcha = generateCaptcha(settings.captcha_type, settings.captcha_difficulty);
        
        // Format welcome message
        let welcomeText = settings.welcome_text;
        welcomeText = welcomeText.replace(/{user}/g, `[${member.first_name}](tg://user?id=${member.id})`);
        
        // Create captcha message
        const captchaMessage = `${welcomeText}\n\n${captcha.question}\n\n_⏰ Timeout: ${settings.captcha_time} seconds_`;
        
        try {
            // Send captcha
            const sentMessage = await ctx.reply(captchaMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    force_reply: true
                }
            });
            
            // Calculate expiration
            const expireAt = new Date();
            expireAt.setSeconds(expireAt.getSeconds() + settings.captcha_time);
            
            // Save to database
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
    // Only process in groups
    if (ctx.chat.type === 'private') return;
    
    const groupId = ctx.chat.id.toString();
    const userId = ctx.from.id.toString();
    const answer = ctx.message.text.trim();
    
    // Check if this is a reply
    if (!ctx.message.reply_to_message) return;
    
    // Get captcha info
    const captchaInfo = await db.getCaptchaInfo(userId, groupId);
    
    if (!captchaInfo) return;
    
    // Check if replying to captcha message
    if (ctx.message.reply_to_message.message_id !== captchaInfo.message_id) return;
    
    // Verify captcha
    const result = await db.verifyCaptcha(userId, groupId, answer);
    
    if (result.success) {
        // Correct answer
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
        // Wrong answer
        const attemptsLeft = 3 - (result.attempts || 0);
        
        if (attemptsLeft > 0) {
            await ctx.reply(`❌ Wrong answer! ${attemptsLeft} attempts remaining.`, {
                reply_to_message_id: ctx.message.message_id
            });
        } else {
            // Too many wrong attempts - kick
            try {
                await ctx.deleteMessage(captchaInfo.message_id);
                await ctx.telegram.kickChatMember(groupId, parseInt(userId));
                await ctx.telegram.unbanChatMember(groupId, parseInt(userId));
                await db.deleteCaptcha(userId, groupId);
                
                await ctx.reply(`❌ Too many wrong attempts. ${ctx.from.first_name} was kicked.`);
            } catch (error) {
                console.error('Error kicking after wrong attempts:', error);
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

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    console.log('🛑 Bot shutting down...');
    bot.stop('SIGTERM');
});
