const crypto = require('crypto');

const SECRET = process.env.SECRET_KEY || '';
const KEY = crypto.createHash('sha256').update(SECRET || 'dev-insecure-key').digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function sign(value) {
  return crypto.createHmac('sha256', KEY).update(String(value)).digest('hex').slice(0, 32);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

// Sending presets for the common providers.
const PROVIDERS = {
  gmail:   { label: 'Gmail / Google Workspace', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993, limit: 40,
             help: 'Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords.' },
  icloud:  { label: 'iCloud Mail', smtp_host: 'smtp.mail.me.com', smtp_port: 587, smtp_secure: 0, imap_host: 'imap.mail.me.com', imap_port: 993, limit: 40,
             help: 'Create an app-specific password at account.apple.com (Sign-In and Security > App-Specific Passwords).' },
  outlook: { label: 'Outlook / Hotmail / Microsoft 365', smtp_host: 'smtp-mail.outlook.com', smtp_port: 587, smtp_secure: 0, imap_host: 'outlook.office365.com', imap_port: 993, limit: 30,
             help: 'Needs 2-step verification + an app password. Microsoft is phasing out password sign-in for many accounts; if it fails, use Gmail/iCloud/Yahoo or a custom domain.' },
  yahoo:   { label: 'Yahoo / AOL', smtp_host: 'smtp.mail.yahoo.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.mail.yahoo.com', imap_port: 993, limit: 30,
             help: 'Generate an app password in Yahoo Account Security.' },
  custom:  { label: 'Other (custom SMTP)', smtp_host: '', smtp_port: 587, smtp_secure: 0, imap_host: '', imap_port: 993, limit: 40,
             help: 'Enter the SMTP/IMAP servers from your email host.' },
};

// Fill {{field|fallback}} merge tags, then pick a random option from {a|b|c} spintax.
function render(text, vars) {
  let out = String(text || '').replace(/\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g, (_, k, fb) => {
    const v = vars[k];
    return v != null && String(v).trim() !== '' ? String(v).trim() : (fb ?? '').trim();
  });
  for (let i = 0; i < 5 && /\{[^{}]*\|[^{}]*\}/.test(out); i++) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => {
      const parts = opts.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
  }
  return out;
}

// Owner rule #1: emails to sellers never mention wholesaling or assignment.
// We present as a real estate buyer; any assignment/entity clause belongs only in the signed contract.
const BANNED = [
  [/wholesal\w*/i, 'wholesale'], [/\bassign\w*/i, 'assign / assignment / assignable'],
  [/double[\s-]*clos\w*/i, 'double close'], [/equitable\s+interest/i, 'equitable interest'],
  [/\bend[\s-]+buyers?\b/i, 'end buyer'], [/\b(my|our)\s+(cash\s+)?buyers\b/i, 'my/our buyers'],
  [/\bbuyers?\s+list\b/i, 'buyers list'], [/finder'?s\s+fee/i, "finder's fee"],
  [/flip(ping)?\s+(the|this|your)\s+contract/i, 'flip the contract'],
];
function bannedWords(text) {
  const s = String(text || '');
  return BANNED.filter(([re]) => re.test(s)).map(([re]) => s.match(re)[0]);
}

module.exports = { bannedWords, encrypt, decrypt, sign, safeEqual, esc, EMAIL_RE, PROVIDERS, render };
