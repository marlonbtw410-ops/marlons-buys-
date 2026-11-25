const { esc } = require('./util');

const STATUSES = ['new', 'contacted', 'replied', 'interested', 'appointment', 'under_contract', 'closed', 'dead'];
const statusLabel = s => s.replace('_', ' ');

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--ink:#1d2330;--muted:#6b7280;--line:#e3e6eb;--brand:#0f766e;--brand-ink:#fff;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--ink:#e6e8eb;--muted:#9aa3ae;--line:#2a313a;--brand:#14b8a6;--brand-ink:#04211e}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}nav{background:var(--card);border-bottom:1px solid var(--line);padding:0 16px;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
nav b{margin-right:12px;padding:12px 0}nav a{padding:12px 10px;text-decoration:none;color:var(--muted)}nav a.on{color:var(--ink);box-shadow:inset 0 -2px var(--brand)}
main{max-width:1150px;margin:0 auto;padding:20px 16px}h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px;overflow-x:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.stat div{font-size:26px;font-weight:650}.stat span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;color:var(--muted);font-weight:600}
input,select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;width:100%}
textarea{min-height:140px}label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
button,.btn{font:inherit;background:var(--brand);color:var(--brand-ink);border:0;border-radius:6px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
.btn2{background:transparent;color:var(--ink);border:1px solid var(--line)}.danger{background:var(--bad);color:#fff}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--bg);border:1px solid var(--line)}
.muted{color:var(--muted)}.err{color:var(--bad)}.warn{color:var(--warn)}.flash{background:var(--card);border-left:4px solid var(--brand);padding:10px 14px;margin-bottom:16px;border-radius:6px}
.inline{display:inline}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
pre{white-space:pre-wrap;font:inherit;margin:0}.msg{border-left:3px solid var(--line);padding:6px 12px;margin:10px 0}.msg.in{border-color:var(--brand)}
`;

function layout(title, body, { active = '', flash = '' } = {}) {
  const links = [['/', 'Dashboard'], ['/leads', 'Leads'], ['/import', 'Import'], ['/campaigns', 'Campaigns'],
    ['/templates', 'Templates'], ['/inboxes', 'Inboxes'], ['/settings', 'Settings']];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Lead CRM</title><style>${CSS}</style></head><body>
<nav><b>Lead CRM</b>${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('')}
<form method="post" action="/logout" class="inline" style="margin-left:auto"><button class="btn2">Log out</button></form></nav>
<main>${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}</main></body></html>`;
}

function bare(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS} main{max-width:560px}</style></head><body><main>${body}</main></body></html>`;
}

const options = (list, sel) => list.map(v => {
  const [val, text] = Array.isArray(v) ? v : [v, statusLabel(String(v))];
  return `<option value="${esc(val)}" ${String(val) === String(sel) ? 'selected' : ''}>${esc(text)}</option>`;
}).join('');

module.exports = { layout, bare, options, STATUSES, statusLabel };
