# stay-in-sight

Outbound email service on **Cloudflare Workers + D1 (SQLite)**.

- Connect one or more **Gmail / Google Workspace** mailboxes (OAuth).
- **Send** emails (sender, to, subject, body, send time, **campaign**). Sending is always scheduled: every email is queued with a send time (empty means within a minute), and a cron runs every minute and sends what's due within each mailbox's limits.
- **AI reply categories** via OpenRouter (low-cost model, one short call per reply). You define categories by name and description; `stop` always exists and puts the sender on the do-not-send list. The category is included in the reply webhook.
- **Settings page**: app name, Google OAuth client, OpenRouter key, Pub/Sub topic, emails per minute and public URL can be set in the app after deploy, overriding the deploy-time values. Only the passcode is deploy-only.
- **Senders**: each mailbox has one or more senders (From name, From address, Reply-To) with a description of when to use them. Pick a sender when sending and its values fill in, overridable per email. MCP and the API can send "as" a sender directly.
- **AWS SES mailboxes** alongside Gmail: send through SES's API with per-email tracked reply addresses (`reply+<token>@reply.yourdomain`) that Cloudflare Email Routing delivers back to the Worker, plus bounce and complaint handling from SES via signature-verified SNS (hard bounces and complaints go to do-not-send). Setup: [DEPLOY.md, Part 4](DEPLOY.md#part-4--aws-ses-mailbox-optional).
- **Contacts and lists**: import contacts from CSV on the Contacts page (an email column is required, name optional, every other column becomes a field usable as `{{variable}}`), put them on any number of lists, and send to one or more lists. Bulk sends in the app always go to lists; there's no CSV upload on the Send page. With a template, people who already got it are skipped, so you can keep adding contacts to a list and send the same template again.
- **Templates** with `{{variables}}` and a permanent `template_id`. The contact fields a template needs are worked out from its variables. **A template is sent to each address at most once**: sending it again to people who already received it (or have it queued) skips them, enforced by a unique index in the database.
- **AI personalization** (per template): just before each email is sent, a model rewrites it for that person using your instructions and their contact data (fields like `last_login`, lists, engagement), and can skip them. Test it on a contact in the template editor. See [AI personalization](#ai-personalization).
- **Series** (drip campaigns): template emails sent one after another, a number of days apart, to everyone on one or more lists, including people added later. Add steps any time; everyone gets them in order. See [Series](#series-drip-campaigns).
- **Person timeline**: one page per address with everything that happened: every email from any mailbox, sender, list send, series or group (with opens), their replies, list joins, series progress and do-not-send. Open it from a contact, an email's recipient, or a reply's sender; `GET /api/people/:email/activity`; MCP `get_activity`.
- **Per-mailbox limits**: a max emails per day and a throttle (minimum minutes between sends). Both always have a value (defaults 50/day, 5 min). **Auto-send** spreads a bulk batch over as many days as the limits require.
- **Warm-up**: a mailbox's daily limit can start low and grow each day until it reaches its max. **Mailbox groups**: several mailboxes that send as one (mainly for cold outreach); a send to a group is spread across them by each one's limits and warm-up. See [Warm-up and mailbox groups](#warm-up-and-mailbox-groups).
- **Mailbox purposes**: each mailbox is for **cold outreach**, a **newsletter** or **conversations**. The purpose decides how its mail is built (tracking pixel, `List-Unsubscribe` one-click headers, footer, list headers, spacing) and which do-not-send entries stop it. See [Mailbox purposes](#mailbox-purposes).
- **Replies** to your emails are detected (Gmail history polling every minute, or instant via Gmail push). Auto-replies and bounces are filtered out; the reply text has quoted history stripped; the whole thread is broken into a `conversation` and **POSTed to the mailbox's reply webhook**.
- **Do-not-send list**: anyone who replies `STOP` (or `unsubscribe`, `remove me`), or clicks the unsubscribe link, is added; their pending emails are skipped and future sends to them are refused. Entries are scoped by purpose: a newsletter unsubscribe doesn't stop a conversation mailbox answering that person.
- **Threaded replies**: answer any sent email in the same thread (`In-Reply-To`/`References`, same Gmail thread) from the email's page, `POST /api/emails/:id/reply` or the MCP `reply_to_email` tool.
- **UI** for scheduled/sent emails, replies, campaigns (sent / opened / replied / STOP rates), mailboxes, do-not-send.
- **MCP endpoint** (`/mcp`, streamable HTTP) and a **REST API** (`/api`).
- Everything is protected by **one passcode** (UI login, API Bearer token, MCP Bearer token), chosen by the first person to open the app after deploy and changeable on the MCP & API page. Every other setting is set in the app too.

## Deploy

> **Step-by-step guide, including Gmail Pub/Sub: [DEPLOY.md](DEPLOY.md).** The summary below is the short version.
>
> **One command per tenant:** put settings and secrets in `tenants/<tenant>.env` and run `npm run deploy:tenant -- <tenant>`. See [DEPLOY.md](DEPLOY.md#one-command-deploys-with-tenant-files).

### 1. Cloudflare

```bash
npm install
npx wrangler d1 create cms-outbound      # copy database_name + database_id into wrangler.toml
npm run db:migrate                       # applies migrations/ to the remote D1
# no secrets needed: the first person to open the app chooses the passcode (UI, API and MCP)
```

Set `PUBLIC_URL` in `wrangler.toml` to the worker's URL (e.g. `https://cms-outbound.<you>.workers.dev` or a custom domain). It is used for the tracking pixel, unsubscribe links and the OAuth redirect. If left empty, the first URL you use to reach the UI/API is remembered.

### 2. Google OAuth client

1. In Google Cloud Console create (or pick) a project and **enable the Gmail API**.
2. **OAuth consent screen**
   - Google Workspace mailboxes only → choose **Internal** (no verification, refresh tokens don't expire).
   - Gmail.com mailboxes → **External**, add yourself as a test user, then click **Publish app**. While the app is in *Testing* status Google expires refresh tokens after 7 days. An unverified published app shows a "Google hasn't verified this app" warning you can click through (fine for your own mailboxes).
   - Scopes used: `gmail.send`, `gmail.readonly`, `openid`, `email`, `profile`.
3. **Credentials → Create OAuth client ID → Web application.** Authorized redirect URI:
   `https://<your-worker>/oauth/google/callback` (the UI shows the exact value under *MCP & API*).
4. Store the client:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

### Optional: AI reply categories (OpenRouter)

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

The default model is `OPENROUTER_MODEL` in `wrangler.toml` (`openai/gpt-6-luna`, the same low-cost model the main backend uses for spam filtering). You can switch to any OpenRouter model id on the **Reply categories** page. Without a key, only literal `STOP` replies get a category.

On the same page, fill in **About your outreach**: a few sentences on who you are, what you offer and who you email (max 2,000 characters). It goes into the model's system prompt, so replies like "can you do one for our second location too?" are read in context. The page shows the full system prompt.

### 3. Ship it

```bash
npm run deploy
```

Open the worker URL, sign in with the passcode, go to **Mailboxes → Connect Google mailbox**, and set each mailbox's **reply webhook URL** (and optional signing secret).

### Optional: instant reply detection (Gmail push)

Without this, replies are found by polling Gmail history every minute, which is enough for most use. For instant delivery:

1. Create a Pub/Sub topic, e.g. `projects/<proj>/topics/gmail-outbound`, and grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role on it.
2. Create a **push** subscription on that topic whose endpoint is the URL shown in the UI under *Mailboxes → Reply detection* (`https://<worker>/webhooks/gmail?token=…`).
3. Set `GMAIL_PUBSUB_TOPIC` in `wrangler.toml` and redeploy. Watches are created on connect and renewed automatically before their 7-day expiry.

## Local development

```bash
cp .dev.vars.example .dev.vars     # set PASSCODE (and Google creds to test OAuth)
npm run db:migrate:local
npm run dev                        # http://localhost:8787 ; cron: curl "localhost:8787/__scheduled"
npm test                           # parser/MIME unit tests + send→reply→STOP flow with mocked Gmail
npm run typecheck
```

For OAuth locally, add `http://localhost:8787/oauth/google/callback` as a redirect URI on the Google client.

## Authentication

| Where | How |
|---|---|
| UI | `/login` with the passcode → 30-day signed cookie |
| REST API | `Authorization: Bearer <PASSCODE>` (or `x-passcode` header) |
| MCP | `Authorization: Bearer <PASSCODE>`, or `?key=<PASSCODE>` for clients that only accept a URL |

Public (no passcode): `/t/<token>.gif` (pixel), `/u/<token>` (unsubscribe), `/oauth/google/callback` (signed state), `/webhooks/gmail?token=…` (token derived from the passcode; it only triggers a sync).

Changing `PASSCODE` signs out all UI sessions. The Gmail push URL has its own token, stored in the database and independent of the passcode; regenerate it on the Settings page if it leaks, then update the Pub/Sub subscription.

### On the SleekSky platform

When the platform runs this app it sets `APP_ID`, `CONTROLLER_URL` (the console, for redirects) and the `SKY` service binding (src/platform.ts); without them the app is self-hosted and none of this applies.

- **Sign-in:** the login page also offers **Sign in with SleekSky** (`/auth/platform`, the manifest's `signin_path`). It goes to the console's `/auth`, comes back to `/auth/platform/callback` with a one-time code, and swaps it over `SKY` (`POST https://sky/auth/token`). The account's owners and staff get a session (and the first one chooses the passcode on `/setup`); anyone else is refused and removed from the app's sign-ins. The passcode still works for the UI, API and MCP.
- **Schedule:** no cron. The `Scheduler` Durable Object runs the per-minute work on a 1-minute alarm; the manifest's 15-minute schedule (`POST /_platform/tick`) wakes it if it ever stops. `/_platform/*` is only reachable by the platform.
- **Storage:** when the platform's `GET https://sky/api/tenant/init` says storage is `over` the plan's allowance, contact imports are refused.

## MCP

Endpoint: `https://<worker>/mcp` (streamable HTTP, stateless JSON responses).

```bash
claude mcp add --transport http outbound https://<worker>/mcp --header "Authorization: Bearer <PASSCODE>"
```

Tools (64): `overview`, `preview_personalization`, `get_activity`, `get_settings`, `update_settings`, `list_series`, `save_series`, `save_series_step`, `delete_series_step`, `delete_series`, `list_series_enrollments`, `set_series_enrollment`, `list_groups`, `save_group`, `delete_group`, `list_senders`, `save_sender`, `delete_sender`, `send_email`, `reply_to_email`, `list_mailboxes`, `add_ses_mailbox`, `check_ses_mailbox`, `update_mailbox`, `schedule_emails`, `preview_schedule`, `list_templates`, `get_template`, `save_template`, `check_template_recipients`, `list_lists`, `list_contacts`, `save_contact`, `get_contact`, `update_contact`, `delete_contacts`, `save_list`, `delete_list`, `import_contacts`, `set_contact_lists`, `preview_list_send`, `send_to_lists`, `list_emails`, `get_email`, `update_email`, `cancel_emails`, `send_now`, `list_replies`, `list_categories`, `save_category`, `delete_category`, `set_categorizer`, `set_reply_category`, `check_replies`, `redeliver_webhook`, `recategorize_reply`, `refresh_send_as`, `delete_template`, `get_conversation`, `list_campaigns`, `campaign_stats`, `dnc_list`, `dnc_add`, `dnc_remove`.

Everything in the app can be done over MCP except disconnecting a mailbox and regenerating the Gmail push token, which are kept in the UI on purpose (they break things until fixed by hand).

## REST API

Interactive docs (Swagger UI) are at **`/api-docs`** on your deployment, and the OpenAPI 3.0 spec at **`/api-docs/openapi.json`**. Both need you to be signed in to the app, or a Bearer passcode. Click **Authorize** in the docs and paste your passcode to try requests. You can import the JSON into Postman or Insomnia, or into a client generator. A test fails if any route is missing from the spec.

All under `/api`, JSON in/out.

| Method | Path | Notes |
|---|---|---|
| GET / PUT | `/settings` | App settings overriding deploy-time config; PUT `{KEY: value}`, `""` clears. Secrets are write-only. |
| GET | `/overview` | Totals |
| GET | `/config` | Base URL, MCP URL, OAuth redirect URI, push endpoint |
| GET | `/mailboxes` | |
| PATCH | `/mailboxes/:id` | `{name, from_email, reply_to, webhook_url, webhook_secret, daily_limit, throttle_minutes, active}` |
| POST | `/mailboxes/:id/send-as` | Reload the mailbox's verified Gmail "Send mail as" addresses |
| GET | `/mailboxes/:id/plan` | `?count=N&start_at=ISO` — preview auto-send times; schedules nothing |
| GET | `/people/:email-or-contact-id/activity` | Everything that happened with one address, newest first: emails (with mailbox, sender, campaign, series step, opens), replies, list joins, series, do-not-send. Works for addresses that aren't contacts |
| GET / POST | `/series` | List series (steps, lists, progress) / create `{name, sender\|group, lists, steps?, stop_on_reply?, campaign?}` |
| GET / PATCH / DELETE | `/series/:id-or-name` | `active: false` pauses; `lists` replaces the attached lists; delete cancels unsent series emails |
| POST | `/series/:id/steps` | `{template_id \| subject+body, delay_days, position?}` |
| PATCH / DELETE | `/series/:id/steps/:step` | Change delay, position or template (subject/body edit the template) / remove (unsent emails cancelled) |
| GET | `/series/:id/enrollments` | `?status=in_progress\|completed\|stopped\|not_on_list&q` — who's where, next step and when |
| PATCH | `/series/:id/enrollments/:id` | `{status: "stopped" \| "active"}` |
| POST | `/series/:id/run` | Enroll new list members and schedule what's due now (the cron does this every minute) |
| GET / POST | `/groups` | List groups (members, warm-up, capacity today) / create `{name, description?, mailboxes?}` |
| GET / PATCH / DELETE | `/groups/:id-or-name` | `mailboxes` replaces the membership; delete keeps the mailboxes |
| GET | `/groups/:id/plan` | `?count=N&start_at=ISO` — when a send through the group would go out, and how many each mailbox takes |
| DELETE | `/mailboxes/:id` | Disconnect (cancels its scheduled emails) |
| POST | `/mailboxes/:id/sync` | Check for replies now |
| GET / POST | `/senders` | `?mailbox` / create `{mailbox, label, description, from_name, from_email, reply_to, key?, is_default?}` |
| GET / PATCH / DELETE | `/senders/:id-or-key` | Delete isn't allowed for the default sender |
| GET | `/emails` | `?campaign&status=sent,failed&mailbox&purpose&to&q&opened=true&replied=true&limit&offset` |
| POST | `/emails` | One email object, an array, or `{emails:[…], auto_schedule?, start_at?}` (max 1000) |
| GET | `/emails/:id` | Includes body, opens, replies |
| PATCH | `/emails/:id` | Edit/reschedule unsent email (re-queues cancelled/failed) |
| GET | `/emails/:id/conversation` | Live Gmail thread as a conversation |
| POST | `/emails/:id/reply` | `{body, subject?, to?, sender?, send_at?}` — answer in the same thread; sends now unless `send_at` |
| POST | `/emails/cancel` | `{ids}` / `{filter, exclude_ids?}` (the `GET /emails` query, across all pages) / `{campaign}` / `{to}`. Only scheduled emails are cancelled |
| POST | `/emails/send-now` | `{ids}` / `{filter, exclude_ids?}`. The first 25 go straight away; the rest become due now and go out over the next minutes (`queued`) |
| GET | `/templates` | Templates with required `columns` and stats |
| POST | `/templates` | `{template_id, name?, subject, body}` |
| GET / PATCH / DELETE | `/templates/:template_id` | PATCH `{name?, subject?, body?}` — `template_id` can't change |
| POST | `/templates/:template_id/check` | `{emails:[…]}` → who already has it queued or sent |
| GET | `/contacts` | `?list&q&rules&match&sort&dir&limit&offset` — see [Filtering contacts](#filtering-contacts) (`email` = exact match) |
| GET | `/contacts/fields` | Field names in use, most common first |
| GET | `/contacts/export` | CSV: `?ids=1,2` or a filter (`list`, `q`, `rules`, `match`), optionally `exclude_ids` |
| POST | `/contacts` | Add or update one contact: `{email, first_name?, last_name?, name?, lists?, …any attribute}` → 201 created / 200 updated |
| POST | `/contacts/import` | `{rows:[{email, name?, …fields}], lists?:[names]}` — upsert by email, max 5000 rows |
| GET / PATCH | `/contacts/:id` | PATCH `{name?, set?:{…}, remove?:[keys], fields?:{…}}`: `set` adds/changes fields, `remove` deletes them, `fields` replaces all |
| POST | `/contacts/lists` | `{ids?, emails?, filter?, exclude_ids?, add?:[lists], remove?:[lists]}` — existing contacts by id or email; lists are created when added to; unknown emails come back in `not_found` |
| POST | `/contacts/delete` | `{ids?, emails?, filter?, exclude_ids?}` — email history is kept |
| GET / POST | `/lists` | List lists with counts / create `{name, description?}` |
| PATCH / DELETE | `/lists/:id` | Rename / delete (contacts stay) |
| POST | `/lists/preview` | Same body as `/lists/send` → who'd get it (and the first few, in order), who's skipped (do-not-send, already received, missing variable), and how many the limit holds back |
| POST | `/lists/send` | `{lists, mailbox, template_id? \| subject+body, filter?, sort?, dir?, limit?, campaign?, from_*?, reply_to?, auto_schedule?, start_at?, send_at?, interval_minutes?}` — max 5000 per send |
| GET | `/replies` | `?campaign&mailbox&purpose&kind=reply|stop|auto|bounce&category&since` |
| POST | `/replies/:id/redeliver` | Re-send the reply webhook |
| GET / POST | `/categories` | List / create or update `{name, description, rename_to?}` |
| DELETE | `/categories/:name` | Not allowed for `stop` |
| GET / PUT | `/ai` | Categorizer status, model, outreach context and system prompt / set `{model?, context?}` |
| POST | `/ai/test` | `{text}` → category the model picks (one real call) |
| POST | `/replies/:id/category` | `{category}` — set by hand; `stop` adds to do-not-send |
| POST | `/replies/:id/categorize` | Ask the model again |
| GET | `/campaigns` | Stats for every campaign |
| GET | `/campaigns/:name` | Stats + per-day breakdown |
| GET / POST / DELETE | `/dnc` | List `?q&scope` / add `{emails, reason, scope?}` / remove `{emails}` |
| POST | `/run` | Run the cron work now (send due, sync replies, retry webhooks) |

Email object:

```json
{
  "mailbox": "me@company.com",
  "to": "jane@acme.com",
  "to_name": "Jane Doe",
  "subject": "Quick question",
  "body_html": "<p>Hi Jane…</p>",
  "body_text": "Hi Jane…",
  "send_at": "2026-11-12T09:30:00-05:00",
  "campaign": "q4-founders",
  "from_name": "Sam",
  "from_email": "sales@company.com",
  "reply_to": "team@company.com",
  "metadata": { "crm_id": "123" }
}
```

**Sender identity.** Each mailbox has defaults for From name, From address and Reply-To (set on its card or with `PATCH /mailboxes/:id`); any email can override them with `from_name`, `from_email` and `reply_to`. The From address must be the mailbox itself or one of its verified Gmail **"Send mail as"** aliases (Gmail → Settings → Accounts → Send mail as), because Gmail replaces any other From with the account's own address. Aliases are loaded from Gmail when a mailbox connects; reload them from the mailbox card after adding one. Reply-To can be any address, but replies are only tracked (STOP, categories, webhooks) when they arrive in the sending mailbox, so point it at the mailbox or one of its aliases.

`body` may be used instead of `body_html`/`body_text` (HTML if it contains tags). `send_at` accepts ISO 8601 or epoch; omit to send on the next minute. `metadata` is echoed in reply webhooks.

### Mailbox purposes

Set on the mailbox's **Purpose** tab (or `PATCH /api/mailboxes/:id {purpose}`, MCP `update_mailbox`). New Gmail mailboxes start as cold outreach, SES mailboxes as newsletters.

| | Cold outreach | Newsletter | Conversation |
|---|---|---|---|
| For | One-to-one emails to people who haven't heard from you | Bulk mail to people who signed up | Back-and-forth with people who wrote to you |
| Tracking pixel | Off | On | Off |
| `List-Unsubscribe` + one-click | Off | On | Off |
| Footer | `If you'd rather not hear from me, just reply "stop".` | `Unsubscribe: {{unsubscribe_url}}` | None |
| `List-Id`, `Precedence: bulk` | No | Yes | No |
| Auto-send spacing | Uneven: throttle plus up to 60% more | Exactly the throttle | Exactly the throttle |
| Stopped by do-not-send entries for | Everything, or Outreach and newsletters | Any entry | Everything only |
| A STOP or unsubscribe adds | Outreach and newsletters | Newsletters only | Everything |
| Suggested limits | 30 a day, 1 every 8 min | 1000 a day, 1 every 1 min | 200 a day, 1 every 1 min |

Tracking, the unsubscribe header and the footer can be overridden per mailbox (`track_opens`, `list_unsubscribe`, `footer`; `null` goes back to the purpose default, `footer: ""` means no footer). The footer is plain text and `{{unsubscribe_url}}` becomes the mailbox's unsubscribe link. For commercial email, put your postal address in it (CAN-SPAM). Changes apply to emails already queued, since mail is built when it's sent.

**Do-not-send scopes.** Each entry has a scope: `all` (no mailbox emails them: hard bounces, complaints, manual entries by default, and everything that was on the list before scopes existed), `marketing` (no outreach or newsletters; a conversation mailbox can still answer them) or `newsletter` (newsletters only). An address keeps its widest scope.

**Replies in the thread.** `POST /api/emails/:id/reply {body}` (or the reply box on an email, or MCP `reply_to_email`) answers a sent email: it goes to whoever last replied, as `Re: <subject>`, from the same mailbox, sender, From and Reply-To, with `In-Reply-To`/`References` set and in the same Gmail thread. A reply to a reply carries the whole chain. `in_reply_to: <email id>` does the same on `POST /api/emails` and the MCP `send_email` / `schedule_emails` tools.

### Series (drip campaigns)

A series is an ordered set of emails sent one after another to everyone on its lists. Create one on the **Series** page (or `POST /api/series`), pick who it sends as (a sender, or a mailbox group), attach one or more lists, and add steps.

- **Steps** are templates. Write the email in the step (a template like `onboarding-2` is created for it) or pick a saved template. Contact fields fill the `{{variables}}`.
- **Delays**: step 1 goes `delay_days` after someone joins (0 = right away). Each later step goes `delay_days` after the previous email *went out*, so a step held by a mailbox's limits never shortens the gap.
- **Joining later**: everyone on an attached list is enrolled, and so is anyone added to it later; they start at step 1. Attach a list with `{"list": "Upgraded", "only_new": true}` (or "Only people added from now on") to skip the people already on it. Your app can enroll people by adding them to the list (`POST /api/contacts` with `lists`, or `POST /api/contacts/lists`).
- **Adding steps later**: a new step reaches everyone who hasn't had it, including people who had finished. They get it `delay_days` after their last series email.
- **Stopping**: do-not-send and hard bounces stop someone's series. Optionally a reply stops it too (`stop_on_reply`). Someone removed from every attached list waits, and carries on if they're added back. You can stop or resume one person, or pause the whole series (`active: false`).
- **Skips**: a step someone already received (templates go to an address once) or that's missing one of their variables is skipped, and they move on.
- **Emails** are scheduled when they come due and spread by the mailbox's limits (or the group's). Each has `series_id` and `series_step_id`, uses the series name as its campaign unless you set one, and carries `contact_id`, `series` and `series_step` in its metadata for reply webhooks.

Example: onboarding new users, then upselling people who upgrade.

```json
POST /api/series
{ "name": "Onboarding", "sender": "product", "lists": ["New users"],
  "steps": [
    { "subject": "Welcome, {{first_name}}", "body": "…", "delay_days": 0 },
    { "subject": "Capture leads with forms", "body": "…", "delay_days": 2 },
    { "subject": "Your first campaign", "body": "…", "delay_days": 3 } ] }

POST /api/series
{ "name": "Upgraded", "sender": "success", "lists": [{ "list": "Upgraded", "only_new": true }],
  "steps": [{ "template_id": "pro-welcome" }, { "template_id": "pro-leads", "delay_days": 4 }] }
```

### Warm-up and mailbox groups

**Warm-up.** Turn it on in a mailbox's **Sending** tab (or `PATCH /api/mailboxes/:id {warmup: true, warmup_start: 5, warmup_step: 3}`). Day 1 allows `warmup_start` emails, and each day adds `warmup_step`, until it reaches the mailbox's daily limit. With 5 and 3 and a limit of 30, that's 5, 8, 11, … and 30 a day from day 10. The sender holds emails over today's limit (`waiting: warm-up limit of 8 today`), and auto-send plans around the growing limit. `warmup_restart: true` starts again from day 1; `warmup: false` turns it off. This only paces volume. It doesn't send or answer warm-up emails, so use a warm-up service as well if you want inbox engagement.

**Mailbox groups.** Create one under **Mailboxes → Mailbox groups** (or `POST /api/groups {name, mailboxes: [...]}`). A mailbox is in at most one group. Send through it by picking the group in the Send page's sender list, or with `"group": "<name or id>"` on `POST /api/emails`, `POST /api/lists/send` or the MCP tools:

- Each email goes to the member with the earliest free slot, by that member's own throttle, daily limit and warm-up. A mailbox that's warming up takes fewer, and paused or disconnected members are skipped.
- Each email goes out as its mailbox's **default sender**. `from_name` and `reply_to` can still be overridden; `from_email` can't.
- Group sends are always planned like auto-send. `send_at` or `start_at` is the earliest time.
- A recipient who already has email from one of the members stays with that member, so follow-ups come from the same address.
- Do-not-send uses the members' purpose. If the members' purposes differ, any entry blocks.
- Emails remember the group (`group_id`). Filter with `?group=` on `/api/emails` and `/api/replies`.

### Senders

A sender is an identity an email goes out as: **From name**, **From address** and **Reply-To**, plus a **label**, a **key** (for the API and MCP) and a **description** of when to use it. People and AI agents read the description to pick one. Every mailbox has a default sender, created when it's connected (existing mailboxes get one in the migration). Add more on the mailbox's **Senders** tab.

- The From address must be one this mailbox can send as: for Gmail, the mailbox or a verified "Send mail as" alias; for SES, any address on the verified domain.
- Schedule with `"sender": "<key>"`; the sender picks the mailbox. Without a sender, the mailbox's default sender applies. `from_name`, `from_email` or `reply_to` on an email override the sender's.
- The sender's values are copied onto each email when it's scheduled, so editing a sender later doesn't change emails already queued.
- MCP: `list_senders` (with descriptions), `save_sender`, `delete_sender`, and `send_email` to send right away as a sender.

```bash
curl -X POST https://<your URL>/api/emails -H "Authorization: Bearer <PASSCODE>" -H "content-type: application/json" \
  -d '{"sender":"acme-sales","to":"lead@example.com","subject":"Your quote","body":"Hi, here it is."}'
```

### Contacts and lists

Add one contact with all its details:

```bash
curl -X POST https://<your URL>/api/contacts \
  -H "Authorization: Bearer <PASSCODE>" -H "content-type: application/json" \
  -d '{"email":"jane@acme.com","first_name":"Jane","last_name":"Doe","company":"Acme","title":"CTO","phone":"+1 555 0100","lists":["Q1 Leads"]}'
```

Any attribute can go at the top level or inside `"fields": {…}`. Keys are lowercased with spaces turned into `_`, and each one becomes a `{{variable}}`. `name` defaults to first + last name. Sending it again for the same email updates the contact: new values replace old ones, blanks are ignored, and changing only `last_name` keeps the first name in the full name.

Import contacts on the **Contacts** page (or `POST /api/contacts/import`). Each row needs an email (`email` or `to` column). `name` is optional; without it, `first_name` + `last_name` are used. Every other column is stored as a field, with keys lowercased and spaces turned into `_`. Importing again matches contacts by email: new values update fields, and empty cells never erase them.

### Filtering contacts

On the **Contacts** page, sort by clicking a column (or pick any field in the Sort menu), and click **Filter** to add conditions. Conditions apply as you type, and you can match **all** or **any** of them. The quick filters cover common ones: never emailed, not emailed in 30 days, opened but never replied, and so on. Ticking the header box selects the page; the banner then offers **Select all N matching**, which selects everyone matching across all pages (untick anyone to leave them out). Add to list, remove from list, export and delete all work on that selection.

The API takes the same filter. `rules` is a JSON list of `{field, op, value}`:

| field | ops |
|---|---|
| `email`, `name`, `field:<name>` (any contact field) | `is`, `is_not`, `contains`, `not_contains`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty`, `gt`, `lt` (as numbers) |
| `sent_count` | `is`, `gt`, `lt` |
| `created_at`, `last_sent_at`, `last_reply_at` | `within_days`, `older_than_days` (value = days), `before`, `after` (value = date), `is_empty` (never), `is_not_empty` |
| `opened`, `replied`, `do_not_send` | `is` with `true` or `false` |
| `list`, `series` | `in`, `not_in` (name or id) |

`match=any` matches any rule instead of all. `sort` is `name`, `email`, `lists`, `sent_count`, `last_sent_at`, `created_at`, `updated_at` (default) or `field:<name>` (numbers sort by value), and `dir` is `asc` or `desc`. Bulk actions take `{"filter": {list, q, rules, match}, "exclude_ids": [...]}` instead of ids, so they apply to every match, not one page.

```bash
# Acme people we haven't emailed in a month, onto a list
curl -X POST "$URL/api/contacts/lists" -H "Authorization: Bearer $PASSCODE" -H 'content-type: application/json' -d '{
  "filter": { "rules": [ {"field":"field:company","op":"contains","value":"acme"},
                         {"field":"last_sent_at","op":"older_than_days","value":30} ] },
  "add": ["Acme re-engage"] }'
```

A contact can be on any number of lists. To send, open a list and click **Send to this list**, or choose **Send to lists** on the **Send** page. Each contact is emailed once even if they're on several of the chosen lists. Their fields fill the message's `{{variables}}`, and `contact_id` plus the fields go into the email's metadata, so reply webhooks can tie a reply back to the contact. Before you send, the page shows how many will get it and why the rest are skipped.

**Send a template to a growing list:** with a template, anyone who already has it queued or sent is skipped. Add new contacts to the list and send the same template again; only the new people get it. Without a template, a message goes to everyone on the list every time.

**Send to part of a list, in an order.** On the **Send** page, open **Filter, order and limit** under the lists:

- **Conditions** work like the Contacts filter: only matching contacts get it. **Send to this list** from a filtered Contacts view brings its conditions along.
- **Send order** is the order the emails are scheduled in. By default that's the order contacts joined the list; you can pick name, date added, emails sent, last emailed or any field, either way round. Numbers sort by value.
- **Only send to the first N** caps the send. It counts only people who can get it, so skipped contacts don't use up the limit. With a template, sending the same thing again reaches the next N, because the first ones already have it. That's an easy way to send a big list in daily batches.

The summary shows how many match, how many will get it, how many the limit holds back, and the first few names in order. Through the API, give `filter` (`{rules, match}`, the same rules as above), `sort` (`added_to_list` by default, or any contact sort key), `dir` and `limit`:

```bash
# The 200 highest-scoring pro users who haven't heard from us this month
curl -X POST "$URL/api/lists/send" -H "Authorization: Bearer $PASSCODE" -H 'content-type: application/json' -d '{
  "lists": ["Users"], "sender": "me", "template_id": "upgrade-offer", "auto_schedule": true,
  "filter": { "rules": [ {"field":"field:plan","op":"is","value":"pro"},
                         {"field":"last_sent_at","op":"older_than_days","value":30} ] },
  "sort": "field:score", "dir": "desc", "limit": 200 }'
```

**Overlapping sends.** A template reaches an address once, whichever list, mailbox or group it was sent through: anyone who has it queued, sending, sent or bounced is skipped (cancelled, failed and skipped ones can get it again). Different templates aren't checked against each other, so someone on two lists sent two templates gets both. To space those out, filter on **Last emailed** (for example, more than 7 days ago).

### AI personalization

Turn on **Personalize each email with AI** in a template, write instructions in plain words, and every email from that template is rewritten for its recipient just before it's sent: from the Send page, a list send, a series step, the API or MCP.

- **What the model sees:** the email as written for that person (template filled with their values), and their data as it is at that moment: every contact field (so your app can keep fields like `last_login`, `plan` or `sites` up to date with `POST /api/contacts`), their lists, how they've engaged (emails sent, last emailed, opened, replied), the email's own metadata, and today's date.
- **What it can do:** change the subject and body as the instructions say, keeping tone, links and HTML structure; fill any `{{variable}}` a contact is missing (for example a first name from `jane.doe@acme.com`); or answer *skip* with a reason, which marks the email skipped (`AI: logged in today`). While AI is on, a missing variable no longer skips the contact, and an email is never sent with a `{{placeholder}}` left in it.
- **If the AI fails** (no answer, bad JSON, a placeholder left in): *retry* tries again 5 minutes later, up to 3 times, then marks the email failed. *send* sends it as written, with missing values left blank.
- **Test with a contact** in the template editor: it shows the email as written and as personalized, side by side, with the model, the cost and the data it saw. It works on unsaved instructions. API: `POST /api/templates/personalize {template_id, contact, ai_prompt?}`; MCP `preview_personalization`.
- **Cost and model:** one call per email, on the app's AI model (Settings → AI) unless the template names another OpenRouter model. Each email records what happened (`ai.status`: personalized, skipped, fallback or failed), the model and the cost; you see it on the email.
- **System prompt:** a default system prompt frames every call (`GET /api/ai` → `personalization`). A template can replace it under **System prompt** in its AI section (`ai_system`; empty = the default). The skip and JSON answer format and today's date are always added after it, so a custom prompt can't break how answers are read.

```json
PATCH /api/templates/checkin-v1
{ "ai_enabled": true, "ai_on_error": "retry",
  "ai_prompt": "If first_name is missing, work it out from the email address. If last_login is within 7 days, mention what they did recently; if it's over 30 days ago, invite them back. If they logged in today, skip." }
```

### Templates

Create a template with a `template_id` (e.g. `intro-v1`, permanent), a subject and a body using `{{variables}}`. Its `columns` are `to` plus every variable; those are the contact fields a list send needs (or the `vars` an API send passes). To send it, use `template_id` and `vars` instead of `subject`/`body`:

```json
{ "auto_schedule": true, "emails": [
  { "mailbox": "me@company.com", "to": "jane@acme.com", "template_id": "intro-v1",
    "vars": { "first_name": "Jane", "company": "Acme" }, "campaign": "q4" } ] }
```

Rows are skipped (and listed in `skipped` with a reason) when:

- the address already has this template **scheduled, sending, sent or bounced** (`already received this template` / `template already scheduled for this address`),
- a required variable is blank (`missing value for …`),
- the same address appears twice in the upload.

Cancelled, failed and skipped emails don't count, so those people can be sent the template later. A partial unique index on `(template_id, to_email)` makes the rule hold even for concurrent uploads. Values inserted into an HTML body are HTML-escaped. Deleting a template keeps its email history, so re-creating the same `template_id` still skips everyone who got it. Unsent template emails can still be edited one by one.

### Auto-send

Send `{"emails": [...], "auto_schedule": true, "start_at": "<optional ISO time>"}`. Each email's `send_at` is ignored; instead every email gets the earliest time its mailbox allows, in list order:

- at least `throttle_minutes` after (and before) any other send from that mailbox, and
- no more than `daily_limit` sends in any rolling 24 hours, counting emails already sent in the last day and everything already queued.

Existing scheduled emails keep their times; the new batch fills the gaps around them. The response includes `plan: [{mailbox, count, first_send_at, last_send_at, daily_limit, throttle_minutes}]`. Use `GET /api/mailboxes/:id/plan?count=N` (or the `preview_schedule` MCP tool) to see the times first.

## Reply webhook

For every human reply (not auto-replies or bounces), the worker POSTs to the mailbox's webhook URL:

```http
POST <webhook_url>
content-type: application/json
x-outbound-event: reply | stop
x-outbound-category: <category name, when there is one>
x-outbound-signature: sha256=<hex HMAC-SHA256 of the raw body using the webhook secret>
```

```json
{
  "event": "reply.received",            // or "reply.stop"
  "mailbox": "me@company.com",
  "campaign": "q4-founders",
  "email": { "id": 12, "to": "jane@acme.com", "to_name": "Jane", "subject": "Quick question",
             "sent_at": "…", "open_count": 2, "metadata": { "crm_id": "123" } },
  "reply": { "id": 7, "from": "jane@acme.com", "from_name": "Jane", "subject": "Re: Quick question",
             "received_at": "…", "text": "Sounds good, Tuesday works.", "is_stop": false,
             "category": { "name": "interested", "description": "Positive reply: wants to talk…" },
             "category_source": "ai" },   // ai | rule (literal STOP) | manual; category is null if it couldn't be decided
  "thread_id": "18c…",
  "conversation": [
    { "role": "us",   "from": "me@company.com", "date": "…", "subject": "Quick question", "text": "Hi Jane…" },
    { "role": "them", "from": "jane@acme.com",  "date": "…", "subject": "Re: Quick question", "text": "Sounds good, Tuesday works." }
  ]
}
```

Non-2xx responses are retried with backoff (up to 6 attempts); status is visible in the UI and you can redeliver manually.

## Behaviour notes

- **Sending**: cron every minute, up to `SEND_BATCH` (default 20) emails per tick. Every mailbox has a `daily_limit` (1–2000, default 50, counted over any rolling 24 hours) and a `throttle_minutes` (1–1440, default 5). Neither can be empty or unlimited. The sender enforces both for every email, however it was scheduled: an email that hits a limit stays scheduled with a `waiting: …` reason and goes out at the next free slot. "Send now" skips the throttle but not the daily limit for the first 25 emails it sends straight away; with more selected, the rest become due and go out with the next runs, within both limits. On the **Emails** page, ticking the header box selects the page, and the banner then offers **Select all N matching**, so Cancel and Send now apply to every email matching the current tab and filters (untick any to leave them out). Gmail itself caps ~500/day (gmail.com) and ~2,000/day (Workspace). Failed sends retry twice, 5 minutes apart; auth failures flag the mailbox for reconnect.
- **Opens** are approximate: Apple Mail Privacy Protection and Gmail's image proxy can fetch the pixel without a human open, and viewing the message in your own Sent folder can load it too. Clients that block images never register.
- **Replies** are matched by Gmail thread, so only replies to emails sent by this service are picked up. If polling is down for more than about a week, Gmail's history cursor expires and replies in that gap are missed (the mailbox shows a warning).
- **Categories**: each human reply (not auto-replies or bounces) is sent to the model with a system prompt (the task, your outreach context, and the rule that any opt-out means `stop`), your category names and descriptions, the start of your original email, and the reply (clipped to 2,000 characters). It answers with one category name; anything else is rejected and the reply stays uncategorized. A literal `STOP` skips the model. If the model call fails, it's retried once before the webhook goes out; otherwise the webhook is sent with `category: null`. When the category is `stop` (from the model, the keyword, or you), the reply is treated as STOP: the sender and the original recipient go on the do-not-send list. Moving a reply away from `stop` does not take anyone off the list. The cost of each call is stored on the reply.
- **STOP** matching uses the first line of the reply with quoted text removed: `stop`, `unsubscribe`, `remove me`, `opt out` (short lines only, so "Please don't stop" doesn't count). Both the replier and the original recipient are added to the list.
- Cloudflare's **Workers Paid** plan is recommended for steady per-minute cron work (higher CPU and subrequest limits), though the free plan works at low volume.

## License

[MIT](LICENSE)
