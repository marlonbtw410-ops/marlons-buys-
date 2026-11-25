# Lead CRM: email outreach for wholesale real estate

An email-only CRM (no calls, no texts). Import seller lists, email the owners automatically from your Gmail, iCloud, Outlook or Yahoo inboxes, and see who replies.

## What it does

- **Imports skip-traced lists** (CSV from PropStream, DealMachine, BatchLeads, REISift, county lists). Columns are matched automatically and duplicates are skipped.
- **Sends from several inboxes** and rotates between them, with a daily limit and warm-up on each one so they stay out of spam.
- **Runs follow-up sequences.** For example: first email, a follow-up 3 days later, a final one after 7 more days. Follow-ups reply in the same email thread.
- **Every email is a little different.** `{{first_name}}` and `{{address}}` fill in, and `{Hi|Hey|Hello}` picks a random word.
- **Tracks replies.** It checks your inboxes every 5 minutes, marks leads as *replied* and stops their follow-ups. A reply like "stop" or "remove me" unsubscribes the lead automatically.
- **Handles bounces and unsubscribes.** Bad addresses are flagged. An unsubscribe link and your mailing address are added to every email (required by CAN-SPAM).
- **Pipeline:** new → contacted → replied → interested → appointment → under contract → closed / dead.
- **Seller lead form at `/sell`.** Share it on Facebook, Craigslist, flyers or a QR code on signs. Submissions show up as *interested* leads.

## Setup

1. Install [Node.js 22 or newer](https://nodejs.org).
2. In this folder:
   ```bash
   npm install
   ```
   ```bash
   cp .env.example .env
   ```
3. Edit `.env`: set `APP_PASSWORD`, set `SECRET_KEY` to a long random string, and set `TZ` to your timezone.
4. Start it:
   ```bash
   npm start
   ```
   Then open http://localhost:3000.

To try it without sending real email, run `npm run dev`. Emails are printed in the terminal instead of being sent.

## Connecting inboxes

Use an **app password**, not your normal password:

| Provider | Where to get an app password |
|---|---|
| Gmail / Google Workspace | Turn on 2-Step Verification, then go to myaccount.google.com/apppasswords |
| iCloud | account.apple.com → Sign-In and Security → App-Specific Passwords |
| Yahoo / AOL | Account Security → Generate app password |
| Outlook / Hotmail | Turn on 2-step verification, then create an app password. Microsoft is phasing this out, so if it won't connect, use another provider. |

## Getting good results

- **30–50 emails per inbox per day.** To reach more people, add more inboxes. Don't raise the limit.
- **Use extra domains for cold email**, not your main personal address. A few domains like `yournamebuyshouses.com` on Google Workspace work well. Leave warm-up on for 2–3 weeks.
- **Keep emails short and plain.** Ask one simple question. The built-in templates are a good start.
- **Only import emails from good skip-tracing.** Bounces damage an inbox's reputation fast.
- **Follow-ups bring in most replies.** Use 2–3 steps.

## Putting it online

The unsubscribe links and the `/sell` form only work for other people once the app has a public web address. Deploy it to any Node host with a persistent disk (Render, Railway, Fly.io, or a small VPS), keep the `data/` folder on that disk, and set `PUBLIC_URL` to the public address. All data is stored in `data/crm.db`, so back that file up.
