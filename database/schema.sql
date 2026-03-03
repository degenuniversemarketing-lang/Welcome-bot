-- Create allowed_groups table
CREATE TABLE IF NOT EXISTS allowed_groups (
    group_id TEXT PRIMARY KEY,
    group_title TEXT,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create group_settings table
CREATE TABLE IF NOT EXISTS group_settings (
    group_id TEXT PRIMARY KEY REFERENCES allowed_groups(group_id) ON DELETE CASCADE,
    welcome_text TEXT DEFAULT 'Welcome to the group!',
    captcha_time INTEGER DEFAULT 120,
    captcha_enabled BOOLEAN DEFAULT TRUE,
    delete_join_message BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create pending_captcha table
CREATE TABLE IF NOT EXISTS pending_captcha (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    first_name TEXT,
    correct_answer INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, group_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_pending_captcha_expires ON pending_captcha(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_captcha_user_group ON pending_captcha(user_id, group_id);
