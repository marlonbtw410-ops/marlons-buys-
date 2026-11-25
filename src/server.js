require('./env');
const express = require('express');
const { parse } = require('csv-parse/sync');
const { db, getSetting, setSetting } = require('./db');
const { encrypt, sign, safeEqual, esc, EMAIL_RE, PROVIDERS, render, bannedWords } = require('./util');
const { layout, bare, options, STATUSES, statusLabel } = require('./views');
const engine = require('./engine');
const replies = require('./replies');

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '25mb' }));
app.use((req, res, next) => { req.body ??= {}; next(); });

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const AUTH_TOKEN = sign('admin:' + APP_PASSWORD);
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
const back = (res, url, msg) => res.redirect(url + (msg ? (url.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg) : ''));
const pendingCount = () => db.prepare("SELECT COUNT(*) n FROM drafts WHERE status = 'pending'").get().n;
const page = (req, res, title, body, active) => res.send(layout(title, body, { active, flash: req.query.msg, pending: pendingCount() }));
const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const splitTags = s => String(s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

// ---------- Public pages (no login) ----------

app.get('/login', (req, res) => res.send(bare('Log in', `<div class="card"><h1>Lead CRM</h1>
  ${req.query.bad ? '<p class="err">Wrong password.</p>' : ''}
  <form method="post" action="/login"><label>Password</label><input type="password" name="password" autofocus>
  <div class="actions"><button>Log in</button></div></form></div>`)));

app.post('/login', (req, res) => {
  if (APP_PASSWORD && safeEqual(req.body.password || '', APP_PASSWORD)) {
    res.setHeader('Set-Cookie', `auth=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return res.redirect('/');
  }
  res.redirect('/login?bad=1');
});

// Unsubscribe link (GET shows a page, POST is the one-click unsubscribe mail apps use).
function unsubscribe(req, res) {
  const id = int(req.params.id);
  if (!safeEqual(req.params.token, sign('unsub:' + id))) return res.status(400).send('Invalid link');
  db.prepare("UPDATE leads SET unsubscribed = 1, status = CASE WHEN status IN ('new','contacted') THEN 'dead' ELSE status END WHERE id = ?").run(id);
  db.prepare("UPDATE enrollments SET status = 'unsubscribed' WHERE lead_id = ? AND status = 'active'").run(id);
  res.send(bare('Unsubscribed', `<div class="card"><h1>You're unsubscribed</h1><p>You won't receive any more emails from ${esc(getSetting('business_name', 'us'))}.</p></div>`));
}
app.get('/u/:id/:token', unsubscribe);
app.post('/u/:id/:token', unsubscribe);

// Public "sell your house" form - share this link on social media, flyers, bandit signs, etc.
app.get('/sell', (req, res) => {
  const biz = getSetting('business_name', 'We Buy Houses');
  if (req.query.done) return res.send(bare(biz, `<div class="card"><h1>Thanks! We got it.</h1>
    <p>${esc(getSetting('my_name', 'We'))} will reach out shortly with next steps.</p></div>`));
  res.send(bare(biz, `<div class="card"><h1>${esc(getSetting('sell_headline', 'Sell your house fast, as-is, for cash'))}</h1>
  <p class="muted">${esc(getSetting('sell_subtext', 'No repairs, no agent fees, close on your timeline. Tell us about the property and get a no-obligation offer.'))}</p>
  <form method="post" action="/sell">
  <div class="row"><div><label>First name</label><input name="first_name" required></div><div><label>Last name</label><input name="last_name"></div></div>
  <label>Email</label><input type="email" name="email" required>
  <label>Phone (optional)</label><input name="phone">
  <label>Property address</label><input name="address" required>
  <div class="row"><div><label>City</label><input name="city"></div><div><label>State</label><input name="state"></div><div><label>ZIP</label><input name="zip"></div></div>
  <label>Anything we should know? (condition, timeline, tenants...)</label><textarea name="notes" style="min-height:80px"></textarea>
  <input name="website" style="display:none" tabindex="-1" autocomplete="off">
  <div class="actions"><button>Get my offer</button></div></form></div>
  <p class="muted" style="text-align:center">${esc(biz)}${getSetting('my_phone') ? ' - ' + esc(getSetting('my_phone')) : ''}</p>`));
});

app.post('/sell', (req, res) => {
  const b = req.body;
  if (b.website) return res.redirect('/sell?done=1'); // spam-bot trap
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).send(bare('Error', '<div class="card">Please go back and enter a valid email.</div>'));
  const f = k => String(b[k] || '').trim().slice(0, 500);
  const existing = db.prepare('SELECT id, notes FROM leads WHERE email = ?').get(email);
  const note = `[Website form ${new Date().toLocaleDateString()}] ${f('notes')}`.trim();
  if (existing) {
    db.prepare(`UPDATE leads SET status = 'interested', notes = ? || char(10) || notes, unsubscribed = 0,
      address = COALESCE(NULLIF(?, ''), address), phone = COALESCE(NULLIF(?, ''), phone) WHERE id = ?`)
      .run(note, f('address'), f('phone'), existing.id);
  } else {
    db.prepare(`INSERT INTO leads(first_name, last_name, email, phone, address, city, state, zip, status, tags, notes, source)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'interested', 'inbound', ?, 'website form')`)
      .run(f('first_name'), f('last_name'), email, f('phone'), f('address'), f('city'), f('state'), f('zip'), note);
  }
  res.redirect('/sell?done=1');
});

// ---------- Everything below requires login ----------

app.use((req, res, next) => {
  if (!APP_PASSWORD) return res.status(500).send('Set APP_PASSWORD in your .env file first.');
  if (safeEqual(cookie(req).auth || '', AUTH_TOKEN)) return next();
  res.redirect('/login');
});

app.post('/logout', (req, res) => { res.setHeader('Set-Cookie', 'auth=; Path=/; Max-Age=0'); res.redirect('/login'); });

// ---------- Dashboard ----------

app.get('/', (req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const total = one('SELECT COUNT(*) n FROM leads');
  const sentToday = one("SELECT COUNT(*) n FROM messages WHERE direction='out' AND date(sent_at,'localtime')=date('now','localtime')");
  const sent7 = one("SELECT COUNT(*) n FROM messages WHERE direction='out' AND sent_at >= datetime('now','-7 days')");
  const replies7 = one("SELECT COUNT(*) n FROM messages WHERE direction='in' AND sent_at >= datetime('now','-7 days')");
  const contacted = one('SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE direction=\'out\'');
  const replied = one("SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE direction='in'");
  const queued = one("SELECT COUNT(*) n FROM enrollments e JOIN campaigns c ON c.id=e.campaign_id WHERE e.status='active' AND c.status='active'");
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM leads GROUP BY status').all().map(r => [r.status, r.n]));
  const inboxes = db.prepare('SELECT * FROM inboxes ORDER BY id').all();
  const capacity = inboxes.filter(i => i.active).reduce((s, i) => s + engine.effectiveLimit(i), 0);
  const recent = db.prepare(`SELECT m.*, l.first_name, l.last_name, l.email, l.address FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE m.direction = 'in' ORDER BY m.sent_at DESC LIMIT 10`).all();
  const setupTodo = [];
  if (!inboxes.length) setupTodo.push('<a href="/inboxes">Connect at least one email inbox</a>');
  if (!getSetting('mailing_address')) setupTodo.push('<a href="/settings">Add your business name + mailing address</a> (required by law in marketing emails)');
  if (!total) setupTodo.push('<a href="/import">Import your first lead list</a>');
  if (!db.prepare("SELECT 1 FROM campaigns WHERE status='active'").get()) setupTodo.push('<a href="/campaigns">Create and start a campaign</a>');

  const waiting = pendingCount();
  const offersDue = db.prepare("SELECT * FROM leads WHERE status = 'offer_due' ORDER BY offer_due_at").all();
  const today = new Date().toISOString().slice(0, 10);
  page(req, res, 'Dashboard', `<h1>Dashboard</h1>
  ${waiting ? `<div class="card" style="border-left:4px solid var(--brand)"><h2>${waiting} repl${waiting === 1 ? 'y needs' : 'ies need'} your OK</h2>
    <p>Sellers asked questions. A reply is drafted for each one. <a class="btn" href="/approvals">Review &amp; send</a></p></div>` : ''}
  <div class="card"><h2>Offers you owe</h2>${offersDue.length ? `<table><tr><th>Seller</th><th>Property</th><th>Promised by</th></tr>
    ${offersDue.map(l => `<tr><td><a href="/leads/${l.id}">${esc(l.first_name)} ${esc(l.last_name)}</a></td><td>${esc(l.address)}</td>
    <td class="${l.offer_due_at && l.offer_due_at < today ? 'err' : l.offer_due_at === today ? 'warn' : ''}">${esc(l.offer_due_at || '-')}${l.offer_due_at && l.offer_due_at < today ? ' (late)' : ''}</td></tr>`).join('')}</table>`
    : '<p class="muted">None right now. When a seller gives you everything, they show up here with the date you promised.</p>'}</div>
  ${setupTodo.length ? `<div class="card"><h2>Getting started</h2><ol>${setupTodo.map(t => `<li>${t}</li>`).join('')}</ol></div>` : ''}
  <div class="grid">
    <div class="stat"><div>${sentToday} / ${capacity}</div><span>Sent today / daily capacity</span></div>
    <div class="stat"><div>${queued}</div><span>Leads queued in active campaigns</span></div>
    <div class="stat"><div>${sent7}</div><span>Emails sent (7 days)</span></div>
    <div class="stat"><div>${replies7}</div><span>Replies (7 days)</span></div>
    <div class="stat"><div>${contacted ? ((replied / contacted) * 100).toFixed(1) : '0.0'}%</div><span>Reply rate (all time)</span></div>
    <div class="stat"><div>${total}</div><span>Total leads</span></div>
  </div>
  <div class="card"><h2>Pipeline</h2><div class="grid" style="margin:0">${STATUSES.map(s =>
    `<a class="stat" style="text-decoration:none;color:inherit" href="/leads?status=${s}"><div>${byStatus[s] || 0}</div><span>${statusLabel(s)}</span></a>`).join('')}</div></div>
  <div class="card"><h2>Latest replies</h2>${recent.length ? `<table><tr><th>From</th><th>Property</th><th>Message</th><th>When</th></tr>
    ${recent.map(m => `<tr><td><a href="/leads/${m.lead_id}">${esc(m.first_name)} ${esc(m.last_name)}</a><br><span class="muted">${esc(m.email)}</span></td>
    <td>${esc(m.address)}</td><td>${esc(m.body.slice(0, 160))}</td><td class="muted">${esc(m.sent_at)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No replies yet. Replies are checked every 5 minutes.</p>'}</div>
  <div class="card"><h2>Inboxes today</h2>${inboxes.length ? `<table><tr><th>Inbox</th><th>Sent today</th><th>Status</th></tr>
    ${inboxes.map(i => `<tr><td>${esc(i.email)}</td><td>${engine.sentToday(i.id)} / ${engine.effectiveLimit(i)}</td>
    <td>${!i.active ? '<span class="muted">paused</span>' : i.last_error ? `<span class="err">${esc(i.last_error)}</span>` : 'OK'}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}</div>`, '/');
});

// ---------- Leads ----------

app.get('/leads', (req, res) => {
  const { q = '', status = '', tag = '' } = req.query;
  const pageNo = Math.max(1, int(req.query.page, 1));
  const where = [], args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (tag) { where.push("(',' || REPLACE(LOWER(tags), ' ', '') || ',') LIKE ?"); args.push(`%,${tag.toLowerCase().replace(/\s/g, '')},%`); }
  if (q) { where.push("(first_name || ' ' || last_name || ' ' || email || ' ' || address || ' ' || city || ' ' || zip) LIKE ?"); args.push(`%${q}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const count = db.prepare(`SELECT COUNT(*) n FROM leads ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM leads ${w} ORDER BY COALESCE(replied_at, created_at) DESC LIMIT 100 OFFSET ?`).all(...args, (pageNo - 1) * 100);
  const qs = p => `/leads?${new URLSearchParams({ q, status, tag, page: p })}`;
  page(req, res, 'Leads', `<h1>Leads <span class="muted">(${count})</span></h1>
  <div class="card"><form class="row" method="get">
    <div><label>Search</label><input name="q" value="${esc(q)}" placeholder="name, email, address, zip"></div>
    <div><label>Status</label><select name="status"><option value="">All</option>${options(STATUSES, status)}</select></div>
    <div><label>Tag</label><input name="tag" value="${esc(tag)}" placeholder="e.g. absentee"></div>
    <div><label>&nbsp;</label><button>Filter</button></div></form></div>
  <div class="card"><table><tr><th>Name</th><th>Email</th><th>Property</th><th>Status</th><th>Tags</th><th>Last contacted</th></tr>
  ${rows.map(l => `<tr><td><a href="/leads/${l.id}">${esc(l.first_name)} ${esc(l.last_name)}</a></td>
    <td>${esc(l.email)}${l.unsubscribed ? ' <span class="pill">unsubscribed</span>' : ''}${l.bounced ? ' <span class="pill err">bounced</span>' : ''}</td>
    <td>${esc([l.address, l.city, l.state].filter(Boolean).join(', '))}</td><td><span class="pill">${statusLabel(l.status)}</span></td>
    <td class="muted">${esc(l.tags)}</td><td class="muted">${esc(l.last_contacted_at || '-')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No leads found.</td></tr>'}
  </table><div class="actions">${pageNo > 1 ? `<a class="btn btn2" href="${qs(pageNo - 1)}">Previous</a>` : ''}
  ${pageNo * 100 < count ? `<a class="btn btn2" href="${qs(pageNo + 1)}">Next</a>` : ''}</div></div>
  <div class="card"><h2>Add a lead</h2>${leadForm({}, '/leads/new')}</div>`, '/leads');
});

function leadForm(l, action) {
  const f = (k, label, type = 'text') => `<div><label>${label}</label><input type="${type}" name="${k}" value="${esc(l[k] || '')}"></div>`;
  return `<form method="post" action="${action}"><div class="row">${f('first_name', 'First name')}${f('last_name', 'Last name')}${f('email', 'Email', 'email')}${f('phone', 'Phone')}</div>
  <div class="row">${f('address', 'Property address')}${f('city', 'City')}${f('state', 'State')}${f('zip', 'ZIP')}</div>
  <div class="row"><div><label>Lead type</label><select name="lead_type">${options([['seller', 'Seller'], ['buyer', 'Cash buyer'], ['agent', 'Agent'], ['other', 'Other']], l.lead_type || 'seller')}</select></div>
  <div><label>Status</label><select name="status">${options(STATUSES, l.status || 'new')}</select></div>${f('tags', 'Tags (comma separated)')}${f('source', 'Source')}</div>
  <label>Notes</label><textarea name="notes" style="min-height:80px">${esc(l.notes || '')}</textarea>
  <div class="actions"><button>Save</button></div></form>`;
}

const LEAD_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'lead_type', 'status', 'tags', 'notes', 'source'];

app.post('/leads/new', (req, res) => {
  const v = LEAD_FIELDS.map(k => String(req.body[k] || '').trim());
  v[2] = v[2].toLowerCase();
  if (!EMAIL_RE.test(v[2])) return back(res, '/leads', 'That email address does not look valid.');
  try {
    const r = db.prepare(`INSERT INTO leads(${LEAD_FIELDS}) VALUES(${LEAD_FIELDS.map(() => '?')})`).run(...v);
    res.redirect('/leads/' + r.lastInsertRowid);
  } catch { back(res, '/leads', 'A lead with that email already exists.'); }
});

app.get('/leads/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(int(req.params.id));
  if (!l) return res.status(404).send('Not found');
  const msgs = db.prepare('SELECT m.*, i.email AS inbox FROM messages m LEFT JOIN inboxes i ON i.id = m.inbox_id WHERE lead_id = ? ORDER BY sent_at').all(l.id);
  const enr = db.prepare('SELECT e.*, c.name FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE lead_id = ?').all(l.id);
  page(req, res, 'Lead', `<h1>${esc(l.first_name)} ${esc(l.last_name)} <span class="pill">${statusLabel(l.status)}</span></h1>
  <p class="muted">${esc(l.email)} ${l.unsubscribed ? '- <b class="warn">unsubscribed</b>' : ''} ${l.bounced ? '- <b class="err">bounced</b>' : ''}</p>
  <div class="card"><h2>What we know</h2>${(() => { const f = replies.leadFacts(l); return `<table>${replies.FACT_KEYS.map(k =>
    `<tr><td style="width:180px">${replies.FACTS[k].label}</td><td>${f[k] ? esc(f[k]) : '<span class="warn">missing</span>'}</td></tr>`).join('')}</table>`; })()}
    ${l.offer_due_at ? `<p>Offer promised by <b>${esc(l.offer_due_at)}</b>.</p>` : ''}</div>
  <div class="card"><h2>Conversation</h2>${msgs.map(m => `<div class="msg ${m.direction}"><div class="muted">${m.direction === 'in' ? 'They replied' : 'You sent'} - ${esc(m.sent_at)}${m.inbox ? ' - ' + esc(m.inbox) : ''}</div>
    <b>${esc(m.subject)}</b><pre>${esc(m.body)}</pre></div>`).join('') || '<p class="muted">No emails yet.</p>'}
    <p class="muted">To reply, answer from your normal email app - it lands in the same thread.</p></div>
  <div class="card"><h2>Campaigns</h2>${enr.map(e => `<div><a href="/campaigns/${e.campaign_id}">${esc(e.name)}</a> - ${esc(e.status)}, next step ${e.next_step + 1}</div>`).join('') || '<p class="muted">Not in any campaign.</p>'}</div>
  <div class="card"><h2>Edit</h2>${leadForm(l, '/leads/' + l.id)}
  <div class="actions">
    <form method="post" action="/leads/${l.id}/unsub" class="inline"><button class="btn2">${l.unsubscribed ? 'Allow emails again' : 'Mark do-not-email'}</button></form>
    <form method="post" action="/leads/${l.id}/delete" class="inline" onsubmit="return confirm('Delete this lead?')"><button class="danger">Delete lead</button></form></div></div>`, '/leads');
});

app.post('/leads/:id', (req, res) => {
  const id = int(req.params.id);
  const v = LEAD_FIELDS.map(k => String(req.body[k] || '').trim());
  v[2] = v[2].toLowerCase();
  if (!EMAIL_RE.test(v[2])) return back(res, '/leads/' + id, 'That email address does not look valid.');
  try {
    db.prepare(`UPDATE leads SET ${LEAD_FIELDS.map(k => k + ' = ?')} WHERE id = ?`).run(...v, id);
    // Moving a lead forward in the pipeline by hand stops their automated follow-ups.
    if (!['new', 'contacted'].includes(v[9])) db.prepare("UPDATE enrollments SET status = 'stopped' WHERE lead_id = ? AND status = 'active'").run(id);
    back(res, '/leads/' + id, 'Saved.');
  } catch { back(res, '/leads/' + id, 'Another lead already has that email.'); }
});

app.post('/leads/:id/unsub', (req, res) => {
  const id = int(req.params.id);
  db.prepare('UPDATE leads SET unsubscribed = 1 - unsubscribed WHERE id = ?').run(id);
  db.prepare("UPDATE enrollments SET status = 'unsubscribed' WHERE lead_id = ? AND status = 'active' AND (SELECT unsubscribed FROM leads WHERE id = ?) = 1").run(id, id);
  back(res, '/leads/' + id, 'Updated.');
});
app.post('/leads/:id/delete', (req, res) => { db.prepare('DELETE FROM leads WHERE id = ?').run(int(req.params.id)); back(res, '/leads', 'Lead deleted.'); });

// ---------- CSV import ----------

app.get('/import', (req, res) => page(req, res, 'Import', `<h1>Import leads</h1>
  <div class="card"><p>Upload a CSV from your skip-tracing or list service (PropStream, DealMachine, BatchLeads, REISift, county lists, etc.).
  Columns are matched automatically - anything with <b>email</b>, <b>first name</b>, <b>last name</b>, <b>property address</b>, <b>city</b>, <b>state</b>, <b>zip</b>, <b>phone</b>.
  If a row has several emails (Email 1, Email 2...), the first valid one is used. Duplicates are skipped.</p>
  <form method="post" action="/import" id="f">
    <label>CSV file</label><input type="file" accept=".csv,text/csv" id="file" required>
    <textarea name="csv" id="csv" hidden></textarea>
    <div class="row"><div><label>Add tags to every lead (e.g. "absentee, tampa, oct-list")</label><input name="tags"></div>
    <div><label>Lead type</label><select name="lead_type">${options([['seller', 'Seller'], ['buyer', 'Cash buyer'], ['agent', 'Agent'], ['other', 'Other']], 'seller')}</select></div>
    <div><label>Source</label><input name="source" placeholder="e.g. PropStream"></div></div>
    <div class="actions"><button>Import</button></div></form></div>
  <script>document.getElementById('f').onsubmit=function(e){var f=document.getElementById('file').files[0];if(!f)return;
  if(document.getElementById('csv').value)return;e.preventDefault();var r=new FileReader();
  r.onload=function(){document.getElementById('csv').value=r.result;document.getElementById('f').submit();};r.readAsText(f);};</script>`, '/import'));

function mapRow(row) {
  const keys = Object.keys(row);
  const norm = k => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (...names) => { for (const n of names) { const k = keys.find(k => norm(k) === n); if (k && String(row[k]).trim()) return String(row[k]).trim(); } return ''; };
  const findIncl = (part, not) => { for (const k of keys) { const n = norm(k); if (n.includes(part) && !(not && not.test(n)) && String(row[k]).trim()) return String(row[k]).trim(); } return ''; };
  let email = '';
  for (const k of keys) if (/email/.test(norm(k))) { const v = String(row[k]).trim().toLowerCase(); if (EMAIL_RE.test(v)) { email = v; break; } }
  let first = find('firstname', 'ownerfirstname', 'owner1firstname', 'first', 'fname');
  let last = find('lastname', 'ownerlastname', 'owner1lastname', 'last', 'lname');
  if (!first && !last) {
    const full = find('name', 'fullname', 'ownername', 'owner1name', 'owner', 'contactname');
    if (full) { const p = full.split(/\s+/); first = p[0]; last = p.slice(1).join(' '); }
  }
  return {
    email, first_name: first, last_name: last,
    phone: findIncl('phone') || findIncl('mobile') || findIncl('cell'),
    address: find('propertyaddress', 'propertystreet', 'propertystreetaddress', 'address', 'streetaddress', 'street', 'siteaddress', 'situsaddress'),
    city: find('propertycity', 'city', 'sitecity', 'situscity'),
    state: find('propertystate', 'state', 'sitestate', 'situsstate', 'st'),
    zip: find('propertyzip', 'propertyzipcode', 'zip', 'zipcode', 'postalcode', 'sitezip', 'situszip'),
  };
}

app.post('/import', (req, res) => {
  let rows;
  try { rows = parse(String(req.body.csv || '').replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true }); }
  catch (e) { return back(res, '/import', 'Could not read that CSV: ' + e.message); }
  const tags = splitTags(req.body.tags).join(', ');
  const ins = db.prepare(`INSERT OR IGNORE INTO leads(first_name, last_name, email, phone, address, city, state, zip, lead_type, tags, source)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0, noEmail = 0, dupes = 0;
  db.exec('BEGIN');
  for (const row of rows) {
    const m = mapRow(row);
    if (!m.email) { noEmail++; continue; }
    const r = ins.run(m.first_name, m.last_name, m.email, m.phone, m.address, m.city, m.state, m.zip, req.body.lead_type || 'seller', tags, req.body.source || 'csv import');
    r.changes ? added++ : dupes++;
  }
  db.exec('COMMIT');
  back(res, '/leads' + (tags ? '?tag=' + encodeURIComponent(splitTags(tags)[0]) : ''),
    `Imported ${added} leads. Skipped ${dupes} duplicates and ${noEmail} rows with no valid email.`);
});

// ---------- Inboxes ----------

app.get('/inboxes', (req, res) => {
  const rows = db.prepare('SELECT * FROM inboxes ORDER BY id').all();
  page(req, res, 'Inboxes', `<h1>Sending inboxes</h1>
  <div class="card"><p>Each inbox sends a limited number of emails per day. More inboxes = more reach. New inboxes "warm up": they start at 10/day and
  add 2/day until they hit your limit, which keeps them out of spam. Recommended max for cold email: <b>30-50 per inbox per day</b>.</p>
  <table><tr><th>Email</th><th>Provider</th><th>Today</th><th>Daily limit</th><th>Status</th><th></th></tr>
  ${rows.map(i => `<tr><td>${esc(i.email)}<br><span class="muted">${esc(i.from_name)}</span></td><td>${esc(PROVIDERS[i.provider]?.label || i.provider)}</td>
    <td>${engine.sentToday(i.id)} / ${engine.effectiveLimit(i)}</td><td>${i.daily_limit}${i.warmup ? ' <span class="pill">warm-up</span>' : ''}</td>
    <td>${!i.active ? 'paused' : i.last_error ? `<span class="err">${esc(i.last_error)}</span>` : 'OK'}</td>
    <td><div class="actions" style="margin:0">
      <form method="post" action="/inboxes/${i.id}/test" class="inline"><button class="btn2">Send test to myself</button></form>
      <form method="post" action="/inboxes/${i.id}/toggle" class="inline"><button class="btn2">${i.active ? 'Pause' : 'Resume'}</button></form>
      <form method="post" action="/inboxes/${i.id}/delete" class="inline" onsubmit="return confirm('Remove this inbox?')"><button class="danger">Remove</button></form></div></td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">No inboxes connected yet.</td></tr>'}</table></div>
  <div class="card"><h2>Connect an inbox</h2>
  <form method="post" action="/inboxes">
  <div class="row"><div><label>Provider</label><select name="provider" id="prov">${options(Object.entries(PROVIDERS).map(([k, p]) => [k, p.label]), 'gmail')}</select></div>
  <div><label>Email address</label><input type="email" name="email" required></div>
  <div><label>App password (not your normal password)</label><input type="password" name="password" required></div>
  <div><label>Display name (e.g. "Marlon | Local Home Buyer")</label><input name="from_name"></div></div>
  <p class="muted" id="help"></p>
  <div class="row" id="custom"><div><label>SMTP host</label><input name="smtp_host"></div><div><label>SMTP port</label><input name="smtp_port" value="587"></div>
  <div><label>IMAP host (for reply tracking)</label><input name="imap_host"></div><div><label>IMAP port</label><input name="imap_port" value="993"></div></div>
  <div class="row"><div><label>Daily limit</label><input type="number" name="daily_limit" value="40" min="1" max="500"></div>
  <div><label>Warm-up</label><select name="warmup">${options([['1', 'On (recommended for new inboxes)'], ['0', 'Off']], '1')}</select></div></div>
  <div class="actions"><button>Verify &amp; connect</button></div></form></div>
  <script>var H=${JSON.stringify(Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.help])))};
  function u(){var v=document.getElementById('prov').value;document.getElementById('help').textContent=H[v];document.getElementById('custom').style.display=v==='custom'?'':'none';}
  document.getElementById('prov').onchange=u;u();</script>`, '/inboxes');
});

app.post('/inboxes', async (req, res) => {
  const b = req.body, p = PROVIDERS[b.provider] || PROVIDERS.custom;
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return back(res, '/inboxes', 'Enter a valid email.');
  const inbox = {
    provider: b.provider, email, from_name: String(b.from_name || '').trim(),
    smtp_host: b.provider === 'custom' ? String(b.smtp_host || '').trim() : p.smtp_host,
    smtp_port: b.provider === 'custom' ? int(b.smtp_port, 587) : p.smtp_port,
    smtp_secure: b.provider === 'custom' ? (int(b.smtp_port) === 465 ? 1 : 0) : p.smtp_secure,
    imap_host: b.provider === 'custom' ? String(b.imap_host || '').trim() : p.imap_host,
    imap_port: b.provider === 'custom' ? int(b.imap_port, 993) : p.imap_port,
    password_enc: encrypt(String(b.password || '').replace(/\s/g, '')),
    daily_limit: Math.min(500, Math.max(1, int(b.daily_limit, 40))), warmup: b.warmup === '0' ? 0 : 1,
  };
  if (process.env.DRY_RUN !== '1') {
    try { await engine.transportFor(inbox).verify(); }
    catch (e) { return back(res, '/inboxes', `Could not log in to ${email}: ${e.message}. Double-check the app password.`); }
  }
  const k = Object.keys(inbox);
  db.prepare(`INSERT INTO inboxes(${k}) VALUES(${k.map(() => '?')})`).run(...Object.values(inbox));
  back(res, '/inboxes', `Connected ${email}.`);
});

app.post('/inboxes/:id/test', async (req, res) => {
  const inbox = db.prepare('SELECT * FROM inboxes WHERE id = ?').get(int(req.params.id));
  if (!inbox) return back(res, '/inboxes', 'Not found.');
  try {
    await engine.transportFor(inbox).sendMail({ from: inbox.email, to: inbox.email, subject: 'Lead CRM test', text: 'Your inbox is connected and can send email.' });
    db.prepare("UPDATE inboxes SET last_error = '' WHERE id = ?").run(inbox.id);
    back(res, '/inboxes', `Test email sent to ${inbox.email}.`);
  } catch (e) { back(res, '/inboxes', 'Test failed: ' + e.message); }
});
app.post('/inboxes/:id/toggle', (req, res) => { db.prepare('UPDATE inboxes SET active = 1 - active WHERE id = ?').run(int(req.params.id)); back(res, '/inboxes'); });
app.post('/inboxes/:id/delete', (req, res) => { db.prepare('DELETE FROM inboxes WHERE id = ?').run(int(req.params.id)); back(res, '/inboxes', 'Inbox removed.'); });

// ---------- Templates ----------

const MERGE_HELP = `<p class="muted">Merge fields: <code>{{first_name}}</code> <code>{{last_name}}</code> <code>{{address}}</code> <code>{{city}}</code> <code>{{state}}</code> <code>{{zip}}</code>
  <code>{{my_name}}</code> <code>{{my_phone}}</code> <code>{{my_company}}</code>. Add a fallback with a bar: <code>{{first_name|there}}</code>.<br>
  Vary wording so every email is a little different (helps avoid spam filters): <code>{Hi|Hey|Hello}</code> picks one at random.<br>
  <b>Never</b> mention wholesaling or assignment - emails with that wording are blocked.<br>
  Leave the subject <b>blank</b> on follow-ups to reply in the same thread ("Re: ..."). An unsubscribe line + your mailing address are added automatically.</p>`;

app.get('/templates', (req, res) => {
  const rows = db.prepare('SELECT * FROM templates ORDER BY id').all();
  page(req, res, 'Templates', `<h1>Email templates</h1>
  <div class="card"><table><tr><th>Name</th><th>Subject</th><th></th></tr>
  ${rows.map(t => `<tr><td><a href="/templates/${t.id}">${esc(t.name)}</a></td><td>${esc(t.subject) || '<span class="muted">(reply in thread)</span>'}</td>
  <td><a href="/templates/${t.id}">Edit</a></td></tr>`).join('')}</table></div>
  <div class="card"><h2>New template</h2>${templateForm({}, '/templates/new')}</div>`, '/templates');
});

function templateForm(t, action) {
  return `<form method="post" action="${action}"><label>Name</label><input name="name" value="${esc(t.name || '')}" required>
  <label>Subject</label><input name="subject" value="${esc(t.subject || '')}">
  <label>Body</label><textarea name="body" style="min-height:240px">${esc(t.body || '')}</textarea>${MERGE_HELP}
  <div class="actions"><button>Save</button></div></form>`;
}

const bannedMsg = w => `Not saved: sellers must never see "${w.join('", "')}". We present as a real estate buyer - no wholesale or assignment wording in emails.`;

app.post('/templates/new', (req, res) => {
  const w = bannedWords((req.body.subject || '') + ' ' + (req.body.body || ''));
  if (w.length) return back(res, '/templates', bannedMsg(w));
  const r = db.prepare('INSERT INTO templates(name, subject, body) VALUES(?, ?, ?)').run(req.body.name || 'Untitled', req.body.subject || '', req.body.body || '');
  res.redirect('/templates/' + r.lastInsertRowid);
});

app.get('/templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(int(req.params.id));
  if (!t) return res.status(404).send('Not found');
  const sample = db.prepare('SELECT * FROM leads ORDER BY RANDOM() LIMIT 1').get()
    || { id: 0, first_name: 'Jane', last_name: 'Doe', address: '123 Main St', city: 'Tampa', state: 'FL', zip: '33601' };
  const vars = engine.leadVars(sample);
  page(req, res, 'Template', `<h1>${esc(t.name)}</h1><div class="card">${templateForm(t, '/templates/' + t.id)}
  <form method="post" action="/templates/${t.id}/delete" onsubmit="return confirm('Delete template?')"><div class="actions"><button class="danger">Delete</button></div></form></div>
  <div class="card"><h2>Preview <span class="muted">(using ${esc(sample.first_name)} ${esc(sample.last_name)} - refresh for another variation)</span></h2>
  <b>${esc(render(t.subject, vars) || 'Re: (previous subject)')}</b><pre>${esc(render(t.body, vars))}</pre></div>`, '/templates');
});

app.post('/templates/:id', (req, res) => {
  const w = bannedWords((req.body.subject || '') + ' ' + (req.body.body || ''));
  if (w.length) return back(res, '/templates/' + req.params.id, bannedMsg(w));
  db.prepare('UPDATE templates SET name = ?, subject = ?, body = ? WHERE id = ?').run(req.body.name, req.body.subject || '', req.body.body || '', int(req.params.id));
  back(res, '/templates/' + req.params.id, 'Saved.');
});
app.post('/templates/:id/delete', (req, res) => {
  const id = int(req.params.id);
  if (db.prepare('SELECT 1 FROM campaign_steps WHERE template_id = ?').get(id)) return back(res, '/templates/' + id, 'This template is used by a campaign.');
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  back(res, '/templates', 'Deleted.');
});

// ---------- Campaigns ----------

function matchingLeads(c) {
  const tags = splitTags(c.target_tags);
  return db.prepare(`SELECT id, tags FROM leads WHERE unsubscribed = 0 AND bounced = 0 AND (? = '' OR status = ?)
    AND id NOT IN (SELECT lead_id FROM enrollments WHERE campaign_id = ?)`).all(c.target_status, c.target_status, c.id)
    .filter(l => !tags.length || splitTags(l.tags).some(t => tags.includes(t)));
}

function enroll(c) {
  const leads = matchingLeads(c);
  const ins = db.prepare('INSERT OR IGNORE INTO enrollments(campaign_id, lead_id) VALUES(?, ?)');
  db.exec('BEGIN'); for (const l of leads) ins.run(c.id, l.id); db.exec('COMMIT');
  return leads.length;
}

app.get('/campaigns', (req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE campaign_id = c.id) AS enrolled,
    (SELECT COUNT(*) FROM enrollments WHERE campaign_id = c.id AND status = 'replied') AS replied,
    (SELECT COUNT(*) FROM messages WHERE campaign_id = c.id AND direction = 'out') AS sent FROM campaigns c ORDER BY id DESC`).all();
  page(req, res, 'Campaigns', `<h1>Campaigns</h1>
  <div class="card"><table><tr><th>Name</th><th>Status</th><th>Leads</th><th>Emails sent</th><th>Replied</th></tr>
  ${rows.map(c => `<tr><td><a href="/campaigns/${c.id}">${esc(c.name)}</a></td><td><span class="pill">${c.status}</span></td>
  <td>${c.enrolled}</td><td>${c.sent}</td><td>${c.replied}${c.enrolled ? ` <span class="muted">(${((c.replied / c.enrolled) * 100).toFixed(1)}%)</span>` : ''}</td></tr>`).join('')
  || '<tr><td colspan="5" class="muted">No campaigns yet.</td></tr>'}</table></div>
  <div class="card"><h2>New campaign</h2>${campaignForm({ window_start: 9, window_end: 18, weekdays_only: 1, target_status: 'new' }, [], '/campaigns/new')}</div>`, '/campaigns');
});

function campaignForm(c, steps, action) {
  const templates = db.prepare('SELECT id, name FROM templates ORDER BY id').all().map(t => [t.id, t.name]);
  const inboxes = db.prepare('SELECT * FROM inboxes ORDER BY id').all();
  const chosen = String(c.inbox_ids || '').split(',');
  const defaults = [[1, 0], [2, 3], [3, 7]];
  const stepRows = [0, 1, 2, 3, 4].map(i => {
    const s = steps[i] || (c.id ? {} : { template_id: defaults[i]?.[0], delay_days: defaults[i]?.[1] });
    return `<div class="row"><div><label>Step ${i + 1} template</label><select name="tpl${i}"><option value="">- none -</option>${options(templates, s.template_id ?? '')}</select></div>
    <div><label>${i === 0 ? 'Send' : 'Days after previous step'}</label>${i === 0 ? '<input value="Right away (within sending hours)" disabled>' : `<input type="number" min="1" name="delay${i}" value="${s.delay_days ?? 3}">`}</div></div>`;
  }).join('');
  return `<form method="post" action="${action}">
  <div class="row"><div><label>Campaign name</label><input name="name" value="${esc(c.name || '')}" required placeholder="e.g. Tampa absentee owners - Nov"></div>
  <div><label>Only leads with any of these tags (blank = all)</label><input name="target_tags" value="${esc(c.target_tags || '')}" placeholder="absentee, tampa"></div>
  <div><label>Only leads with status</label><select name="target_status"><option value="">Any</option>${options(STATUSES, c.target_status)}</select></div></div>
  <label>Send from these inboxes (rotates between them)</label>
  <div>${inboxes.map(i => `<label style="display:inline-flex;gap:6px;margin-right:16px;color:inherit"><input type="checkbox" style="width:auto" name="inbox" value="${i.id}" ${chosen.includes(String(i.id)) || !c.id ? 'checked' : ''}>${esc(i.email)}</label>`).join('')
    || '<span class="warn">Connect an inbox first.</span>'}</div>
  <div class="row"><div><label>Send between (hour, 0-23)</label><input type="number" name="window_start" min="0" max="23" value="${c.window_start}"></div>
  <div><label>and (hour)</label><input type="number" name="window_end" min="1" max="24" value="${c.window_end}"></div>
  <div><label>Days</label><select name="weekdays_only">${options([['1', 'Weekdays only'], ['0', 'Every day']], String(c.weekdays_only))}</select></div></div>
  <h2 style="margin-top:16px">Sequence</h2><p class="muted">Follow-ups stop automatically when the lead replies, unsubscribes or bounces.</p>${stepRows}
  <div class="actions"><button>Save campaign</button></div></form>`;
}

function saveCampaign(id, b) {
  const inboxIds = [].concat(b.inbox || []).map(Number).filter(Boolean).join(',');
  const vals = [b.name || 'Untitled', b.target_tags || '', b.target_status || '', inboxIds,
    Math.min(23, Math.max(0, int(b.window_start, 9))), Math.min(24, Math.max(1, int(b.window_end, 18))), b.weekdays_only === '0' ? 0 : 1];
  if (id) db.prepare('UPDATE campaigns SET name=?, target_tags=?, target_status=?, inbox_ids=?, window_start=?, window_end=?, weekdays_only=? WHERE id=?').run(...vals, id);
  else id = db.prepare('INSERT INTO campaigns(name, target_tags, target_status, inbox_ids, window_start, window_end, weekdays_only) VALUES(?,?,?,?,?,?,?)').run(...vals).lastInsertRowid;
  db.prepare('DELETE FROM campaign_steps WHERE campaign_id = ?').run(id);
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const t = int(b['tpl' + i]);
    if (t) db.prepare('INSERT INTO campaign_steps(campaign_id, step_no, template_id, delay_days) VALUES(?,?,?,?)').run(id, n++, t, i === 0 ? 0 : Math.max(1, int(b['delay' + i], 3)));
  }
  return id;
}

app.post('/campaigns/new', (req, res) => res.redirect('/campaigns/' + saveCampaign(null, req.body)));
app.post('/campaigns/:id', (req, res) => { saveCampaign(int(req.params.id), req.body); back(res, '/campaigns/' + req.params.id, 'Saved.'); });

app.get('/campaigns/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(int(req.params.id));
  if (!c) return res.status(404).send('Not found');
  const steps = db.prepare('SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY step_no').all(c.id);
  const st = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY status').all(c.id).map(r => [r.status, r.n]));
  const sent = db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id = ? AND direction = 'out'").get(c.id).n;
  const pending = matchingLeads(c).length;
  const enrolled = Object.values(st).reduce((a, b) => a + b, 0);
  const inboxIds = c.inbox_ids.split(',').map(Number).filter(Boolean);
  const perDay = db.prepare(`SELECT * FROM inboxes WHERE active = 1 AND id IN (${inboxIds.join(',') || 0})`).all().reduce((s, i) => s + engine.effectiveLimit(i), 0);
  const replies = db.prepare(`SELECT l.id, l.first_name, l.last_name, l.address, l.status FROM enrollments e JOIN leads l ON l.id = e.lead_id
    WHERE e.campaign_id = ? AND e.status = 'replied' ORDER BY l.replied_at DESC LIMIT 50`).all(c.id);
  page(req, res, 'Campaign', `<h1>${esc(c.name)} <span class="pill">${c.status}</span></h1>
  <div class="grid">
    <div class="stat"><div>${enrolled}</div><span>Leads in campaign</span></div>
    <div class="stat"><div>${st.active || 0}</div><span>Still in sequence</span></div>
    <div class="stat"><div>${sent}</div><span>Emails sent</span></div>
    <div class="stat"><div>${st.replied || 0}</div><span>Replied${enrolled ? ` (${(((st.replied || 0) / enrolled) * 100).toFixed(1)}%)` : ''}</span></div>
    <div class="stat"><div>${(st.unsubscribed || 0) + (st.bounced || 0)}</div><span>Unsubscribed / bounced</span></div>
    <div class="stat"><div>${perDay}/day</div><span>Sending capacity of its inboxes</span></div>
  </div>
  <div class="card"><div class="actions" style="margin:0">
    ${c.status === 'active' ? `<form method="post" action="/campaigns/${c.id}/pause" class="inline"><button class="btn2">Pause</button></form>`
      : `<form method="post" action="/campaigns/${c.id}/start" class="inline"><button>Start sending</button></form>`}
    <form method="post" action="/campaigns/${c.id}/enroll" class="inline"><button class="btn2">Add ${pending} new matching leads</button></form>
    <form method="post" action="/campaigns/${c.id}/delete" class="inline" onsubmit="return confirm('Delete campaign?')"><button class="danger">Delete</button></form></div>
    <p class="muted">Starting a campaign adds all matching leads. Emails go out slowly (a few minutes apart, within sending hours) so your inboxes stay healthy.
    ${steps.length} step(s): ${steps.map((s, i) => i === 0 ? 'day 0' : `+${s.delay_days}d`).join(', ') || 'none'}.</p></div>
  <div class="card"><h2>Replies</h2>${replies.map(r => `<div><a href="/leads/${r.id}">${esc(r.first_name)} ${esc(r.last_name)}</a> - ${esc(r.address)} <span class="pill">${statusLabel(r.status)}</span></div>`).join('') || '<p class="muted">None yet.</p>'}</div>
  <div class="card"><h2>Settings</h2>${campaignForm(c, steps, '/campaigns/' + c.id)}</div>`, '/campaigns');
});

app.post('/campaigns/:id/start', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(int(req.params.id));
  if (!c) return back(res, '/campaigns', 'Not found.');
  if (!getSetting('business_name') || !getSetting('mailing_address'))
    return back(res, '/settings', 'Add your business name and mailing address before sending (required by CAN-SPAM).');
  if (!c.inbox_ids) return back(res, '/campaigns/' + c.id, 'Choose at least one inbox.');
  if (!db.prepare('SELECT 1 FROM campaign_steps WHERE campaign_id = ?').get(c.id)) return back(res, '/campaigns/' + c.id, 'Add at least one step.');
  const n = enroll(c);
  db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(c.id);
  back(res, '/campaigns/' + c.id, `Campaign started. ${n} leads added.`);
});
app.post('/campaigns/:id/pause', (req, res) => { db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(int(req.params.id)); back(res, '/campaigns/' + req.params.id, 'Paused.'); });
app.post('/campaigns/:id/enroll', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(int(req.params.id));
  back(res, '/campaigns/' + c.id, `${enroll(c)} leads added.`);
});
app.post('/campaigns/:id/delete', (req, res) => { db.prepare('DELETE FROM campaigns WHERE id = ?').run(int(req.params.id)); back(res, '/campaigns', 'Deleted.'); });

// ---------- Approvals: replies that need the owner's OK ----------

app.get('/approvals', (req, res) => {
  const rows = db.prepare(`SELECT d.*, l.first_name, l.last_name, l.email, l.address, l.facts, i.email AS inbox_email FROM drafts d
    JOIN leads l ON l.id = d.lead_id LEFT JOIN inboxes i ON i.id = d.inbox_id WHERE d.status = 'pending' ORDER BY d.created_at`).all();
  page(req, res, 'Approvals', `<h1>Needs your OK <span class="muted">(${rows.length})</span></h1>
  <p class="muted">These sellers asked questions or said something that needs a human. Nothing here sends until you click <b>Approve &amp; send</b>.
  Routine emails (asking for missing info, and "thank you, your offer is coming") send on their own.</p>
  ${rows.map(d => {
    const last = db.prepare("SELECT body, sent_at FROM messages WHERE lead_id = ? AND direction = 'in' ORDER BY sent_at DESC LIMIT 1").get(d.lead_id);
    return `<div class="card"><h2><a href="/leads/${d.lead_id}">${esc(d.first_name)} ${esc(d.last_name)}</a> <span class="muted">- ${esc(d.address)}</span></h2>
    <p class="warn">${esc(d.reason)}</p>
    <div class="msg in"><div class="muted">They wrote${last ? ' - ' + esc(last.sent_at) : ''}</div><pre>${esc(last?.body || '')}</pre></div>
    <form method="post" action="/approvals/${d.id}/send">
      <label>Subject</label><input name="subject" value="${esc(d.subject)}">
      <label>Your reply (edit anything; fill in any [BRACKETS])</label><textarea name="body" style="min-height:220px">${esc(d.body)}</textarea>
      <p class="muted">Sends from ${esc(d.inbox_email || 'your inbox')} in the same email thread.</p>
      <div class="actions"><button>Approve &amp; send</button>
      <button formaction="/approvals/${d.id}/discard" class="btn2">Discard (I'll handle it myself)</button></div></form></div>`;
  }).join('') || '<div class="card"><p class="muted">Nothing waiting. You\'re all caught up.</p></div>'}`, '/approvals');
});

app.post('/approvals/:id/send', async (req, res) => {
  const d = db.prepare("SELECT * FROM drafts WHERE id = ? AND status = 'pending'").get(int(req.params.id));
  if (!d) return back(res, '/approvals', 'That draft was already handled.');
  const subject = String(req.body.subject || d.subject).trim(), body = String(req.body.body || '').trim();
  if (/\[[A-Z][A-Z ]+\]/.test(body)) return back(res, '/approvals', 'Fill in or delete the [BRACKETED] parts before sending.');
  const w = bannedWords(subject + ' ' + body);
  if (w.length) return back(res, '/approvals', bannedMsg(w));
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(d.lead_id);
  const inbox = db.prepare('SELECT * FROM inboxes WHERE id = ?').get(d.inbox_id)
    || db.prepare('SELECT * FROM inboxes WHERE active = 1 ORDER BY id LIMIT 1').get();
  if (!lead || !inbox) return back(res, '/approvals', 'Lead or inbox no longer exists.');
  if (lead.unsubscribed) return back(res, '/approvals', 'This lead unsubscribed. Not sent.');
  try {
    const msgId = await engine.sendEmail({ inbox, lead, subject, body, inReplyTo: d.in_reply_to });
    db.prepare("INSERT INTO messages(lead_id, inbox_id, direction, subject, body, message_id) VALUES(?, ?, 'out', ?, ?, ?)").run(lead.id, inbox.id, subject, body, msgId);
    db.prepare("UPDATE drafts SET status = 'sent', subject = ?, body = ?, sent_at = datetime('now') WHERE id = ?").run(subject, body, d.id);
    back(res, '/approvals', `Sent to ${lead.email}.`);
  } catch (e) { back(res, '/approvals', 'Send failed: ' + e.message); }
});

app.post('/approvals/:id/discard', (req, res) => {
  db.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ?").run(int(req.params.id));
  back(res, '/approvals', 'Discarded. Nothing was sent.');
});

// ---------- Settings ----------

const SETTINGS = [
  ['business_name', 'Business name', 'e.g. Marlon Buys Houses LLC'],
  ['mailing_address', 'Mailing address (required by law in every marketing email - a PO box works)', '123 Main St, Tampa, FL 33601'],
  ['my_name', 'Your name (for {{my_name}})', ''],
  ['my_phone', 'Your phone (for {{my_phone}})', ''],
  ['min_gap_sec', 'Minimum seconds between emails from the same inbox', '120'],
  ['max_gap_sec', 'Maximum seconds between emails from the same inbox', '360'],
  ['offer_days', 'When a seller gives everything, promise an offer within this many days', '5'],
  ['auto_offer_ack', 'Auto-send the "thank you, offer coming" email? (1 = yes, 0 = ask me first)', '1'],
  ['auto_info_request', 'Auto-send one email asking for missing info? (1 = yes, 0 = ask me first)', '1'],
  ['sell_headline', 'Seller form headline', 'Sell your house fast, as-is, for cash'],
  ['sell_subtext', 'Seller form text', ''],
];

app.get('/settings', (req, res) => {
  const pub = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');
  page(req, res, 'Settings', `<h1>Settings</h1><div class="card"><form method="post" action="/settings">
  ${SETTINGS.map(([k, label, ph]) => `<label>${label}</label><input name="${k}" value="${esc(getSetting(k, ['min_gap_sec', 'max_gap_sec', 'offer_days', 'auto_offer_ack', 'auto_info_request'].includes(k) ? ph : ''))}" placeholder="${esc(ph)}">`).join('')}
  <div class="actions"><button>Save</button></div></form></div>
  <div class="card"><h2>Your seller lead form</h2><p>Share this link anywhere (Facebook, Instagram bio, Craigslist, flyers, a QR code on bandit signs).
  Every submission appears in Leads as <b>interested</b> with the tag <b>inbound</b>.</p>
  <p><a href="/sell" target="_blank">${esc(pub)}/sell</a></p></div>
  <div class="card"><h2>Export</h2><p><a href="/export.csv">Download all leads as CSV</a></p></div>`, '/settings');
});

app.post('/settings', (req, res) => {
  for (const [k] of SETTINGS) setSetting(k, String(req.body[k] || '').trim());
  back(res, '/settings', 'Saved.');
});

app.get('/export.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id').all();
  const cols = ['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'lead_type', 'status', 'tags', 'source', 'unsubscribed', 'bounced', 'last_contacted_at', 'replied_at', 'notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send([cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n'));
});

const PORT = int(process.env.PORT, 3000);
if (require.main === module) {
  if (!process.env.SECRET_KEY) console.warn('WARNING: SECRET_KEY is not set in .env - set one before connecting real inboxes.');
  app.listen(PORT, () => console.log(`Lead CRM running at http://localhost:${PORT}`));
  engine.start();
}
module.exports = app;
