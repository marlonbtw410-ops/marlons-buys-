// Sending engine (campaign sequences) + reply/bounce checker.
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { db, getSetting } = require('./db');
const { decrypt, sign, render, bannedWords } = require('./util');

const DRY_RUN = process.env.DRY_RUN === '1';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const nextAllowed = new Map(); // inbox id -> timestamp (ms) when it may send again
const log = (...a) => console.log(new Date().toISOString(), ...a);

function unsubUrl(leadId) { return `${PUBLIC_URL}/u/${leadId}/${sign('unsub:' + leadId)}`; }

function transportFor(inbox) {
  if (DRY_RUN) return nodemailer.createTransport({ jsonTransport: true });
  return nodemailer.createTransport({
    host: inbox.smtp_host, port: inbox.smtp_port, secure: !!inbox.smtp_secure,
    auth: { user: inbox.email, pass: decrypt(inbox.password_enc) },
    connectionTimeout: 20000, greetingTimeout: 20000,
  });
}

function sentToday(inboxId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE inbox_id = ? AND direction = 'out'
    AND date(sent_at, 'localtime') = date('now', 'localtime')`).get(inboxId).n;
}

// Warm-up: new inboxes start at 10/day and add 2/day until they reach their limit.
function effectiveLimit(inbox) {
  if (!inbox.warmup) return inbox.daily_limit;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(inbox.created_at + 'Z')) / 86400000));
  return Math.min(inbox.daily_limit, 10 + days * 2);
}

function leadVars(lead) {
  return {
    ...lead,
    full_name: [lead.first_name, lead.last_name].filter(Boolean).join(' '),
    my_name: getSetting('my_name'), my_phone: getSetting('my_phone'), my_company: getSetting('business_name'),
  };
}

function footer(leadId) {
  const biz = [getSetting('business_name'), getSetting('mailing_address')].filter(Boolean).join(' - ');
  return `\n\n--\n${biz}\nNot interested? Reply "remove" or unsubscribe here: ${unsubUrl(leadId)}`;
}

async function sendEmail({ inbox, lead, subject, body, inReplyTo }) {
  const mail = {
    from: inbox.from_name ? { name: inbox.from_name, address: inbox.email } : inbox.email,
    to: lead.email, subject, text: body + footer(lead.id),
    headers: { 'List-Unsubscribe': `<${unsubUrl(lead.id)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
  if (inReplyTo) { mail.inReplyTo = inReplyTo; mail.references = [inReplyTo]; }
  const info = await transportFor(inbox).sendMail(mail);
  if (DRY_RUN) log(`[DRY RUN] ${inbox.email} -> ${lead.email} | ${subject}`);
  return info.messageId;
}

function inWindow(c) {
  const now = new Date();
  const h = now.getHours(), d = now.getDay();
  if (c.weekdays_only && (d === 0 || d === 6)) return false;
  return h >= c.window_start && h < c.window_end;
}

function pickInbox(ids, stickyId) {
  const candidates = stickyId ? [stickyId] : ids;
  let best = null;
  for (const id of candidates) {
    const ib = db.prepare('SELECT * FROM inboxes WHERE id = ? AND active = 1').get(id);
    if (!ib) continue;
    if ((nextAllowed.get(ib.id) || 0) > Date.now()) continue;
    const n = sentToday(ib.id);
    if (n >= effectiveLimit(ib)) continue;
    if (!best || n < best.n) best = { ib, n };
  }
  return best && best.ib;
}

function gapMs() {
  const min = Number(getSetting('min_gap_sec', '120')), max = Number(getSetting('max_gap_sec', '360'));
  return (min + Math.random() * Math.max(0, max - min)) * 1000;
}

let sending = false;
async function sendTick() {
  if (sending) return;
  sending = true;
  try {
    const campaigns = db.prepare("SELECT * FROM campaigns WHERE status = 'active'").all().filter(inWindow);
    for (const c of campaigns) {
      const inboxIds = c.inbox_ids.split(',').map(Number).filter(Boolean);
      const steps = db.prepare('SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no').all(c.id);
      if (!steps.length || !inboxIds.length) continue;
      // Follow-ups first (they convert best), then new first-touch emails.
      const due = db.prepare(`SELECT e.*, l.email, l.unsubscribed, l.bounced, l.replied_at FROM enrollments e
        JOIN leads l ON l.id = e.lead_id WHERE e.campaign_id = ? AND e.status = 'active' AND e.next_send_at <= datetime('now')
        ORDER BY e.next_step DESC, e.next_send_at LIMIT 100`).all(c.id);
      for (const e of due) {
        if (e.unsubscribed) { db.prepare("UPDATE enrollments SET status='unsubscribed' WHERE id=?").run(e.id); continue; }
        if (e.bounced) { db.prepare("UPDATE enrollments SET status='bounced' WHERE id=?").run(e.id); continue; }
        if (e.replied_at) { db.prepare("UPDATE enrollments SET status='replied' WHERE id=?").run(e.id); continue; }
        const step = steps[e.next_step];
        if (!step) { db.prepare("UPDATE enrollments SET status='done' WHERE id=?").run(e.id); continue; }
        const inbox = pickInbox(inboxIds, e.inbox_id);
        if (!inbox) { if (e.inbox_id) continue; else break; } // all inboxes busy or at limit
        const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(step.template_id);
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(e.lead_id);
        if (!tpl || !lead) continue;
        const vars = leadVars(lead);
        const subject = tpl.subject.trim() ? render(tpl.subject, vars)
          : (e.last_subject ? (/^re:/i.test(e.last_subject) ? e.last_subject : 'Re: ' + e.last_subject) : render('Following up', vars));
        const body = render(tpl.body, vars);
        const banned = bannedWords(subject + '\n' + body);
        if (banned.length) {
          // Never send: pause the campaign so the owner fixes the template.
          db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(c.id);
          log(`BLOCKED "${c.name}": template "${tpl.name}" contains banned seller wording (${banned.join(', ')}). Campaign paused.`);
          break;
        }
        nextAllowed.set(inbox.id, Date.now() + gapMs());
        try {
          const msgId = await sendEmail({ inbox, lead, subject, body, inReplyTo: e.last_message_id });
          db.prepare(`INSERT INTO messages(lead_id, campaign_id, inbox_id, direction, subject, body, message_id)
            VALUES(?, ?, ?, 'out', ?, ?, ?)`).run(lead.id, c.id, inbox.id, subject, body, msgId);
          const next = steps[e.next_step + 1];
          db.prepare(`UPDATE enrollments SET next_step = next_step + 1, inbox_id = ?, last_message_id = ?, last_subject = ?,
            status = ?, next_send_at = datetime('now', ?) WHERE id = ?`)
            .run(inbox.id, msgId, subject, next ? 'active' : 'done', `+${next ? next.delay_days : 0} days`, e.id);
          db.prepare(`UPDATE leads SET last_contacted_at = datetime('now'),
            status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END WHERE id = ?`).run(lead.id);
          db.prepare("UPDATE inboxes SET last_error = '' WHERE id = ?").run(inbox.id);
          log(`sent step ${e.next_step + 1} of "${c.name}" to ${lead.email} via ${inbox.email}`);
        } catch (err) {
          log(`send failed via ${inbox.email}: ${err.message}`);
          db.prepare('UPDATE inboxes SET last_error = ? WHERE id = ?').run(String(err.message).slice(0, 300), inbox.id);
          // Auth/limit errors: rest this inbox for 30 minutes rather than hammering it.
          nextAllowed.set(inbox.id, Date.now() + 30 * 60 * 1000);
          // A hard "no such recipient" rejection means a bad address: mark it bounced, never retry.
          if (err.responseCode >= 550 && err.responseCode <= 553 && /recipient|mailbox|user|address/i.test(err.message)) {
            nextAllowed.set(inbox.id, Date.now() + gapMs());
            db.prepare('UPDATE leads SET bounced = 1 WHERE id = ?').run(lead.id);
            db.prepare("UPDATE enrollments SET status = 'bounced' WHERE id = ?").run(e.id);
          }
        }
      }
    }
  } catch (err) { log('send tick error:', err.message); }
  finally { sending = false; }
}

const STOP_RE = /\b(unsubscribe|stop|remove me|take me off|do not (contact|email)|don'?t (contact|email)|not interested)\b/i;

function bodyFromSource(src) {
  const s = src.toString('utf8');
  const i = s.search(/\r?\n\r?\n/);
  return (i >= 0 ? s.slice(i) : s).replace(/<[^>]+>/g, ' ').replace(/=\r?\n/g, '').replace(/\s+/g, ' ').trim();
}

let checking = false;
async function checkReplies() {
  if (checking || DRY_RUN) return;
  checking = true;
  try {
    const inboxes = db.prepare("SELECT * FROM inboxes WHERE active = 1 AND imap_host != ''").all();
    for (const inbox of inboxes) {
      const client = new ImapFlow({
        host: inbox.imap_host, port: inbox.imap_port, secure: true, logger: false,
        auth: { user: inbox.email, pass: decrypt(inbox.password_enc) },
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          const since = new Date(Date.now() - 3 * 86400000);
          const uids = await client.search({ since }, { uid: true });
          for await (const m of client.fetch(uids.slice(-300), { envelope: true }, { uid: true })) {
            const from = (m.envelope.from?.[0]?.address || '').toLowerCase();
            const msgId = m.envelope.messageId || `uid-${inbox.id}-${m.uid}`;
            if (!from || db.prepare('SELECT 1 FROM messages WHERE message_id = ?').get(msgId)) continue;
            if (/mailer-daemon|postmaster/.test(from)) {
              const full = await client.fetchOne(m.uid, { source: { maxLength: 30000 } }, { uid: true });
              const text = full?.source?.toString('utf8') || '';
              for (const addr of new Set((text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map(a => a.toLowerCase()))) {
                const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get(addr);
                if (lead) {
                  db.prepare('UPDATE leads SET bounced = 1 WHERE id = ?').run(lead.id);
                  db.prepare("UPDATE enrollments SET status = 'bounced' WHERE lead_id = ? AND status = 'active'").run(lead.id);
                  log(`bounce detected for ${addr}`);
                }
              }
              db.prepare("INSERT OR IGNORE INTO messages(lead_id, inbox_id, direction, subject, body, message_id) VALUES(NULL, ?, 'bounce', ?, '', ?)")
                .run(inbox.id, m.envelope.subject || '', msgId);
              continue;
            }
            const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get(from);
            if (!lead) continue;
            const full = await client.fetchOne(m.uid, { source: { maxLength: 20000 } }, { uid: true });
            const body = full?.source ? bodyFromSource(full.source).slice(0, 2000) : '';
            db.prepare(`INSERT OR IGNORE INTO messages(lead_id, inbox_id, direction, subject, body, message_id, sent_at)
              VALUES(?, ?, 'in', ?, ?, ?, datetime(?))`)
              .run(lead.id, inbox.id, m.envelope.subject || '', body, msgId, (m.envelope.date || new Date()).toISOString());
            const optOut = STOP_RE.test(body.slice(0, 400));
            db.prepare(`UPDATE leads SET replied_at = datetime('now'), unsubscribed = CASE WHEN ? THEN 1 ELSE unsubscribed END,
              status = CASE WHEN ? THEN 'dead' WHEN status IN ('new','contacted') THEN 'replied' ELSE status END WHERE id = ?`)
              .run(optOut ? 1 : 0, optOut ? 1 : 0, lead.id);
            db.prepare("UPDATE enrollments SET status = 'replied' WHERE lead_id = ? AND status = 'active'").run(lead.id);
            log(`reply from ${from}${optOut ? ' (opt-out)' : ''}`);
          }
        } finally { lock.release(); }
        await client.logout();
      } catch (err) {
        log(`IMAP check failed for ${inbox.email}: ${err.message}`);
        try { client.close(); } catch {}
      }
    }
  } finally { checking = false; }
}

function start() {
  setInterval(sendTick, 30 * 1000);
  setInterval(checkReplies, 5 * 60 * 1000);
  setTimeout(sendTick, 3000);
  setTimeout(checkReplies, 15000);
  log(`engine started${DRY_RUN ? ' (DRY RUN - no real email is sent)' : ''}`);
}

module.exports = { start, sendTick, checkReplies, sendEmail, sentToday, effectiveLimit, transportFor, unsubUrl, leadVars };
