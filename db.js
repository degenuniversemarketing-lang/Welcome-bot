const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function initDatabase() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL database');
        client.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection error:', error);
        return false;
    }
}

// ============ GROUP MANAGEMENT ============
async function addGroup(groupId, groupTitle, addedBy) {
    try {
        const checkResult = await pool.query(
            'SELECT group_id FROM allowed_groups WHERE group_id = $1',
            [groupId]
        );
        
        if (checkResult.rows.length > 0) {
            return false;
        }
        
        await pool.query(
            'INSERT INTO allowed_groups (group_id, group_title, added_by) VALUES ($1, $2, $3)',
            [groupId, groupTitle, addedBy]
        );
        
        await pool.query(
            'INSERT INTO group_settings (group_id) VALUES ($1)',
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
            'SELECT is_active FROM allowed_groups WHERE group_id = $1',
            [groupId]
        );
        return result.rows.length > 0 && result.rows[0].is_active === true;
    } catch (error) {
        console.error('Error checking group:', error);
        return false;
    }
}

// ============ ADMIN MANAGEMENT ============
async function addGroupAdmin(groupId, adminId, adminUsername) {
    try {
        await pool.query(
            'INSERT INTO group_admins (group_id, admin_id, admin_username) VALUES ($1, $2, $3) ON CONFLICT (group_id, admin_id) DO NOTHING',
            [groupId, adminId, adminUsername]
        );
        return true;
    } catch (error) {
        console.error('Error adding group admin:', error);
        return false;
    }
}

async function isGroupAdmin(groupId, userId) {
    try {
        const result = await pool.query(
            'SELECT 1 FROM group_admins WHERE group_id = $1 AND admin_id = $2',
            [groupId, userId]
        );
        return result.rows.length > 0;
    } catch (error) {
        console.error('Error checking group admin:', error);
        return false;
    }
}

async function getGroupAdmins(groupId) {
    try {
        const result = await pool.query(
            'SELECT admin_id, admin_username FROM group_admins WHERE group_id = $1',
            [groupId]
        );
        return result.rows;
    } catch (error) {
        console.error('Error getting group admins:', error);
        return [];
    }
}

// ============ GROUP SETTINGS ============
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

async function updateGroupSettings(groupId, settings) {
    try {
        const allowedFields = [
            'welcome_text', 'welcome_image', 'welcome_buttons',
            'captcha_type', 'captcha_difficulty', 'captcha_time',
            'punishment_action', 'max_attempts', 'mute_duration',
            'delete_join_message', 'button1_text', 'button1_url',
            'button2_text', 'button2_url'
        ];
        
        const updates = [];
        const values = [groupId];
        let paramIndex = 2;
        
        for (const [key, value] of Object.entries(settings)) {
            if (allowedFields.includes(key)) {
                updates.push(`${key} = $${paramIndex}`);
                values.push(value);
                paramIndex++;
            }
        }
        
        if (updates.length === 0) return false;
        
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        
        const query = `UPDATE group_settings SET ${updates.join(', ')} WHERE group_id = $1`;
        await pool.query(query, values);
        return true;
    } catch (error) {
        console.error('Error updating settings:', error);
        return false;
    }
}

// ============ CAPTCHA MANAGEMENT ============
async function saveCaptcha(userId, groupId, firstName, username, correctAnswer, messageId, expireAt) {
    try {
        await pool.query(
            `INSERT INTO pending_captcha (user_id, group_id, first_name, username, correct_answer, message_id, expire_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id, group_id) 
             DO UPDATE SET correct_answer = $5, message_id = $6, expire_at = $7, 
                           first_name = $3, username = $4, attempt_count = 0`,
            [userId, groupId, firstName, username, correctAnswer, messageId, expireAt]
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
            'SELECT correct_answer, attempt_count FROM pending_captcha WHERE user_id = $1 AND group_id = $2',
            [userId, groupId]
        );
        
        if (result.rows.length === 0) return { success: false, reason: 'not_found' };
        
        const isCorrect = answer.toString().trim() === result.rows[0].correct_answer.toString().trim();
        
        if (isCorrect) {
            await pool.query(
                'DELETE FROM pending_captcha WHERE user_id = $1 AND group_id = $2',
                [userId, groupId]
            );
            return { success: true };
        } else {
            await pool.query(
                'UPDATE pending_captcha SET attempt_count = attempt_count + 1 WHERE user_id = $1 AND group_id = $2',
                [userId, groupId]
            );
            return { success: false, reason: 'wrong_answer', attempts: result.rows[0].attempt_count + 1 };
        }
    } catch (error) {
        console.error('Error verifying captcha:', error);
        return { success: false, reason: 'error' };
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
            'SELECT * FROM pending_captcha WHERE expire_at < NOW()'
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

// ============ STATISTICS ============
async function getStats() {
    try {
        const groupsResult = await pool.query('SELECT COUNT(*) as count FROM allowed_groups');
        const captchasResult = await pool.query('SELECT COUNT(*) as count FROM pending_captcha');
        const groupsList = await pool.query(
            'SELECT group_id, group_title, is_active FROM allowed_groups ORDER BY added_at DESC'
        );
        
        return {
            totalGroups: parseInt(groupsResult.rows[0].count),
            pendingCaptchas: parseInt(captchasResult.rows[0].count),
            groups: groupsList.rows
        };
    } catch (error) {
        console.error('Error getting stats:', error);
        return { totalGroups: 0, pendingCaptchas: 0, groups: [] };
    }
}

module.exports = {
    pool,
    initDatabase,
    addGroup,
    removeGroup,
    isGroupAllowed,
    addGroupAdmin,
    isGroupAdmin,
    getGroupAdmins,
    getGroupSettings,
    updateGroupSettings,
    saveCaptcha,
    verifyCaptcha,
    getCaptchaInfo,
    getExpiredCaptchas,
    deleteCaptcha,
    getStats
};
