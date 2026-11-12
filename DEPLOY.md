# Deploying cms-outbound

About 30–45 minutes. You need a Cloudflare account and a Google account (Gmail or Google Workspace) that you'll send from. All commands run from the `cms-outbound` folder.

- [Settings you can change in the app](#settings-you-can-change-in-the-app)
- [One-command deploys with tenant files](#one-command-deploys-with-tenant-files) — the quick way, once Google is set up
- [Part 1 — Cloudflare](#part-1--cloudflare)
- [Part 2 — Google OAuth (connect Gmail)](#part-2--google-oauth-connect-gmail)
- [Part 3 — Gmail push via Pub/Sub](#part-3--gmail-push-via-pubsub)
- [Part 4 — AWS SES mailbox (optional)](#part-4--aws-ses-mailbox-optional)
- [Part 5 — Check it end to end](#part-5--check-it-end-to-end)
- [Later: updates, logs, gotchas](#later-updates-logs-gotchas)

---

## Settings you can change in the app

After the first deploy, everything except the passcode can be set on the app's **Settings** page instead of with `wrangler secret put` or a redeploy: the Google client ID and secret, the OpenRouter API key, the Gmail Pub/Sub topic, emails per minute, and the public URL.

- A value saved in the app overrides the deploy-time value; **Clear** falls back to the deploy-time one. Each field shows where its current value comes from: *Set in app*, *From deploy*, or *Not set*.
- Secrets are write-only: the page shows whether one is set, never its value.
- Saving a Pub/Sub topic sets up Gmail push on every connected mailbox straight away.
- The **passcode** is deploy-only, since it's what gets you into the app.
- App-saved values live in the D1 database (encrypted at rest). Anyone with access to your Cloudflare account can read them in the D1 console or an export, whereas Worker secrets are hidden even there. Use whichever you prefer per value.

So the minimum deploy is: database, migrations, Worker, `PASSCODE`. Everything else can be pasted into Settings.

---

## One-command deploys with tenant files

Each deployment (a *tenant*) is one file, `tenants/<tenant>.env`, holding its Worker name, database, settings and secrets. Then:

```bash
npm run deploy:tenant -- <tenant>
```

That one command:

1. finds the tenant's D1 database, or creates it
2. writes a Wrangler config for it (`tenants/.build/<tenant>.wrangler.json`, based on `wrangler.toml`)
3. applies database migrations
4. deploys the Worker
5. uploads the secrets in the file
6. on a first deploy without `PUBLIC_URL`, sets it to the workers.dev URL and redeploys
7. prints the Google redirect URI, MCP URL and Pub/Sub push endpoint

**Start a new tenant**

```bash
cp tenants/example.env tenants/acme.env      # then fill it in
npm run deploy:tenant -- acme --dry-run      # check, changes nothing
npm run deploy:tenant -- acme
```

**Your existing deployment** is already in `tenants/main.env` (Worker and database `cms-outbound`). Its secrets are blank there, which means "leave what's set on the Worker"; fill them in to set or change them.

**Notes**

- Tenant files are gitignored (only `example.env` is committed) and hold real secrets, so keep them out of shared folders. `chmod 600 tenants/*.env` keeps them private to your user.
- Unknown keys are rejected, so a typo can't silently skip a setting.
- Each tenant needs its own Google OAuth redirect URI (Parts 2 and 3). One Google Cloud project and one OAuth client can serve several tenants: add each tenant's redirect URI to the same client, and give each tenant its own Pub/Sub push subscription on the same topic.
- Parts 1–3 below are the manual version of the same steps, and still explain the Google side.

---

## Part 1 — Cloudflare

**1. Log in**

```bash
npx wrangler login
```

**2. Create the database**

```bash
npx wrangler d1 create cms-outbound
```

Put the name and the `database_id` it prints into `wrangler.toml` (`database_name` and `database_id`). The binding must stay `DB`; the database itself can have any name. If wrangler offers to add the binding for you, check you still end up with one `[[d1_databases]]` block with `binding = "DB"`.

**3. Create the tables**

```bash
npm run db:migrate
```

Answer `y`. This applies `migrations/0001`–`0004` to the remote database.

**4. First deploy**

```bash
npm run deploy
```

It prints your URL, e.g. `https://cms-outbound.<your-subdomain>.workers.dev`. (On a brand-new Cloudflare account it first asks you to pick a workers.dev subdomain.) To use your own domain instead, add it under *Workers & Pages → cms-outbound → Settings → Domains & Routes*, and use that URL below.

**5. Set the public URL and redeploy**

In `wrangler.toml`:

```toml
PUBLIC_URL = "https://cms-outbound.<your-subdomain>.workers.dev"
```

```bash
npm run deploy
```

This URL goes into the tracking pixel, unsubscribe links and the Google redirect, so set it before connecting mailboxes. If you move to a custom domain later, change it here, redeploy, and update the Google redirect URI (Part 2, step 5).

**6. Secrets**

```bash
openssl rand -base64 24          # a strong passcode, if you want one generated
npx wrangler secret put PASSCODE
npx wrangler secret put OPENROUTER_API_KEY
```

Secrets apply immediately; no redeploy needed. The Google secrets come in Part 2.

**7. Sign in**

Open your URL and sign in with the passcode. Mailboxes will warn that Google isn't configured yet; that's next.

---

## Part 2 — Google OAuth (connect Gmail)

All in [console.cloud.google.com](https://console.cloud.google.com). Use one project for this part and Part 3.

**1. Create a project** — project picker → *New project* (e.g. `outbound`). Note its **project ID**.

**2. Enable the Gmail API** — *APIs & Services → Library* → search **Gmail API** → *Enable*.

**3. Set up the consent screen** — *Google Auth Platform* (or *APIs & Services → OAuth consent screen*):

- **Branding**: app name (e.g. "Outbound"), your support email, developer contact email.
- **Audience**:
  - Sending only from **Google Workspace** accounts in your own domain → choose **Internal**. Done; no review, tokens don't expire.
  - Sending from **@gmail.com** (or several domains) → choose **External**, add each sending address under *Test users*, then click **Publish app** (status "In production").

    Leaving it in "Testing" makes Google expire the connection every 7 days. Unpublished or unverified is fine for your own mailboxes; you'll click through a "Google hasn't verified this app" screen once per mailbox.
- **Data access** → *Add or remove scopes* → add `.../auth/gmail.send` and `.../auth/gmail.readonly` → *Update* → *Save*.

**4. Find the redirect URI** — in your app, open **MCP & API**. Copy the *Authorized redirect URI*: `https://<your URL>/oauth/google/callback`.

**5. Create the OAuth client** — *Google Auth Platform → Clients* (or *APIs & Services → Credentials*) → *Create client*:

- Application type: **Web application**
- Name: `outbound`
- Authorized redirect URIs: paste the URI from step 4
- *Create*, then copy the **Client ID** and **Client secret**

**6. Store them**

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**7. Connect each mailbox** — in the app: **Mailboxes → Connect Google mailbox** → choose the account → *Continue* (past the unverified warning, if shown) → allow both Gmail permissions. Repeat for each mailbox.

Then, on each mailbox card, set:

- **Max emails per day** and **Throttle** (defaults: 50/day, 5 minutes apart)
- **Reply webhook URL**, plus a **signing secret** if your API verifies the `x-outbound-signature` header

Replies already work at this point, through polling every minute. Part 3 makes them arrive instantly.

---

## Part 3 — Gmail push via Pub/Sub

Same Google Cloud project as Part 2.

**1. Enable Pub/Sub** — *APIs & Services → Library* → **Cloud Pub/Sub API** → *Enable*.

**2. Create a topic** — *Pub/Sub → Topics → Create topic*:

- Topic ID: `gmail-outbound`
- **Uncheck** "Add a default subscription"
- *Create*

The full topic name is `projects/<project-id>/topics/gmail-outbound`.

**3. Let Gmail publish to it** — open the topic → *Permissions* tab (or *Show info panel*) → *Add principal*:

- New principal: `gmail-api-push@system.gserviceaccount.com`
- Role: **Pub/Sub Publisher**
- *Save*

With the gcloud CLI instead:

```bash
gcloud pubsub topics add-iam-policy-binding gmail-outbound \
  --project=<project-id> \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

**"IAM policy update failed … Domain Restricted Sharing"?** Your Google organization only allows its own accounts in IAM, and Gmail's push account is Google's, not yours. Allow it for this one project, add the grant, then (optionally) restore the policy. You need the **Organization Policy Administrator** role (`roles/orgpolicy.policyAdmin`) on the organization; a Workspace super admin can grant it to themselves under *IAM & Admin → IAM* with the organization selected.

1. *IAM & Admin → Organization Policies*, with **this project** selected in the picker (not the organization).
2. Search for **Domain restricted sharing** (`iam.allowedPolicyMemberDomains`) → open it → **Manage policy**.
3. *Policy source*: **Override parent's policy** → *Policy enforcement*: **Replace** → **Add a rule** → *Policy values*: **Allow All** → **Set policy**.
4. Retry step 3 above (add `gmail-api-push@system.gserviceaccount.com` as Pub/Sub Publisher). Org policy changes can take a minute or two to apply.
5. Optional: go back to the policy → **Manage policy** → *Policy source*: **Inherit parent's policy** → **Set policy**. The grant you just added keeps working. Only *new* IAM edits in this project are restricted again. If you later edit the topic's permissions and hit the same error, repeat steps 3–5.

With gcloud (same permissions needed):

```bash
cat > /tmp/allow-all.yaml <<'YAML'
name: projects/<project-id>/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
  - allowAll: true
YAML
gcloud org-policies set-policy /tmp/allow-all.yaml
# …add the Pub/Sub Publisher grant (command above)…
gcloud org-policies delete iam.allowedPolicyMemberDomains --project=<project-id>   # optional: back to the inherited policy
```

If you can't change org policies at all, you can skip Pub/Sub: replies are still picked up by polling every minute.

**4. Copy the push endpoint** — in the app: **Mailboxes → Reply detection**. Copy the URL: `https://<your URL>/webhooks/gmail?token=…` (also on the Settings page, where you can regenerate the token).

**5. Create a push subscription** — *Pub/Sub → Subscriptions → Create subscription*:

- Subscription ID: `gmail-outbound-push`
- Topic: `gmail-outbound`
- Delivery type: **Push**
- Endpoint URL: paste the URL from step 4
- Authentication: leave **off** (the token in the URL is the check)
- Retry policy: *Retry after exponential backoff delay*
- *Create*

With gcloud:

```bash
gcloud pubsub subscriptions create gmail-outbound-push \
  --project=<project-id> \
  --topic=gmail-outbound \
  --push-endpoint="https://<your URL>/webhooks/gmail?token=<token>" \
  --ack-deadline=10
```

**6. Tell the Worker about the topic** — in `wrangler.toml`:

```toml
GMAIL_PUBSUB_TOPIC = "projects/<project-id>/topics/gmail-outbound"
```

```bash
npm run deploy
```

**7. Check it** — within about a minute, the cron job asks Gmail to watch each connected mailbox. On **Mailboxes**, each card should show **Push watch until** a date about 7 days out. The watch renews itself automatically.

If the card shows an error like `watch: ... User not authorized to perform this action`, step 3 is missing or hasn't taken effect yet. Fix it and wait a minute.

Polling every minute keeps running as a backup, so a missed push never loses a reply.

---

## Part 4 — AWS SES mailbox (optional)

Send through Amazon SES instead of Gmail, for example to customers or users who know you. SES has no inbox, so:

- **Replies:** every SES email gets a reply address like `reply+<token>@reply.example.com`. Cloudflare Email Routing hands mail for that subdomain to this Worker, which records the reply just like a Gmail reply (STOP, categories, webhooks). Optionally it forwards a copy to a human inbox.
- **Bounces and complaints:** SES publishes them to an SNS topic, which posts to this app. Hard bounces and spam complaints go on do-not-send automatically.

Your domain's DNS must be on Cloudflare (for the reply subdomain). Your normal mail, for example Google Workspace on `example.com`, is not affected.

**1. Verify your domain in SES.** In the SES console, pick a region (for example `us-east-1`), then *Verified identities → Create identity → Domain* → `example.com`, with **Easy DKIM** on. Add the three DKIM CNAME records it shows in Cloudflare DNS (set them to **DNS only**, not proxied). Wait until the identity shows **Verified**. With a verified domain you can send from any address on it.

**2. Get out of the sandbox.** New SES accounts can only email verified addresses. Go to *Account dashboard → Request production access* and describe who you email (people who know you) and how you handle bounces and complaints (they're added to do-not-send automatically). The app shows a sandbox warning on the mailbox until this is approved; click **Check account** afterwards.

**3. Create a send-only access key.** In IAM: *Users → Create user* (no console access), attach an inline policy like this (fill in region, account id, domain and configuration set name), then *Security credentials → Create access key → Application running outside AWS*:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": ["arn:aws:ses:us-east-1:123456789012:identity/example.com",
                   "arn:aws:ses:us-east-1:123456789012:configuration-set/outbound"] },
    { "Effect": "Allow", "Action": ["ses:GetAccount", "ses:GetEmailIdentity"], "Resource": "*" }
  ]
}
```

**4. Route the reply subdomain to the Worker.** In the Cloudflare dashboard → your domain → **Email → Email Routing**:

1. Enable Email Routing if it isn't already.
2. *Settings → Subdomains* → add `reply`. Cloudflare adds the MX and TXT records for `reply.example.com`.
3. *Routing rules → Catch-all address* → action **Send to a Worker** → `cms-outbound` → **Save**, and make sure it's enabled.
4. Optional, to forward copies of replies to a person: under *Destination addresses*, add and verify that inbox, then enter it as **Forward replies to** on the mailbox.

**5. Send bounce and complaint events to the app.** All in the same region as SES:

1. **SNS → Topics → Create topic.** Choose type *Standard* and name it e.g. `ses-events`.
2. **Create subscription.** Protocol **HTTPS**; endpoint is the URL in the app under **Settings → AWS SES events (SNS)**. Leave *raw message delivery* **off**. The app confirms the subscription automatically; refresh the SNS console to see **Confirmed**, and the Settings card shows the topic.
3. **SES → Configuration sets → Create set** (e.g. `outbound`) → *Event destinations → Add destination*. Event types: **Hard bounces, Complaints, Rejects** (optionally *Delivery delays*). Destination: **Amazon SNS**, topic `ses-events`.
4. Make sends use it: either enter `outbound` as the **Configuration set** on the mailbox in the app, or assign it as the default configuration set on your verified domain.

The app checks every SNS message's signature against Amazon's certificate and requires the token in the URL, so nobody else can add addresses to your do-not-send list.

**6. Add the mailbox in the app.** Go to *Mailboxes → Add AWS SES mailbox* and fill in: From address, From name, region, access key ID and secret, configuration set, reply domain (`reply.example.com`), and optionally a forward-to address. The app checks the keys and that the From address or its domain is verified before saving. Limits, templates, lists and auto-send work the same as for Gmail mailboxes.

**7. Test it.**

- Send yourself an email from the SES mailbox (in the sandbox, your address must be verified in SES). Reply to it: the reply shows up under **Replies** within seconds, and a copy arrives at the forward-to inbox if you set one.
- SES's mailbox simulator triggers real events without hurting your reputation. Send an email to `bounce@simulator.amazonses.com`: within a minute the email shows **Bounced** and the address appears on **Do-not-send** as *Hard bounce (SES)*. `complaint@simulator.amazonses.com` does the same for complaints.

---

## Part 5 — Check it end to end

1. **Send** → **Single email** from your mailbox to an address you control in another account, with the time left empty → **Send email**. It goes out within a minute; watch it on **Emails**.
2. Open the email in that other inbox. New Gmail mailboxes start as **Cold outreach**, which has no tracking pixel, so nothing shows as opened. To check open tracking, set the mailbox's **Purpose** tab to Newsletter (or turn on Open tracking there) before sending; the email's detail view then shows **Opened**. Gmail and Apple Mail may load the pixel through their own proxies, which is normal.
3. Reply with something like "Sounds good, can we talk Tuesday?". With push on, it appears in **Replies** within seconds, categorized (e.g. `interested`). If you set a webhook URL, the reply shows **Webhook delivered**.
4. Reply again with **STOP** → the sender appears under **Do-not-send**.
5. On **Reply categories**, fill in **About your outreach** and try a few replies in the *Try it* box.
6. Connect MCP (exact command on the **MCP & API** page):

   ```bash
   claude mcp add --transport http outbound https://<your URL>/mcp --header "Authorization: Bearer <PASSCODE>"
   ```

---

## Later: updates, logs, gotchas

**Ship changes**

```bash
npm run db:migrate   # only if there are new files in migrations/
npm run deploy
```

**Live logs**

```bash
npx wrangler tail
```

**See which secrets are set**

```bash
npx wrangler secret list
```

**Gotchas**

- **Changing the passcode** signs everyone out of the UI. It doesn't affect the Gmail push URL; that has its own token, which you can regenerate on the Settings page (then update the Pub/Sub subscription endpoint, Part 3 step 5).
- **Mailbox says "Auth failed, reconnect mailbox"**: the Google connection was revoked or expired (usually a consent screen still in *Testing*). Publish the app (Part 2, step 3), then click **Reconnect** on the mailbox.
- **Cloudflare plan**: the free plan works for low volume. The $5 Workers Paid plan gives more CPU time and subrequests per run, which helps once several mailboxes send and sync every minute.
- **Gmail's own limits**: about 500 sends a day for @gmail.com and 2,000 for Workspace. Keep each mailbox's daily limit well under that.
