// Run with: npm test   (uses a throwaway database and DRY_RUN, so no email is sent)
const os = require('os'), path = require('path'), fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
Object.assign(process.env, { DRY_RUN: '1', DB_PATH: path.join(dir, 't.db'), SECRET_KEY: 'test', APP_PASSWORD: 'pw', TZ: 'UTC' });

const test = require('node:test'), assert = require('node:assert/strict');
const { db, setSetting } = require('../src/db');
const { encrypt, sign } = require('../src/util');
const replies = require('../src/replies');
const app = require('../src/server');

setSetting('my_name', 'Marlon'); setSetting('business_name', 'Cypher Investments'); setSetting('my_phone', '555-0100');
db.prepare("INSERT INTO inboxes(provider, email, password_enc) VALUES('gmail', 'me@x.com', ?)").run(encrypt('p'));
const inbox = db.prepare('SELECT * FROM inboxes').get();
let n = 0;
function newLead() {
  const id = db.prepare("INSERT INTO leads(email, first_name, address, status) VALUES(?, 'Jane', '12 Oak St', 'contacted')").run(`l${++n}@x.com`).lastInsertRowid;
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
}
const reply = (lead, text, subject = 'Re: Question about 12 Oak St') =>
  replies.handleIncoming({ lead, inbox, subject, text, messageId: `<m${Math.random()}@x>` });
const lastOut = id => db.prepare("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(id);
const draft = id => db.prepare("SELECT * FROM drafts WHERE lead_id = ? AND status = 'pending'").get(id);
const get = id => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

test('seller gives everything -> auto thank-you with offer date, never a price', async () => {
  const l = newLead();
  const out = await reply(l, "Yes I'd sell. It was my mom's house, I inherited it. Nobody lives there, it's vacant. Needs a new roof and the kitchen is old. I want $150k and would like to be done in 30 days.");
  assert.equal(out, 'offer_ack_sent');
  assert.equal(get(l.id).status, 'offer_due');
  assert.ok(get(l.id).offer_due_at);
  assert.ok(![0, 6].includes(new Date(get(l.id).offer_due_at + 'T12:00:00').getDay()), 'offer date never on a weekend');
  const m = lastOut(l.id);
  assert.match(m.body, /everything I need on 12 Oak St/);
  assert.match(m.body, /you'll have it from me by /);
  assert.doesNotMatch(m.body, /\$\d/, 'auto email must never include a price');
  assert.match(m.subject, /^Re: /);
});

test('missing info -> one auto email asking only for what is missing, then owner sees the next one', async () => {
  const l = newLead();
  assert.equal(await reply(l, 'Maybe. It is vacant and needs work.'), 'info_request_sent');
  const m = lastOut(l.id);
  assert.match(m.body, /What price would you need/);
  assert.match(m.body, /How soon are you looking to sell/);
  assert.match(m.body, /What has you thinking about selling/);
  assert.doesNotMatch(m.body, /Is anyone living there/, 'already told us occupancy');
  assert.doesNotMatch(m.body, /What shape is it in/, 'already told us condition');
  assert.equal(await reply(get(l.id), 'Around 120k.'), 'needs_approval', 'never auto-loop a second time');
  assert.match(draft(l.id).reason, /Still missing/);
});

test('facts add up across replies', async () => {
  const l = newLead();
  await reply(l, 'It is vacant, needs a roof.');
  assert.equal(await reply(get(l.id), 'Moving out of state for a job. $140,000 and within 2 months works.'), 'offer_ack_sent');
});

test('seller asks a question -> drafted for owner approval, not sent', async () => {
  const l = newLead();
  const before = db.prepare('SELECT COUNT(*) c FROM messages WHERE direction = \'out\'').get().c;
  assert.equal(await reply(l, 'How did you get my info? And what would you offer?'), 'needs_approval');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM messages WHERE direction = \'out\'').get().c, before, 'nothing sent');
  const d = draft(l.id);
  assert.match(d.body, /public property records/);
  assert.match(d.body, /real number than a guess/);
});

test('agent / lawyer mentions always go to the owner', async () => {
  assert.equal(await reply(newLead(), "It's listed with a realtor right now."), 'needs_approval');
  assert.equal(await reply(newLead(), 'Talk to my attorney.'), 'needs_approval');
});

test('opt-outs and auto-replies', async () => {
  const l = newLead();
  assert.equal(await reply(l, 'Not interested, please remove me.'), 'opted_out');
  assert.equal(get(l.id).unsubscribed, 1);
  assert.equal(await reply(newLead(), 'I am out of the office until Monday.', 'Automatic reply: Question'), 'auto_reply_ignored');
});

test('quoted copy of our own email is ignored', () => {
  const c = replies.classify("Sounds good.\n\nOn Mon, Nov 24, 2026 at 9:00 AM Marlon <me@x.com> wrote:\n> Would you consider an offer?\n> What would need to happen?");
  assert.equal(c.question, false);
  assert.equal(c.reply, 'Sounds good.');
});

test('parses real MIME email (quoted-printable)', async () => {
  const raw = 'From: Jane <l1@x.com>\r\nTo: me@x.com\r\nSubject: Re: Hi\r\nMessage-ID: <abc@x>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nIt=E2=80=99s vacant and needs a =\r\nnew roof.\r\n';
  const p = await replies.parseEmail(Buffer.from(raw));
  assert.match(p.text, /It’s vacant and needs a new roof/);
});

test('approval page: brackets and banned words block sending; approve sends in thread', async () => {
  const l = newLead();
  await reply(l, 'Is this a scam?');
  const d = draft(l.id);
  const srv = app.listen(0); const port = srv.address().port;
  const post = (url, body) => fetch(`http://localhost:${port}${url}`, { method: 'POST', redirect: 'manual',
    headers: { cookie: 'auth=' + sign('admin:pw'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    .then(r => decodeURIComponent(r.headers.get('location') || ''));
  try {
    assert.match(await post(`/approvals/${d.id}/send`, { subject: d.subject, body: d.body }), /BRACKETED/);
    assert.match(await post(`/approvals/${d.id}/send`, { subject: d.subject, body: 'Hi, this is an assignable contract.' }), /must never see/);
    assert.match(await post(`/approvals/${d.id}/send`, { subject: d.subject, body: 'Hi Jane, not a scam. I am a local buyer.\n\nMarlon' }), /Sent to/);
    assert.equal(db.prepare('SELECT status FROM drafts WHERE id = ?').get(d.id).status, 'sent');
    assert.match(lastOut(l.id).body, /not a scam/);
    const html = await fetch(`http://localhost:${port}/`, { headers: { cookie: 'auth=' + sign('admin:pw') } }).then(r => r.text());
    assert.match(html, /Offers you owe/);
    const ap = await fetch(`http://localhost:${port}/approvals`, { headers: { cookie: 'auth=' + sign('admin:pw') } }).then(r => r.text());
    assert.match(ap, /Needs your OK/);
    assert.match(ap, /Approve &amp; send/, 'other pending drafts are listed with a send button');
  } finally { srv.close(); }
});
