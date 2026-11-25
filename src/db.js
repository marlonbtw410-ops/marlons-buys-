const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(dir, 'crm.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '',
  lead_type TEXT DEFAULT 'seller',
  status TEXT DEFAULT 'new',
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  source TEXT DEFAULT '',
  unsubscribed INTEGER DEFAULT 0,
  bounced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_contacted_at TEXT, replied_at TEXT
);

CREATE TABLE IF NOT EXISTS inboxes (
  id INTEGER PRIMARY KEY,
  provider TEXT, email TEXT NOT NULL, from_name TEXT DEFAULT '',
  smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER,
  imap_host TEXT, imap_port INTEGER,
  password_enc TEXT,
  daily_limit INTEGER DEFAULT 40,
  warmup INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  last_error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, name TEXT, subject TEXT DEFAULT '', body TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, name TEXT,
  status TEXT DEFAULT 'draft',
  target_tags TEXT DEFAULT '', target_status TEXT DEFAULT 'new',
  inbox_ids TEXT DEFAULT '',
  window_start INTEGER DEFAULT 9, window_end INTEGER DEFAULT 18,
  weekdays_only INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  step_no INTEGER, template_id INTEGER REFERENCES templates(id), delay_days INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  next_step INTEGER DEFAULT 0,
  next_send_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active',
  inbox_id INTEGER,
  last_message_id TEXT, last_subject TEXT,
  UNIQUE(campaign_id, lead_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER, inbox_id INTEGER,
  direction TEXT, subject TEXT, body TEXT,
  message_id TEXT UNIQUE,
  sent_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

{ // Approval drafts + columns added after the first release
  db.exec(`CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    inbox_id INTEGER, in_reply_to TEXT,
    subject TEXT, body TEXT, reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')), sent_at TEXT
  )`);
  // Columns added after the first release.
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  if (!cols.includes('facts')) db.exec("ALTER TABLE leads ADD COLUMN facts TEXT DEFAULT '{}'");
  if (!cols.includes('auto_info_requests')) db.exec('ALTER TABLE leads ADD COLUMN auto_info_requests INTEGER DEFAULT 0');
  if (!cols.includes('offer_due_at')) db.exec('ALTER TABLE leads ADD COLUMN offer_due_at TEXT');
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value ?? ''));
}

// Seed starter templates the first time the app runs.
if (db.prepare('SELECT COUNT(*) AS n FROM templates').get().n === 0) {
  const ins = db.prepare('INSERT INTO templates(name, subject, body) VALUES(?, ?, ?)');
  ins.run('Seller - first touch',
    '{Question|Quick question} about {{address|your property}}',
    `{Hi|Hey|Hello} {{first_name|there}},

My name is {{my_name}} - I'm a local buyer here in {{city|the area}}. I came across {{address|your property}} and wanted to reach out directly.

Would you consider an offer on it? I buy as-is (no repairs, no cleaning, no agent fees) and can close on your timeline.

Even if the timing isn't right, I'd love to know - what would need to happen for you to consider selling?

Thanks,
{{my_name}}
{{my_phone}}`);
  ins.run('Seller - follow up 1', '',
    `{Hi|Hey} {{first_name|there}}, just bumping this up in case it got buried.

Is {{address|the property}} something you'd ever think about selling? A simple "yes", "no" or "maybe later" helps a lot.

{{my_name}}`);
  ins.run('Seller - follow up 2 (last)', '',
    `{{first_name|Hi}}, I'll stop reaching out after this one.

If anything changes with {{address|the property}} - a tenant, repairs, a move, an inheritance - just reply here and I'll put together a no-obligation cash offer.

All the best,
{{my_name}}
{{my_phone}}`);
}

module.exports = { db, getSetting, setSetting };
