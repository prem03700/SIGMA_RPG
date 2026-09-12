import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const configuredPath = process.env.DB_PATH || './data/liferpg.db';
export const databasePath = resolve(configuredPath);
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    total_xp INTEGER NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
    gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
    streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
    last_active_date TEXT,
    equipped_theme TEXT NOT NULL DEFAULT 'void',
    equipped_badge TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL CHECK (category IN ('intellect', 'strength', 'discipline', 'vitality')),
    difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard', 'epic')),
    xp_reward INTEGER NOT NULL CHECK (xp_reward > 0),
    gold_reward INTEGER NOT NULL CHECK (gold_reward > 0),
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS attributes (
    user_id TEXT PRIMARY KEY,
    intellect INTEGER NOT NULL DEFAULT 0 CHECK (intellect >= 0),
    strength INTEGER NOT NULL DEFAULT 0 CHECK (strength >= 0),
    discipline INTEGER NOT NULL DEFAULT 0 CHECK (discipline >= 0),
    vitality INTEGER NOT NULL DEFAULT 0 CHECK (vitality >= 0),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS shop_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price > 0),
    type TEXT NOT NULL CHECK (type IN ('badge', 'theme', 'relic')),
    icon TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS inventory (
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    purchased_at TEXT NOT NULL,
    PRIMARY KEY (user_id, item_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (item_id) REFERENCES shop_items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    xp_delta INTEGER NOT NULL DEFAULT 0,
    gold_delta INTEGER NOT NULL DEFAULT 0,
    attribute TEXT,
    attribute_delta INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_logs(user_id, created_at DESC);
`);

const seed = db.prepare(`
  INSERT OR IGNORE INTO shop_items (id, name, description, price, type, icon, key, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const items = [
  ['badge-first-flame', 'First Flame', 'A profile badge for adventurers who start before they feel ready.', 18, 'badge', '✦', 'first-flame', 1],
  ['relic-focus-stone', 'Focus Stone', 'A collectible relic forged from one uninterrupted deep-work block.', 30, 'relic', '◆', 'focus-stone', 2],
  ['badge-iron-will', 'Iron Will', 'A badge for showing up when motivation does not.', 55, 'badge', '▲', 'iron-will', 3],
  ['theme-ember', 'Ember Protocol', 'Warm amber highlights and a battle-forged interface.', 80, 'theme', '◇', 'ember', 4],
  ['theme-forest', 'Verdant Circuit', 'Deep green energy for calm, focused progression.', 80, 'theme', '◈', 'forest', 5],
  ['relic-chrono', 'Chrono Shard', 'A rare relic celebrating consistency across time.', 110, 'relic', '◐', 'chrono-shard', 6],
  ['badge-ascendant', 'Ascendant', 'A high-tier badge for players who keep climbing.', 160, 'badge', '⬡', 'ascendant', 7]
];
for (const item of items) seed.run(...item);

export function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}
