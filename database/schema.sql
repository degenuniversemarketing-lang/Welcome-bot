-- Create allowed_groups table
CREATE TABLE IF NOT EXISTS allowed_groups (
    group_id TEXT PRIMARY KEY,
    group_title TEXT,
    added_by TEXT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE
);

-- Create group_settings table
CREATE TABLE IF NOT EXISTS group_settings (
    group_id TEXT PRIMARY KEY REFERENCES allowed_groups(group_id) ON DELETE CASCADE,
    welcome_text TEXT DEFAULT 'Welcome {user}! Please solve this captcha to join:',
    captcha_type TEXT DEFAULT 'math',
    captcha_difficulty TEXT DEFAULT 'medium',
    captcha_time INTEGER DEFAULT 120,
    welcome_button_text TEXT DEFAULT 'Verify',
    delete_join_message BOOLEAN DEFAULT TRUE,
    kick_on_timeout BOOLEAN DEFAULT TRUE,
    custom_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create group_admins table
CREATE TABLE IF NOT EXISTS group_admins (
    id SERIAL PRIMARY KEY,
    group_id TEXT REFERENCES allowed_groups(group_id) ON DELETE CASCADE,
    admin_id TEXT NOT NULL,
    admin_username TEXT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, admin_id)
);

-- Create pending_captcha table
CREATE TABLE IF NOT EXISTS pending_captcha (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    first_name TEXT,
    username TEXT,
    correct_answer TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempt_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, group_id)
);

-- Create captcha_types table for future expansion
CREATE TABLE IF NOT EXISTS captcha_types (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT
);

-- Insert default captcha types
INSERT INTO captcha_types (name, description) VALUES 
('math', 'Simple math problems'),
('emoji', 'Count the emojis'),
('text', 'Type the displayed text'),
('question', 'Answer a question')
ON CONFLICT (name) DO NOTHING;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_pending_captcha_expires ON pending_captcha(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_captcha_user_group ON pending_captcha(user_id, group_id);
CREATE INDEX IF NOT EXISTS idx_group_admins_admin ON group_admins(admin_id);
