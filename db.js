const { Pool } = require('pg');
require('dotenv').config();

// Create PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for Railway
    }
});

// Test database connection and initialize tables
async function initDatabase() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL database');
        
        // Check if tables exist, if not, they'll be created by schema.sql
        // You should run schema.sql manually first time
        client.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection error:', error);
        return false;
    }
}

// Group management functions
async function addGroup(groupId, groupTitle) {
    try {
        // Insert into allowed_groups
        await pool.query(
            'INSERT INTO allowed_groups (group_id, group_title) VALUES ($1, $2) ON CONFLICT (group_id) DO NOTHING',
            [groupId, groupTitle]
        );
        
        // Insert default settings
        await pool.query(
            'INSERT INTO group_settings (group_id) VALUES ($1) ON CONFLICT (group_id) DO NOTHING',
            [groupId]
        );
        
        return true;
    } catch (error) {
        console.error('Error adding group:', error);
        return false;
    }
}

async function removeGroup(groupId) {
    try {
        // This will cascade delete settings due to foreign key
        await pool.query('DELETE FROM allowed_groups WHERE group_id = $1', [groupId]);
        return true;
    } catch (error) {
        console.error('Error removing group:', error);
        return false;
    }
}

async function isGroupAllowed(groupId) {
    try {
        const result = await pool.query(
            'SELECT 1 FROM allowed_groups WHERE group_id = $1',
            [groupId]
        );
        return result.rows.length > 0;
    } catch (error) {
        console.error('Error checking group:', error);
        return false;
    }
}

async function getGroupSettings(groupId) {
    try {
        const result = await pool.query(
            'SELECT * FROM group_settings WHERE group_id = $1',
            [groupId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('Error getting settings:', error);
        return null;
    }
}

// Captcha management functions
async function saveCaptcha(userId, groupId, firstName, correctAnswer, messageId, expiresAt) {
    try {
        await pool.query(
            `INSERT INTO pending_captcha (user_id, group_id, first_name, correct_answer, message_id, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id, group_id) 
             DO UPDATE SET correct_answer = $4, message_id = $5, expires_at = $6, first_name = $3`,
            [userId, groupId, firstName, correctAnswer, messageId, expiresAt]
        );
        return true;
    } catch (error) {
        console.error('Error saving captcha:', error);
        return false;
    }
}

async function verifyCaptcha(userId, groupId, answer) {
    try {
        const result = await pool.query(
            'SELECT correct_answer FROM pending_captcha WHERE user_id = $1 AND group_id = $2',
            [userId, groupId]
        );
        
        if (result.rows.length === 0) return false;
        
        const isCorrect = parseInt(answer) === result.rows[0].correct_answer;
        
        if (isCorrect) {
            await pool.query(
                'DELETE FROM pending_captcha WHERE user_id = $1 AND group_id = $2',
                [userId, groupId]
            );
        }
        
        return isCorrect;
    } catch (error) {
        console.error('Error verifying captcha:', error);
        return false;
    }
}

async function getCaptchaInfo(userId, groupId) {
    try {
        const result = await pool.query(
            'SELECT * FROM pending_captcha WHERE user_id = $1 AND group_id = $2',
            [userId, groupId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('Error getting captcha:', error);
        return null;
    }
}

async function getExpiredCaptchas() {
    try {
        const result = await pool.query(
            'SELECT * FROM pending_captcha WHERE expires_at < NOW()'
        );
        return result.rows;
    } catch (error) {
        console.error('Error getting expired captchas:', error);
        return [];
    }
}

async function deleteCaptcha(userId, groupId) {
    try {
        await pool.query(
            'DELETE FROM pending_captcha WHERE user_id = $1 AND group_id = $2',
            [userId, groupId]
        );
        return true;
    } catch (error) {
        console.error('Error deleting captcha:', error);
        return false;
    }
}

async function getStats() {
    try {
        const groupsResult = await pool.query('SELECT COUNT(*) FROM allowed_groups');
        const captchasResult = await pool.query('SELECT COUNT(*) FROM pending_captcha');
        const groupsList = await pool.query('SELECT group_id, group_title FROM allowed_groups ORDER BY added_at DESC');
        
        return {
            totalGroups: parseInt(groupsResult.rows[0].count),
            pendingCaptchas: parseInt(captchasResult.rows[0].count),
            groups: groupsList.rows
        };
    } catch (error) {
        console.error('Error getting stats:', error);
        return null;
    }
}

module.exports = {
    pool,
    initDatabase,
    addGroup,
    removeGroup,
    isGroupAllowed,
    getGroupSettings,
    saveCaptcha,
    verifyCaptcha,
    getCaptchaInfo,
    getExpiredCaptchas,
    deleteCaptcha,
    getStats
};
