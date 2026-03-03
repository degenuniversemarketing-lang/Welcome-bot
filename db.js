import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS allowed_groups (
      group_id BIGINT PRIMARY KEY,
      group_title TEXT,
      added_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_settings (
      group_id BIGINT PRIMARY KEY,
      welcome_text TEXT DEFAULT 'Welcome to the group!',
      captcha_enabled BOOLEAN DEFAULT true,
      captchakick_enabled BOOLEAN DEFAULT true,
      captcha_time INTEGER DEFAULT 120
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_captcha (
      user_id BIGINT,
      group_id BIGINT,
      correct_answer TEXT,
      message_id BIGINT,
      expire_at TIMESTAMP
    );
  `);
}
