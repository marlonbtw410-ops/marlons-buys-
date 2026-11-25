// What happens when a seller replies.
//
// Owner policy:
//  - Asking a seller for the info we need: automatic, no approval.
//  - Seller gave everything needed: automatic "thank you, offer coming by <date>". Never a price.
//  - Seller asks questions or anything sensitive: draft a reply, owner must approve before it sends.
const { simpleParser } = require('mailparser');
const { db, getSetting } = require('./db');
const { bannedWords } = require('./util');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// The facts we need before we can make an offer, and how we ask for each one.
const FACTS = {
  price: {
    label: 'price they want',
    ask: 'What price would you need to get for it, as-is?',
    re: /\$\s?\d[\d,.]*\s?k?\b|\b\d{2,3}(,\d{3})+\b|\b\d{2,3}(\.\d)?\s?k\b|\b\d{2,3}\s?(thousand|grand)\b/i,
  },
  timeline: {
    label: 'timeline',
    ask: 'How soon are you looking to sell?',
    re: /\b(asap|as soon as|right away|immediately|this (week|month|year|summer|spring|fall|winter)|next (week|month|year)|\d+\s*(days?|weeks?|months?)|no rush|no hurry|flexible|whenever|by (the )?(end of|first of|january|february|march|april|may|june|july|august|september|october|november|december)|soon)\b/i,
  },
  condition: {
    label: 'condition / repairs',
    ask: 'What shape is it in? Any big repairs needed, like the roof, foundation, AC, plumbing or electrical?',
    re: /\b(roofs?|foundation|repairs?|fixer|needs (some |a lot of )?work|updated|renovated|remodel\w*|condition|shape|hvac|a\/c|ac unit|plumbing|electrical|water damage|leaks?|mold|kitchen|bath(room)?s?|move[- ]in ready|as[- ]is|tlc|damage[ds]?|cosmetic|needs paint)\b/i,
  },
  occupancy: {
    label: 'occupancy',
    ask: 'Is anyone living there right now, or is it vacant?',
    re: /\b(vacant|empty|nobody|no one (lives|living)|tenants?|renters?|rented|leased|occupied|i live|we live|living (there|in it)|lives there)\b/i,
  },
  reason: {
    label: 'reason for selling',
    ask: 'What has you thinking about selling?',
    re: /\b(inherit\w*|passed away|estate|probate|moving|relocat\w*|divorc\w*|retir\w*|downsiz\w*|tired of|landlord|job|behind on|back taxes|foreclos\w*|can'?t afford|don'?t need it|too much (work|house)|health|bad tenants?)\b/i,
  },
};
const FACT_KEYS = Object.keys(FACTS);

const STOP_RE = /\b(unsubscribe|stop|remove me|take me off|do not (contact|email)|don'?t (contact|email)|not interested|no thanks|no thank you|not selling|not for sale|leave me alone)\b/i;
const AUTO_REPLY_RE = /\b(auto(matic)?[- ]?reply|out of (the )?office|on vacation|away from (my|the) (desk|office)|autoreply)\b/i;
// Anything here means a human should look before we answer.
const SENSITIVE_RE = /\b(attorney|lawyer|realtor|agent|broker|listed|listing|mls|scam|spam|how did you get|where did you get|who is this|who are you|report you|harass\w*|sue|legal)\b/i;
const QUESTION_RE = /\?|^\s*(how|what|who|why|when|where|can you|could you|do you|does|are you|is this|is it|will you|would you)\b/im;

// Pull the plain text out of a raw email.
async function parseEmail(source) {
  const p = await simpleParser(source);
  const text = p.text || (p.html ? String(p.html).replace(/<[^>]+>/g, ' ') : '');
  return { subject: p.subject || '', text, messageId: p.messageId, date: p.date };
}

// Drop the quoted copy of our own email ("On Mon, ... wrote:", "> ..." lines, signatures).
function stripQuoted(text) {
  let s = String(text || '').replace(/\r/g, '');
  const cut = [/^On .{0,200}wrote:\s*$/m, /^-{2,}\s*Original Message/im, /^_{5,}/m, /^From: .+$/m, /^Sent from my /m, /^--\s*$/m]
    .map(re => s.search(re)).filter(i => i > 0);
  if (cut.length) s = s.slice(0, Math.min(...cut));
  return s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim();
}

// The sentence that contains a match, so the owner sees it in context.
function snippet(text, re) {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  const hit = sentences.find(x => re.test(x)) || '';
  return hit.trim().slice(0, 200);
}

function classify(text, subject = '') {
  const reply = stripQuoted(text);
  const facts = {};
  for (const k of FACT_KEYS) if (FACTS[k].re.test(reply)) facts[k] = snippet(reply, FACTS[k].re);
  return {
    reply, facts,
    optOut: STOP_RE.test(reply.slice(0, 500)),
    autoReply: AUTO_REPLY_RE.test(subject) || AUTO_REPLY_RE.test(reply.slice(0, 300)),
    question: QUESTION_RE.test(reply),
    sensitive: SENSITIVE_RE.test(reply),
  };
}

function leadFacts(lead) { try { return JSON.parse(lead.facts || '{}'); } catch { return {}; } }
function missingFacts(facts) { return FACT_KEYS.filter(k => !facts[k]); }

function signature() {
  return [getSetting('my_name'), getSetting('business_name'), getSetting('my_phone')].filter(Boolean).join('\n');
}
function offerDueDate() {
  const d = new Date(Date.now() + Number(getSetting('offer_days', '5') || 5) * 86400000);
  // Never promise a weekend: Saturday/Sunday move back to Friday.
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);
  return { iso: d.toISOString().slice(0, 10), text: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) };
}
const reSubject = s => (/^re:/i.test(s) ? s : 'Re: ' + (s || 'your property'));
const hi = lead => `Hi ${lead.first_name || 'there'},`;
const place = lead => lead.address || 'the property';
const numbered = keys => keys.map((k, i) => `${i + 1}. ${FACTS[k].ask}`).join('\n');

function ackEmail(lead, due) {
  return `${hi(lead)}\n\nThank you, that's everything I need on ${place(lead)}. I'm putting your offer together now and you'll have it from me by ${due.text}.\n\nIf anything changes in the meantime, just reply here.\n\nThank you,\n${signature()}`;
}
function infoRequestEmail(lead, missing) {
  return `${hi(lead)}\n\nThanks for getting back to me. To put together a real offer on ${place(lead)}, I just need a few more details:\n\n${numbered(missing)}\n\nOnce I have those, I can get you a number quickly.\n\nThank you,\n${signature()}`;
}
// Draft for the owner to edit. Common questions get a suggested answer; anything else gets a placeholder.
function questionDraft(lead, reply, missing) {
  const answers = [];
  if (/how did you get|where did you get|how do you have/i.test(reply)) answers.push('I came across your property through public property records.');
  if (/\b(realtor|agent|broker)\b/i.test(reply)) answers.push("I'm not a real estate agent. I'm a buyer, so there are no agent commissions on your side.");
  if (/(what|how much).{0,40}(offer|pay|give)|your offer|make (me )?an offer|what.{0,20}number/i.test(reply))
    answers.push("I'd rather give you a real number than a guess. Once I have the details below, I'll get you an offer.");
  if (!answers.length) answers.push('[ANSWER THEIR QUESTION HERE]');
  const more = missing.length ? `\n\nTo get you an offer on ${place(lead)}, could you also tell me:\n\n${numbered(missing)}` : '';
  return `${hi(lead)}\n\nThanks for getting back to me.\n\n${answers.join('\n\n')}${more}\n\nThank you,\n${signature()}`;
}

async function sendAutoReply({ lead, inbox, subject, body, inReplyTo, kind }) {
  const engine = require('./engine'); // lazy: engine requires this module
  const bad = bannedWords(subject + '\n' + body);
  if (bad.length) { createDraft({ lead, inbox, subject, body, inReplyTo, reason: `Auto-reply blocked for banned wording (${bad.join(', ')})` }); return; }
  const msgId = await engine.sendEmail({ inbox, lead, subject, body, inReplyTo });
  db.prepare(`INSERT INTO messages(lead_id, inbox_id, direction, subject, body, message_id) VALUES(?, ?, 'out', ?, ?, ?)`)
    .run(lead.id, inbox.id, subject, body, msgId);
  log(`auto ${kind} sent to ${lead.email}`);
}

function createDraft({ lead, inbox, subject, body, inReplyTo, reason }) {
  db.prepare("UPDATE drafts SET status = 'replaced' WHERE lead_id = ? AND status = 'pending'").run(lead.id);
  db.prepare(`INSERT INTO drafts(lead_id, inbox_id, in_reply_to, subject, body, reason) VALUES(?, ?, ?, ?, ?, ?)`)
    .run(lead.id, inbox.id, inReplyTo || null, subject, body, reason);
  log(`draft waiting for approval: ${lead.email} (${reason})`);
}

// Main entry: a lead's email came in. Returns what was decided (useful for tests and logs).
async function handleIncoming({ lead, inbox, subject, text, messageId, date }) {
  const c = classify(text, subject);
  db.prepare(`INSERT OR IGNORE INTO messages(lead_id, inbox_id, direction, subject, body, message_id, sent_at)
    VALUES(?, ?, 'in', ?, ?, ?, datetime(?))`)
    .run(lead.id, inbox.id, subject, c.reply.slice(0, 4000), messageId, (date || new Date()).toISOString());
  if (c.autoReply) return 'auto_reply_ignored';

  db.prepare("UPDATE enrollments SET status = 'replied' WHERE lead_id = ? AND status = 'active'").run(lead.id);
  if (c.optOut && !c.question) {
    db.prepare("UPDATE leads SET replied_at = datetime('now'), unsubscribed = 1, status = 'dead' WHERE id = ?").run(lead.id);
    return 'opted_out';
  }

  // Merge new facts with what we already know from earlier replies.
  const facts = { ...leadFacts(lead) };
  for (const [k, v] of Object.entries(c.facts)) if (!facts[k]) facts[k] = v;
  const missing = missingFacts(facts);
  db.prepare(`UPDATE leads SET replied_at = datetime('now'), facts = ?,
    status = CASE WHEN status IN ('new','contacted') THEN 'replied' ELSE status END WHERE id = ?`)
    .run(JSON.stringify(facts), lead.id);
  const fresh = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
  const subj = reSubject(subject);
  const base = { lead: fresh, inbox, subject: subj, inReplyTo: messageId };

  if (c.question || c.sensitive || c.optOut) {
    const why = c.sensitive ? 'They mentioned something sensitive (agent, lawyer, listing, "who is this"...)'
      : c.optOut ? 'Mixed message: sounds like a no, but they also asked something' : 'They asked a question';
    createDraft({ ...base, body: questionDraft(fresh, c.reply, missing), reason: why });
    return 'needs_approval';
  }
  if (fresh.status === 'offer_due') {
    createDraft({ ...base, body: `${hi(fresh)}\n\n[REPLY HERE]\n\nThank you,\n${signature()}`, reason: 'They wrote again after we promised an offer' });
    return 'needs_approval';
  }
  if (!missing.length) {
    if (getSetting('auto_offer_ack', '1') === '0') {
      createDraft({ ...base, body: ackEmail(fresh, offerDueDate()), reason: 'All info gathered (auto thank-you is turned off)' });
      return 'needs_approval';
    }
    const due = offerDueDate();
    await sendAutoReply({ ...base, body: ackEmail(fresh, due), kind: 'offer-coming thank you' });
    db.prepare("UPDATE leads SET status = 'offer_due', offer_due_at = ? WHERE id = ?").run(due.iso, lead.id);
    return 'offer_ack_sent';
  }
  if ((fresh.auto_info_requests || 0) < 1 && getSetting('auto_info_request', '1') !== '0') {
    await sendAutoReply({ ...base, body: infoRequestEmail(fresh, missing), kind: 'info request' });
    db.prepare('UPDATE leads SET auto_info_requests = auto_info_requests + 1 WHERE id = ?').run(lead.id);
    return 'info_request_sent';
  }
  createDraft({ ...base, body: infoRequestEmail(fresh, missing), reason: `Still missing: ${missing.map(k => FACTS[k].label).join(', ')}` });
  return 'needs_approval';
}

module.exports = { handleIncoming, parseEmail, classify, stripQuoted, FACTS, FACT_KEYS, leadFacts, missingFacts, offerDueDate };
