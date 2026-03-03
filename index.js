const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
require('dotenv').config();

const db = require('./db');

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.BOT_ADMIN_ID;

// Track processed join events to avoid duplicates
const processedJoins = new Set();

// Initialize database and start bot
async function startBot() {
    // Connect to database
    const dbConnected = await db.initDatabase();
    if (!dbConnected) {
        console.error('Failed to connect to database. Exiting...');
        process.exit(1);
    }
    
    console.log('🚀 Bot is starting...');
    
    // Start cleaning expired captchas every 30 seconds
    setInterval(cleanExpiredCaptchas, 30000);
    
    // Start webhook or polling
    if (process.env.WEBHOOK_URL) {
        // Use webhook for production (Railway)
        const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;
        await bot.telegram.setWebhook(webhookUrl);
        console.log(`✅ Webhook set to: ${webhookUrl}`);
    } else {
        // Use polling for development
        bot.launch();
        console.log('✅ Bot started with long polling');
    }
}

// Clean expired captchas
async function cleanExpiredCaptchas() {
    try {
        const expired = await db.getExpiredCaptchas();
        
        for (const captcha of expired) {
            try {
                // Kick the user
                await bot.telegram.kickChatMember(captcha.group_id, parseInt(captcha.user_id));
                await bot.telegram.unbanChatMember(captcha.group_id, parseInt(captcha.user_id)); // Unban to allow rejoin later
                
                // Delete the captcha message
                await bot.telegram.deleteMessage(captcha.group_id, captcha.message_id).catch(() => {});
                
                // Remove from database
                await db.deleteCaptcha(captcha.user_id, captcha.group_id);
                
                console.log(`⏰ Kicked expired user ${captcha.first_name} (${captcha.user_id}) from group ${captcha.group_id}`);
            } catch (error) {
                console.error('Error processing expired captcha:', error);
                // Still remove from DB to avoid infinite loops
                await db.deleteCaptcha(captcha.user_id, captcha.group_id).catch(() => {});
            }
        }
    } catch (error) {
        console.error('Error in cleanExpiredCaptchas:', error);
    }
}

// Generate random math captcha
function generateMathCaptcha() {
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    return {
        question: `${a} + ${b} = ?`,
        answer: a + b
    };
}

// Format welcome message with user mention
function formatWelcomeMessage(text, firstName) {
    return text.replace(/{user}/g, firstName);
}

// ============ ADMIN COMMANDS (Private Chat Only) ============

// /add command
bot.command('add', async (ctx) => {
    // Check if private chat and admin
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== ADMIN_ID) {
        return;
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
        // Try to get chat info to verify group exists
        const chat = await bot.telegram.getChat(groupId);
        
        // Add to database
        const added = await db.addGroup(groupId, chat.title || 'Unknown Group');
        
        if (added) {
            ctx.reply(`✅ Group added successfully!\n📌 ${chat.title} (${groupId})`);
        } else {
            ctx.reply('❌ Group already exists or error adding.');
        }
    } catch (error) {
        console.error('Error adding group:', error);
        ctx.reply('❌ Failed to add group. Make sure:\n1. Group ID is correct\n2. Bot is admin in the group');
    }
});

// /remove command
bot.command('remove', async (ctx) => {
    // Check if private chat and admin
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== ADMIN_ID) {
        return;
    }
    
    const args = ctx.message.text.split(' ');
    if (args.length !== 2) {
        return ctx.reply('❌ Usage: /remove -100GROUP_ID');
    }
    
    const groupId = args[1];
    
    const removed = await db.removeGroup(groupId);
    
    if (removed) {
        ctx.reply(`❌ Group ${groupId} removed successfully.`);
    } else {
        ctx.reply('❌ Group not found or error removing.');
    }
});

// /stats command
bot.command('stats', async (ctx) => {
    // Check if private chat and admin
    if (ctx.chat.type !== 'private' || ctx.from.id.toString() !== ADMIN_ID) {
        return;
    }
    
    const stats = await db.getStats();
    
    if (!stats) {
        return ctx.reply('❌ Error fetching stats.');
    }
    
    let message = `📊 **Bot Statistics**\n\n`;
    message += `**Active Groups:** ${stats.totalGroups}\n`;
    message += `**Pending Captchas:** ${stats.pendingCaptchas}\n\n`;
    message += `**Groups List:**\n`;
    
    if (stats.groups.length === 0) {
        message += `No groups added yet.\n`;
    } else {
        stats.groups.forEach((group, index) => {
            message += `${index + 1}. ${group.group_title || 'Unknown'} (${group.group_id})\n`;
        });
    }
    
    ctx.reply(message, { parse_mode: 'Markdown' });
});

// ============ GROUP FEATURES ============

// Check if bot should process messages in this group
bot.use(async (ctx, next) => {
    // Skip private chats for group checks
    if (ctx.chat.type === 'private') {
        return next();
    }
    
    // Check if group is allowed
    const allowed = await db.isGroupAllowed(ctx.chat.id.toString());
    
    if (!allowed) {
        // Ignore messages from non-allowed groups
        return;
    }
    
    return next();
});

// Handle new chat members
bot.on(message('new_chat_members'), async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    const groupId = ctx.chat.id.toString();
    
    // Check if group is allowed (double-check)
    const allowed = await db.isGroupAllowed(groupId);
    if (!allowed) return;
    
    // Get group settings
    const settings = await db.getGroupSettings(groupId);
    
    // For each new member
    for (const member of newMembers) {
        // Skip if it's the bot itself
        if (member.id === ctx.botInfo.id) {
            continue;
        }
        
        // Create unique key to prevent duplicate processing
        const joinKey = `${groupId}:${member.id}:${ctx.message.message_id}`;
        
        // Check if already processed (avoid duplicates from Telegram)
        if (processedJoins.has(joinKey)) {
            continue;
        }
        processedJoins.add(joinKey);
        
        // Clean up old keys after 1 minute
        setTimeout(() => processedJoins.delete(joinKey), 60000);
        
        // Generate captcha
        const captcha = generateMathCaptcha();
        
        // Format welcome message
        const welcomeText = settings ? settings.welcome_text : 'Welcome to the group!';
        const formattedText = formatWelcomeMessage(welcomeText, member.first_name);
        
        // Create captcha message
        const captchaMessage = `${formattedText}\n\n🔐 **Verification Required**\nSolve this simple math:\n**${captcha.question}**\n\n_Reply with the answer within ${settings?.captcha_time || 120} seconds._`;
        
        try {
            // Send captcha message
            const sentMessage = await ctx.reply(captchaMessage, {
                parse_mode: 'Markdown',
                reply_to_message_id: ctx.message.message_id
            });
            
            // Calculate expiration time
            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + (settings?.captcha_time || 120));
            
            // Save to database
            await db.saveCaptcha(
                member.id.toString(),
                groupId,
                member.first_name,
                captcha.answer,
                sentMessage.message_id,
                expiresAt
            );
            
            console.log(`🆕 Captcha sent to ${member.first_name} (${member.id}) in group ${groupId}`);
            
        } catch (error) {
            console.error('Error sending captcha:', error);
        }
    }
});

// Handle captcha answers
bot.on('text', async (ctx) => {
    // Only process in groups
    if (ctx.chat.type === 'private') return;
    
    const groupId = ctx.chat.id.toString();
    const userId = ctx.from.id.toString();
    const answer = ctx.message.text.trim();
    
    // Check if this is a reply to captcha message
    if (!ctx.message.reply_to_message) return;
    
    // Check if group is allowed
    const allowed = await db.isGroupAllowed(groupId);
    if (!allowed) return;
    
    // Get captcha info
    const captchaInfo = await db.getCaptchaInfo(userId, groupId);
    
    if (!captchaInfo) return;
    
    // Check if the reply is to the captcha message
    if (ctx.message.reply_to_message.message_id !== captchaInfo.message_id) return;
    
    // Verify captcha
    const isValid = await db.verifyCaptcha(userId, groupId, answer);
    
    if (isValid) {
        // Correct answer
        try {
            // Delete captcha message
            await ctx.deleteMessage(captchaInfo.message_id);
            
            // Send verification message
            await ctx.reply(`✅ Verified, ${ctx.from.first_name}!`, {
                reply_to_message_id: ctx.message.message_id
            });
            
            console.log(`✅ ${ctx.from.first_name} (${userId}) verified in group ${groupId}`);
        } catch (error) {
            console.error('Error handling correct answer:', error);
        }
    } else {
        // Wrong answer
        try {
            await ctx.reply(`❌ Wrong answer, try again!`, {
                reply_to_message_id: ctx.message.message_id
            });
        } catch (error) {
            console.error('Error handling wrong answer:', error);
        }
    }
});

// Handle left chat members (clean up if user leaves)
bot.on('left_chat_member', async (ctx) => {
    const groupId = ctx.chat.id.toString();
    const userId = ctx.message.left_chat_member.id.toString();
    
    // Remove from pending captchas if exists
    await db.deleteCaptcha(userId, groupId).catch(() => {});
});

// Error handler
bot.catch((err, ctx) => {
    console.error(`Bot error for ${ctx.updateType}:`, err);
});

// Start the bot
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
