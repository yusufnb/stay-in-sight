import { processDue, sendReply } from './sender';
import * as svc from './service';
import * as tmpl from './templates';
import * as contacts from './contacts';
import * as senders from './senders';
import * as groups from './groups';
import * as series from './series';
import { activity } from './activity';
import { previewPersonalization } from './personalize';
import * as cat from './categorize';
import { applyCategory, deliverWebhooks, recategorize, syncMailbox } from './sync';
import { readSettings, saveSettings } from './settings';
import { Env, HttpError } from './util';

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (env: Env, args: Json) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const emailSchema = obj(
  {
    sender: str('Sender key or id (see list_senders): picks the mailbox and fills From name, From address and Reply-To. Preferred over mailbox.'),
    mailbox: str('Mailbox email or id, if not using a sender (its default sender is used).'),
    to: str('Recipient email address'),
    to_name: str('Recipient display name'),
    subject: str('Subject line (omit when using template_id)'),
    body_html: str('HTML body. A tracking pixel is appended automatically.'),
    body_text: str('Plain-text body (used as the text/plain part; also converted to HTML if no body_html).'),
    send_at: str('When to send: ISO 8601 with timezone (e.g. 2026-11-12T09:30:00-05:00). Omit to send on the next minute tick. Ignored with auto_schedule. The mailbox throttle and daily limit always apply, so an email can go out later than this.'),
    campaign: str('Campaign name for grouping and stats'),
    from_name: str('From display name (defaults to the mailbox name)'),
    from_email: str('From address: the mailbox or one of its verified Gmail "Send mail as" aliases (see list_mailboxes send_as). Defaults to the mailbox\'s default From.'),
    reply_to: str('Reply-To address (defaults to the mailbox\'s default Reply-To). Replies are only tracked if they land in this mailbox.'),
    metadata: { type: 'object', description: 'Arbitrary JSON echoed back in reply webhooks (e.g. CRM ids)' },
    template_id: str('Send a saved template instead of subject/body. A template is sent to an address at most once: recipients who already have it queued or sent are skipped.'),
    vars: { type: 'object', description: 'With template_id: values for the template variables (its "columns"), e.g. {"first_name":"Jane","company":"Acme"}' },
    in_reply_to: num('Id of a sent email to answer in the same thread. to, subject ("Re: …"), mailbox, sender and From default to the conversation.'),
    group: str('Mailbox group (name or id) instead of sender/mailbox: sent from whichever member is free first, as its default sender. Always spread by the members\' limits and warm-up.'),
  },
  ['to'],
);

/** Narrowing and ordering a list send (send_to_lists, preview_list_send). */
const LIST_NARROW: Json = {
  filter: {
    type: 'object',
    description:
      'Only contacts matching these conditions: {rules, match?, q?}, same rules as list_contacts, e.g. {"rules":[{"field":"field:plan","op":"is","value":"pro"},{"field":"last_sent_at","op":"older_than_days","value":30}]}',
  },
  sort: str('Send order: added_to_list (default, the order they joined the lists), name, email, created_at, sent_count, last_sent_at, or field:<name> (numbers sort by value)'),
  dir: { type: 'string', enum: ['asc', 'desc'], description: 'asc (default) or desc' },
  limit: num('Send to at most this many: the first ones in order who can get it (skips don\'t count). With a template, sending again reaches the next ones.'),
};

const TOOLS: Tool[] = [
  {
    name: 'overview',
    description: 'Totals across everything: scheduled, due, sent, failed, opened, replied, do-not-send count, pending webhooks.',
    inputSchema: obj({}),
    run: (env) => svc.overview(env),
  },
  {
    name: 'get_settings',
    description:
      'App settings that override the deploy-time configuration: Google OAuth client, OpenRouter key, Gmail Pub/Sub topic, emails per minute, public URL. Secrets show only whether they are set. PASSCODE is deploy-only.',
    inputSchema: obj({}),
    run: (env) => readSettings(env),
  },
  {
    name: 'update_settings',
    description:
      'Change app settings. Pass only the keys to change; "" clears the app value so the deploy-time value applies again. Keys: APP_NAME, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OPENROUTER_API_KEY, GMAIL_PUBSUB_TOPIC, SEND_BATCH, PUBLIC_URL. Changing the topic re-points Gmail watches immediately.',
    inputSchema: obj({
      APP_NAME: str('Name shown in the header, browser tab and sign-in page (max 40)'),
      GOOGLE_CLIENT_ID: str('Google OAuth client ID'),
      GOOGLE_CLIENT_SECRET: str('Google OAuth client secret'),
      OPENROUTER_API_KEY: str('OpenRouter API key'),
      GMAIL_PUBSUB_TOPIC: str('projects/<project-id>/topics/<topic>'),
      SEND_BATCH: str('Emails per minute across all mailboxes (1-100)'),
      PUBLIC_URL: str('https://host'),
    }),
    run: async (env, a) => {
      const r = await saveSettings(env, a);
      return { changed: r.changed, watch: r.watch, settings: r.settings };
    },
  },
  {
    name: 'list_senders',
    description:
      'Senders you can send as: each has a key, a label, a description of WHEN to use it, and the From name, From address and Reply-To it applies. Read the descriptions to pick the right one, then pass its key as "sender".',
    inputSchema: obj({ mailbox: str('Only senders of this mailbox (email or id)') }),
    run: async (env, a) => ({ result: await senders.listSenders(env, a as never) }),
  },
  {
    name: 'save_sender',
    description:
      'Create a sender on a mailbox, or update one (by key). Write a clear description of when to use it. from_email must be the mailbox or one of its verified aliases (Gmail) / on a verified domain (SES).',
    inputSchema: obj(
      {
        key: str('Existing sender key to update; or the key for a new sender (auto-generated if omitted)'),
        mailbox: str('Mailbox email or id (required when creating)'),
        label: str('Short name, e.g. "Sam (Sales)"'),
        description: str('When to use this sender'),
        from_name: str('From name'),
        from_email: str('From address'),
        reply_to: str('Reply-To ("" removes it)'),
        is_default: { type: 'boolean', description: "Make it the mailbox's default sender" },
      },
    ),
    run: async (env, a) => {
      const exists = a.key ? await env.DB.prepare('SELECT 1 FROM senders WHERE key = ?').bind(String(a.key).toLowerCase()).first() : null;
      return exists ? senders.updateSender(env, String(a.key), { ...(a as Record<string, unknown>), key: undefined } as never) : senders.createSender(env, a as never);
    },
  },
  {
    name: 'delete_sender',
    description: "Delete a sender (not a mailbox's default). Emails already scheduled keep their From and Reply-To.",
    inputSchema: obj({ key: str('Sender key or id') }, ['key']),
    run: (env, a) => senders.deleteSender(env, String(a.key)),
  },
  {
    name: 'send_email',
    description:
      'Send one email right now as a sender (or schedule it with send_at). Use a template_id + vars, or subject + body. The sender fills From name, From address and Reply-To; override any of them here. Do-not-send and once-per-template rules apply. Respects the daily limit.',
    inputSchema: obj(
      {
        sender: str('Sender key or id (see list_senders)'),
        to: str('Recipient email'),
        to_name: str('Recipient name'),
        subject: str('Subject (omit with template_id)'),
        body: str('HTML or text body (omit with template_id)'),
        template_id: str('Saved template to send'),
        vars: { type: 'object', description: 'Template variables' },
        send_at: str('ISO 8601; omit to send now'),
        campaign: str('Campaign'),
        from_name: str('Override the sender From name'),
        from_email: str('Override the sender From address'),
        reply_to: str('Override the sender Reply-To'),
        metadata: { type: 'object', description: 'Echoed back in reply webhooks' },
        in_reply_to: num('Id of a sent email to answer in the same thread (see reply_to_email). Then sender and to are optional.'),
        group: str('Mailbox group instead of a sender: goes from the first member with a free slot (not instant if all are at their limits)'),
      },
    ),
    run: async (env, a) => {
      if (!a.in_reply_to && ((!a.sender && !a.group) || !a.to)) throw new HttpError(400, 'to and a sender or group are required (unless in_reply_to is given)');
      const r = await svc.scheduleEmails(env, [a as unknown as svc.ScheduleInput]);
      if (!r.scheduled.length) return { sent: false, skipped: r.skipped };
      const id = r.scheduled[0].id;
      if (a.send_at) return { sent: false, scheduled: r.scheduled[0] };
      const result = await processDue(env, [id]);
      const e = await svc.getEmailRow(env, id);
      return { sent: e.status === 'sent', email: svc.publicEmail(e), result };
    },
  },
  {
    name: 'reply_to_email',
    description:
      'Answer one of our sent emails in the same thread (In-Reply-To/References; same Gmail thread). Goes to whoever last replied (else the original recipient), subject "Re: …", from the same mailbox, sender, From and Reply-To. Sends now unless send_at is given. Use get_email or get_conversation first to read what they said.',
    inputSchema: obj(
      {
        email_id: num('The email to answer (ours, already sent)'),
        body: str('HTML or text body'),
        subject: str('Default "Re: <original subject>"'),
        to: str('Default: whoever last replied'),
        to_name: str('Recipient name'),
        sender: str('Different sender (same mailbox)'),
        from_name: str('Override From name'),
        reply_to: str('Override Reply-To'),
        send_at: str('ISO 8601; omit to send now'),
        metadata: { type: 'object', description: 'Echoed back in reply webhooks' },
      },
      ['email_id', 'body'],
    ),
    run: (env, a) => {
      const { email_id, ...rest } = a;
      return sendReply(env, Number(email_id), rest as never);
    },
  },
  {
    name: 'get_activity',
    description:
      'Everything that happened with one person, newest first: every email sent or queued to them (mailbox, sender, campaign, series step, opens), their replies with text and category, list joins, series enrollments and stops, and do-not-send. Use it before writing to someone, to see what they have already heard from us.',
    inputSchema: obj({ email: str('Email address, or a contact id'), limit: num('Most recent events to return (default 100)') }, ['email']),
    run: async (env, a) => {
      const r = await activity(env, a.email as string);
      const n = Math.max(1, Number(a.limit) || 100);
      return { ...r, events: r.events.slice(0, n), more_events: Math.max(0, r.events.length - n) };
    },
  },
  {
    name: 'list_series',
    description:
      'Series (drip campaigns): template emails sent one after another, with a delay in days, to everyone on the attached lists. Contacts added to a list later start at step 1; steps added later reach everyone. Shows steps (with their day), lists, sender, and how many people are in progress, completed or stopped.',
    inputSchema: obj({}),
    run: (env) => series.listSeries(env),
  },
  {
    name: 'save_series',
    description:
      'Create a series, or update one (give series = its id or name). Needs a sender (key) or a mailbox group. lists replaces the attached lists; use {"list": "Name", "only_new": true} to enroll only people added from now on. When creating you can pass steps. active: false pauses it.',
    inputSchema: obj({
      series: str('Existing series id or name to update; omit to create'),
      name: str('Series name'),
      description: str('What it is for'),
      sender: str('Sender key or id to send as'),
      group: str('Or a mailbox group to send through'),
      campaign: str('Campaign name for its emails (default: the series name)'),
      stop_on_reply: { type: 'boolean', description: "Stop someone's series when they reply" },
      active: { type: 'boolean', description: 'false pauses the series' },
      lists: { type: 'array', items: {}, description: 'List names/ids, or {"list": "...", "only_new": true}' },
      steps: {
        type: 'array',
        description: 'Only when creating: steps in order',
        items: obj({ template_id: str('Existing template'), subject: str('Or a new template: subject'), body: str('and body'), delay_days: num('Days after the previous email (step 1: after joining)') }),
      },
    }),
    run: (env, a) => {
      const { series: ref, ...rest } = a;
      return ref ? series.updateSeries(env, ref as string, rest as never) : series.createSeries(env, rest as never);
    },
  },
  {
    name: 'save_series_step',
    description:
      'Add a step to a series, or change one (give step = its id). Use an existing template_id, or subject + body to create a template for it ({{variables}} come from contact fields). delay_days: step 1 = days after joining, later steps = days after the previous email went out. A new step reaches everyone who has not had it, including people who finished.',
    inputSchema: obj(
      {
        series: str('Series id or name'),
        step: num('Step id to change; omit to add'),
        template_id: str('Existing template'),
        subject: str('Subject (new template, or edits the step template)'),
        body: str('Body (new template, or edits the step template)'),
        delay_days: num('0-365'),
        position: num('1-based position'),
      },
      ['series'],
    ),
    run: (env, a) => {
      const { series: ref, step, ...rest } = a;
      return step ? series.updateStep(env, ref as string, step as number, rest as never) : series.addStep(env, ref as string, rest as never);
    },
  },
  {
    name: 'delete_series_step',
    description: 'Remove a step from a series. Its emails that have not gone out are cancelled and people move on to the next step.',
    inputSchema: obj({ series: str('Series id or name'), step: num('Step id') }, ['series', 'step']),
    run: (env, a) => series.deleteStep(env, a.series as string, a.step as number),
  },
  {
    name: 'delete_series',
    description: 'Delete a series and cancel its unsent emails. Sent emails and templates stay.',
    inputSchema: obj({ series: str('Series id or name') }, ['series']),
    run: (env, a) => series.deleteSeries(env, a.series as string),
  },
  {
    name: 'list_series_enrollments',
    description: 'Who is in a series and where they are: steps done, next step and when it is due, or why they stopped.',
    inputSchema: obj(
      {
        series: str('Series id or name'),
        status: { type: 'string', enum: ['in_progress', 'completed', 'stopped', 'not_on_list'] },
        q: str('Search email or name'),
        limit: num('Default 100'),
        offset: num('Offset'),
      },
      ['series'],
    ),
    run: (env, a) => {
      const { series: ref, ...rest } = a;
      return series.listEnrollments(env, ref as string, rest as never);
    },
  },
  {
    name: 'set_series_enrollment',
    description: "Stop one person's series (their unsent series email is cancelled), or let them carry on where they left off.",
    inputSchema: obj({ series: str('Series id or name'), enrollment: num('Enrollment id (list_series_enrollments)'), status: { type: 'string', enum: ['active', 'stopped'] } }, ['series', 'enrollment', 'status']),
    run: (env, a) => series.setEnrollment(env, a.series as string, a.enrollment as number, { status: a.status as 'active' | 'stopped' }),
  },
  {
    name: 'list_groups',
    description:
      'Mailbox groups: several mailboxes that send as one (mainly for cold outreach). Shows members, which are warming up, each one\'s limit today, and the group\'s total capacity today. Send through a group with group: "<name>" on schedule_emails, send_to_lists or send_email.',
    inputSchema: obj({}),
    run: (env) => groups.listGroups(env),
  },
  {
    name: 'save_group',
    description: 'Create a mailbox group, or update one (by id or current name). mailboxes replaces the membership; a mailbox is in at most one group, so adding it here moves it.',
    inputSchema: obj({
      group: str('Existing group id or name to update; omit to create'),
      name: str('Group name'),
      description: str('What it is for'),
      mailboxes: { type: 'array', items: { type: 'string' }, description: 'Member mailbox emails or ids' },
    }),
    run: (env, a) => {
      const { group, ...rest } = a;
      return group ? groups.updateGroup(env, group as string, rest as never) : groups.createGroup(env, rest as never);
    },
  },
  {
    name: 'delete_group',
    description: 'Delete a mailbox group. Its mailboxes stay; emails already scheduled keep their mailbox.',
    inputSchema: obj({ group: str('Group id or name') }, ['group']),
    run: (env, a) => groups.deleteGroup(env, a.group as string),
  },
  {
    name: 'list_mailboxes',
    description:
      'List mailboxes you can send from. Each has a purpose: outreach (cold 1:1 email), newsletter (bulk mail to people who signed up) or conversation (back-and-forth replies). Pick the mailbox whose purpose fits the job. Also shows how mail is built (format), limits and webhook settings.',
    inputSchema: obj({}),
    run: (env) => svc.listMailboxes(env),
  },
  {
    name: 'add_ses_mailbox',
    description:
      'Add an AWS SES mailbox to send from. Checks the keys and that the From address (or its domain) is verified in SES. Replies come back to reply+<token>@<reply_domain>, which must be routed to this Worker by Cloudflare Email Routing (catch-all → Worker).',
    inputSchema: obj(
      {
        email: str('From address (verified in SES, or on a verified domain)'),
        name: str('From name'),
        region: str('SES region, e.g. us-east-1'),
        access_key_id: str('IAM access key id (send-only policy recommended)'),
        secret_access_key: str('IAM secret access key'),
        configuration_set: str('SES configuration set whose events go to SNS → /webhooks/ses (optional)'),
        reply_domain: str('Subdomain routed to this Worker by Cloudflare Email Routing, e.g. reply.example.com'),
        forward_to: str('Also forward each reply to this inbox (must be a verified Email Routing destination)'),
        purpose: { type: 'string', enum: ['outreach', 'newsletter', 'conversation'], description: 'What it is for (default newsletter)' },
      },
      ['email', 'region', 'access_key_id', 'secret_access_key', 'reply_domain'],
    ),
    run: (env, a) => svc.createSesMailbox(env, a as never),
  },
  {
    name: 'check_ses_mailbox',
    description: "Re-check an SES mailbox: keys valid, sending enabled, sandbox or production, daily quota, verified identity.",
    inputSchema: obj({ mailbox: str('Mailbox email or id') }, ['mailbox']),
    run: (env, a) => svc.recheckSes(env, a.mailbox as string),
  },
  {
    name: 'update_mailbox',
    description:
      'Update a mailbox: purpose and mail format, From name, default From address (alias), default Reply-To, reply webhook URL/secret, daily limit, throttle, active flag. The purpose sets defaults for open tracking, the unsubscribe header and the footer; set those to override, or null to go back to the purpose default.',
    inputSchema: obj(
      {
        mailbox: str('Mailbox email or id'),
        name: str('Default From display name'),
        webhook_url: str('URL that receives a POST for each reply (empty string to clear)'),
        webhook_secret: str('Secret used to sign webhook bodies (x-outbound-signature: sha256=HMAC)'),
        daily_limit: num('Max emails per rolling 24 hours (1-2000)'),
        throttle_minutes: num('Minimum minutes between two sends from this mailbox (1-1440)'),
        from_email: str('Default From address: the mailbox or a verified alias (list_mailboxes → send_as). "" resets to the mailbox address.'),
        reply_to: str('Default Reply-To address. "" removes it. (For SES mailboxes, leave empty so replies are tracked.)'),
        reply_domain: str('SES only: reply subdomain routed to this Worker'),
        forward_to: str('SES only: also forward replies to this inbox ("" stops forwarding)'),
        ses_region: str('SES only'),
        ses_access_key_id: str('SES only: new access key id'),
        ses_secret_access_key: str('SES only: new secret access key'),
        ses_configuration_set: str('SES only ("" removes it)'),
        active: { type: 'boolean' },
        purpose: { type: 'string', enum: ['outreach', 'newsletter', 'conversation'], description: 'outreach: cold 1:1 (no pixel, no unsubscribe header, "reply stop" footer, uneven spacing). newsletter: bulk to subscribers (pixel, one-click unsubscribe, list headers). conversation: replies (plain, threaded, only hard opt-outs block).' },
        track_opens: { type: ['boolean', 'null'], description: 'Tracking pixel; null = purpose default' },
        list_unsubscribe: { type: ['boolean', 'null'], description: 'List-Unsubscribe headers; null = purpose default' },
        footer: { type: ['string', 'null'], description: 'Plain-text footer added to every email; {{unsubscribe_url}} is replaced. "" = no footer, null = purpose default. Include a postal address for commercial email.' },
        warmup: { type: 'boolean', description: 'Warm-up: the daily limit starts at warmup_start and grows by warmup_step each day until it reaches daily_limit. Turning it on starts day 1 now.' },
        warmup_start: num('Emails a day on day 1 of warm-up (1-500, default 5)'),
        warmup_step: num('Extra emails a day each day of warm-up (1-200, default 3)'),
        warmup_restart: { type: 'boolean', description: 'Start the warm-up again from day 1' },
        group: { type: ['string', 'null'], description: 'Put the mailbox in this group (name or id); null or "" removes it from its group' },
      },
      ['mailbox'],
    ),
    run: (env, a) => svc.updateMailbox(env, a.mailbox as string, a as never),
  },
  {
    name: 'schedule_emails',
    description:
      'Schedule one or more emails (max 1000). Give each a "sender" (see list_senders) or a "mailbox". Recipients on the do-not-send list are skipped and reported. Returns created ids. ' +
      'With auto_schedule=true, per-email send_at is ignored and each email gets the earliest slot its mailbox allows ' +
      '(throttle + daily limit, around emails already queued); the response includes the plan with first/last send times.',
    inputSchema: obj(
      {
        emails: { type: 'array', items: emailSchema, minItems: 1 },
        auto_schedule: { type: 'boolean', description: 'Spread sends automatically using each mailbox\'s throttle and daily limit' },
        start_at: str('With auto_schedule: earliest send time (ISO 8601). Default now.'),
      },
      ['emails'],
    ),
    run: (env, a) => svc.scheduleEmails(env, a.emails as svc.ScheduleInput[], { auto: !!a.auto_schedule, start_at: a.start_at as string }),
  },
  {
    name: 'preview_schedule',
    description:
      'Preview when N auto-scheduled emails would go out from a mailbox or a mailbox group, given throttles, daily limits, warm-up and the current queue. For a group, also how many each mailbox takes. Schedules nothing.',
    inputSchema: obj({ mailbox: str('Mailbox email or id'), group: str('Or a mailbox group (name or id)'), count: num('How many emails'), start_at: str('Earliest send time (ISO 8601)') }, ['count']),
    run: async (env, a) => {
      if (!a.mailbox && !a.group) throw new HttpError(400, 'mailbox or group is required');
      const p = a.group ? await svc.previewGroupPlan(env, a.group as string, Number(a.count), a.start_at as string) : await svc.previewPlan(env, a.mailbox as string, Number(a.count), a.start_at as string);
      return { ...p, slots: p.slots.length > 50 ? [...p.slots.slice(0, 25), '…', ...p.slots.slice(-25)] : p.slots };
    },
  },
  {
    name: 'list_templates',
    description: 'List saved templates with their required columns and send stats (sent, scheduled, opened, replied).',
    inputSchema: obj({}),
    run: (env) => tmpl.listTemplates(env),
  },
  {
    name: 'get_template',
    description: 'Get one template: subject, body, required columns and stats.',
    inputSchema: obj({ template_id: str('Template id') }, ['template_id']),
    run: (env, a) => tmpl.getTemplate(env, String(a.template_id)),
  },
  {
    name: 'save_template',
    description:
      'Create a template, or update an existing one\'s name/subject/body. Use {{variable}} placeholders; the required CSV columns are derived from them. ' +
      'template_id is permanent (letters, numbers, . _ -) and is what stops the same template reaching an address twice.',
    inputSchema: obj(
      {
        template_id: str('Template id, e.g. "intro-v1"'),
        name: str('Display name'),
        subject: str('Subject with {{variables}}'),
        body: str('HTML or plain-text body with {{variables}}'),
        ai_enabled: { type: 'boolean', description: "Rewrite each email with AI just before it's sent, using the contact's data and ai_prompt. Missing {{variables}} no longer skip a contact: the AI fills them in." },
        ai_prompt: str('What the AI should change, e.g. "Work out the first name from the email address if first_name is missing. If last_login is within 7 days, mention their recent activity; if over 30 days ago, invite them back. If they logged in today, skip."'),
        ai_model: str('OpenRouter model id (default: the app AI model)'),
        ai_on_error: { type: 'string', enum: ['retry', 'send'], description: 'If the AI fails: retry (then fail), or send as written' },
        ai_system: str('Rarely needed: replaces the default personalization system prompt for this template ("" = default). The skip/JSON answer format and today\'s date are always added after it.'),
      },
      ['template_id'],
    ),
    run: async (env, a) => {
      const id = String(a.template_id);
      const exists = await env.DB.prepare('SELECT 1 FROM templates WHERE template_id = ?').bind(id.trim().toLowerCase()).first();
      return exists ? tmpl.updateTemplate(env, id, a as never) : tmpl.createTemplate(env, a as never);
    },
  },
  {
    name: 'preview_personalization',
    description:
      'Test a template\'s AI personalization on one contact without sending: returns the email as written for them (draft), the data the AI saw, and the AI result (new subject/body, or skip with a reason, or an error) with its cost. Pass ai_prompt/subject/body to try changes before saving them.',
    inputSchema: obj(
      {
        template_id: str('Template to test (or give subject and body)'),
        contact: str('Contact email or id to test with'),
        ai_prompt: str('Instructions to try instead of the saved ones'),
        ai_model: str('Model to try'),
        ai_system: str('System prompt to try ("" = the default)'),
        subject: str('Subject to try'),
        body: str('Body to try'),
        vars: { type: 'object', description: 'Extra values for this email (like list-send metadata)' },
      },
      ['contact'],
    ),
    run: (env, a) => previewPersonalization(env, (a.template_id as string) || null, a as never),
  },
  {
    name: 'check_template_recipients',
    description: 'Before sending a template, see which addresses already have it queued or sent (they would be skipped).',
    inputSchema: obj({ template_id: str('Template id'), emails: { type: 'array', items: { type: 'string' } } }, ['template_id', 'emails']),
    run: (env, a) => tmpl.checkTemplateRecipients(env, String(a.template_id), a.emails as string[]),
  },
  {
    name: 'list_lists',
    description: 'Contact lists with how many contacts each has. A contact can be on several lists.',
    inputSchema: obj({}),
    run: (env) => contacts.listLists(env),
  },
  {
    name: 'list_contacts',
    description:
      'Contacts, filtered and sorted. Each has email, name, fields (other columns), lists, emails sent, last emailed and do-not-send. Filter with list, a search, and rules (e.g. company contains "acme", not emailed in 30 days, never replied, not on a list). total is the full count.',
    inputSchema: obj({
      list: str('List name or id'),
      email: str('Exact email address'),
      q: str('Search email, name or fields'),
      rules: {
        type: 'array',
        description:
          'Conditions, e.g. {"field":"field:company","op":"contains","value":"acme"}, {"field":"last_sent_at","op":"older_than_days","value":30}, {"field":"replied","op":"is","value":false}, {"field":"list","op":"not_in","value":"Customers"}. Fields: email, name, field:<name>, sent_count, created_at, last_sent_at, last_reply_at, opened, replied, do_not_send, list, series. Ops: is, is_not, contains, not_contains, starts_with, ends_with, is_empty, is_not_empty, gt, lt (text/number); within_days, older_than_days, before, after, is_empty (dates); is true/false (opened, replied, do_not_send); in, not_in (list, series).',
        items: obj({ field: str('Field'), op: str('Operator'), value: {} }, ['field', 'op']),
      },
      match: { type: 'string', enum: ['all', 'any'], description: 'all (default) or any of the rules' },
      sort: str('name, email, lists, sent_count, last_sent_at, created_at, updated_at (default), or field:<name>'),
      dir: { type: 'string', enum: ['asc', 'desc'] },
      limit: num('Default 100, max 500'),
      offset: num('Offset'),
    }),
    run: (env, a) => contacts.listContacts(env, a as never),
  },
  {
    name: 'save_contact',
    description:
      'Add one contact, or update it if the email exists. Give email plus any attributes (first_name, last_name, company, title, phone, …); every attribute is usable as {{variable}} in templates. name defaults to first + last name. Blanks never erase existing values. Optional lists to put them on.',
    inputSchema: {
      type: 'object',
      properties: {
        email: str('Email address (required)'),
        first_name: str('First name'),
        last_name: str('Last name'),
        name: str('Full name (defaults to first + last)'),
        lists: { type: 'array', items: { type: 'string' }, description: 'List names to add them to (created if missing)' },
        fields: { type: 'object', description: 'Any other attributes, e.g. {"company":"Acme","title":"CTO"}' },
      },
      required: ['email'],
      additionalProperties: { type: 'string' },
    },
    run: (env, a) => contacts.saveContact(env, a),
  },
  {
    name: 'get_contact',
    description: 'One contact by id or email: name, all fields, lists, do-not-send flag, and the emails sent to them.',
    inputSchema: obj({ id: num('Contact id'), email: str('Contact email') }),
    run: async (env, a) => contacts.getContact(env, await contacts.contactId(env, a as never)),
  },
  {
    name: 'update_contact',
    description:
      'Edit a contact by id or email. "set" adds or changes fields ({"title":"CEO"}; an empty value removes that field), "remove" deletes fields by name, "fields" replaces all fields at once, "name" changes the display name.',
    inputSchema: obj({
      id: num('Contact id'),
      email: str('Contact email'),
      name: str('Display name'),
      set: { type: 'object', description: 'Fields to add or change' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Field names to delete' },
      fields: { type: 'object', description: 'Replace ALL fields with this set' },
    }),
    run: async (env, a) => {
      const { id, email, ...patch } = a as { id?: number; email?: string };
      return contacts.updateContact(env, await contacts.contactId(env, { id, email }), patch as never);
    },
  },
  {
    name: 'delete_contacts',
    description: 'Permanently delete contacts by id, email, or everyone matching a filter (removed from all lists). Emails already sent to them stay in history. Prefer dnc_add to just stop emailing someone.',
    inputSchema: obj({
      ids: { type: 'array', items: { type: 'number' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: { type: 'object', description: 'Everyone matching this filter: {list?, q?, rules?, match?}' },
      exclude_ids: { type: 'array', items: { type: 'number' } },
    }),
    run: (env, a) => contacts.deleteContacts(env, (a.ids as number[]) || [], (a.emails as string[]) || [], { filter: a.filter as never, exclude_ids: a.exclude_ids as number[] }),
  },
  {
    name: 'save_list',
    description: 'Create a list, or rename / re-describe an existing one (by name or id).',
    inputSchema: obj({ name: str('List name (or id) to create or update'), rename_to: str('New name'), description: str('Description') }, ['name']),
    run: async (env, a) => {
      const existing = await contacts.resolveLists(env, [a.name as string]).catch(() => []);
      if (existing.length) return contacts.updateList(env, existing[0].id, { name: a.rename_to as string | undefined, description: a.description as string | undefined });
      return contacts.createList(env, { name: (a.rename_to as string) || (a.name as string), description: a.description as string | undefined });
    },
  },
  {
    name: 'delete_list',
    description: 'Delete a list (by name or id). Its contacts are kept; they just leave this list.',
    inputSchema: obj({ name: str('List name or id') }, ['name']),
    run: (env, a) => contacts.deleteList(env, a.name as string),
  },
  {
    name: 'import_contacts',
    description:
      'Add or update contacts (matched by email) and put them on lists (created if missing). Each row needs an "email" (or "to") value; "name" is optional; every other key is stored as a field usable as {{variable}} in templates. Blank values never erase existing ones. Max 5000 rows.',
    inputSchema: obj(
      { rows: { type: 'array', items: { type: 'object' }, minItems: 1 }, lists: { type: 'array', items: { type: 'string' }, description: 'List names to add everyone to' } },
      ['rows'],
    ),
    run: (env, a) => contacts.importContacts(env, a as never),
  },
  {
    name: 'set_contact_lists',
    description:
      'Add existing contacts (by id, email, or everyone matching a filter) to lists, created if missing, and/or remove them from lists. To add people who aren\'t contacts yet, use import_contacts with lists.',
    inputSchema: obj({
      ids: { type: 'array', items: { type: 'number' } },
      emails: { type: 'array', items: { type: 'string' } },
      filter: { type: 'object', description: 'Everyone matching this filter: {list?, q?, rules?, match?} (same as list_contacts)' },
      exclude_ids: { type: 'array', items: { type: 'number' }, description: 'With filter: leave these out' },
      add: { type: 'array', items: { type: 'string' }, description: 'List names to add to' },
      remove: { type: 'array', items: { type: 'string' }, description: 'List names to remove from' },
    }),
    run: (env, a) => contacts.setContactLists(env, a as never),
  },
  {
    name: 'preview_list_send',
    description:
      'Before sending to lists: how many contacts would get it, how many are skipped (do-not-send, already received the template, missing a variable), how many are held back by limit, and the first few in send order. Takes the same filter, sort and limit as send_to_lists. Sends nothing.',
    inputSchema: obj(
      { lists: { type: 'array', items: { type: 'string' }, minItems: 1 }, template_id: str('Saved template'), subject: str('Subject, if not using a template'), body: str('Body, if not using a template'), ...LIST_NARROW },
      ['lists'],
    ),
    run: async (env, a) => {
      const p = await contacts.previewListSend(env, a as never);
      return { ...p, sample: undefined };
    },
  },
  {
    name: 'send_to_lists',
    description:
      'Schedule an email to contacts on one or more lists (each contact once): everyone, or only those matching filter, in the order given by sort, up to limit. With template_id, anyone who already has that template queued or sent is skipped, so re-sending to a growing list reaches only the new contacts, and re-sending with a limit reaches the next ones. Contact fields fill {{variables}}.',
    inputSchema: obj(
      {
        lists: { type: 'array', items: { type: 'string' }, minItems: 1 },
        sender: str('Sender key or id (see list_senders)'),
        mailbox: str('Mailbox email or id, if not using a sender'),
        group: str('Mailbox group (name or id): spread across its mailboxes by their limits and warm-up (always auto-planned). Best for cold outreach.'),
        template_id: str('Saved template (recommended)'),
        subject: str('Subject, if not using a template'),
        body: str('Body, if not using a template'),
        campaign: str('Campaign name'),
        from_name: str('From name'),
        from_email: str('From address (mailbox or verified alias)'),
        reply_to: str('Reply-To'),
        auto_schedule: { type: 'boolean', description: 'Spread sends by the mailbox throttle and daily limit (recommended)' },
        start_at: str('With auto_schedule: earliest send time (ISO 8601)'),
        send_at: str('Without auto_schedule: first send time (ISO 8601)'),
        interval_minutes: num('Without auto_schedule: minutes between sends'),
        ...LIST_NARROW,
      },
      ['lists'],
    ),
    run: async (env, a) => {
      const r = await contacts.sendToLists(env, a as never);
      return { ...r, emails: r.emails.length > 50 ? `${r.emails.length} emails` : r.emails };
    },
  },
  {
    name: 'list_emails',
    description: 'List scheduled/sent emails. Scheduled ones come first (soonest first), then most recently sent.',
    inputSchema: obj({
      campaign: str('Filter by campaign ("(none)" for emails without a campaign)'),
      status: str('Comma-separated: scheduled,sending,sent,failed,skipped,cancelled,bounced'),
      mailbox: str('Mailbox email or id'),
      to: str('Recipient email'),
      q: str('Search recipient/subject'),
      opened: { type: 'boolean', description: 'Only emails opened at least once' },
      replied: { type: 'boolean', description: 'Only emails with a reply' },
      sender: str('Only emails sent as this sender (key or id)'),
      template: str('Only emails sent from this template_id'),
      purpose: { type: 'string', enum: ['outreach', 'newsletter', 'conversation'], description: 'Only emails from mailboxes with this purpose' },
      group: str('Only emails sent through this mailbox group (name or id)'),
      series: str('Only emails from this series (name or id)'),
      limit: num('Default 100, max 500'),
      offset: num('Pagination offset'),
    }),
    run: (env, a) => svc.listEmails(env, a as svc.EmailFilter),
  },
  {
    name: 'get_email',
    description: 'Full details for one email including body, opens and recorded replies.',
    inputSchema: obj({ id: num('Email id') }, ['id']),
    run: (env, a) => svc.getEmail(env, Number(a.id)),
  },
  {
    name: 'update_email',
    description: 'Edit or reschedule an email that has not been sent (also re-queues cancelled/failed emails).',
    inputSchema: obj(
      {
        id: num('Email id'),
        send_at: str('New send time (ISO 8601)'),
        subject: str('Subject'),
        body_html: str('HTML body'),
        body_text: str('Text body'),
        campaign: str('Campaign'),
        mailbox: str('Mailbox email or id'),
        to_name: str('Recipient name'),
        from_name: str('From name'),
        from_email: str('From address (mailbox or verified alias)'),
        reply_to: str('Reply-To address ("" removes it)'),
      },
      ['id'],
    ),
    run: (env, a) => svc.updateScheduledEmail(env, Number(a.id), a as never),
  },
  {
    name: 'cancel_emails',
    description:
      'Cancel scheduled (unsent) emails: by ids, by everyone matching a filter (same filter as list_emails, across all pages; exclude_ids leaves some out), or by campaign and/or recipient.',
    inputSchema: obj({
      ids: { type: 'array', items: { type: 'number' } },
      filter: { type: 'object', description: 'Every scheduled email matching this list_emails filter, e.g. {"campaign":"q4","mailbox":"me@x.com"} or {"template":"intro","q":"acme.com"}' },
      exclude_ids: { type: 'array', items: { type: 'number' }, description: 'With filter: leave these out' },
      campaign: str('Campaign name'),
      to: str('Recipient email'),
    }),
    run: (env, a) => svc.cancelEmails(env, a as never),
  },
  {
    name: 'send_now',
    description: `Send scheduled emails now instead of waiting: by ids, or every scheduled email matching a filter (same as list_emails). The first ${svc.SEND_NOW_DIRECT} go straight away; the rest become due now and go out over the next minutes, still within each mailbox's daily limit and spacing (queued).`,
    inputSchema: obj({
      ids: { type: 'array', items: { type: 'number' } },
      filter: { type: 'object', description: 'Every scheduled email matching this list_emails filter' },
      exclude_ids: { type: 'array', items: { type: 'number' }, description: 'With filter: leave these out' },
    }),
    run: (env, a) => svc.sendNow(env, a as never, (ids) => processDue(env, ids)),
  },
  {
    name: 'list_replies',
    description: 'List replies received to sent emails (newest first), with their AI category. kind: reply | stop | auto | bounce.',
    inputSchema: obj({
      campaign: str('Campaign'),
      mailbox: str('Mailbox email or id'),
      kind: str('reply, stop, auto or bounce'),
      category: str('Only replies in this category (see list_categories); "(none)" for uncategorized'),
      since: str('ISO time; only replies received after this'),
      purpose: { type: 'string', enum: ['outreach', 'newsletter', 'conversation'], description: 'Only replies to mailboxes with this purpose' },
      group: str('Only replies to emails sent through this mailbox group'),
      limit: num('Default 100'),
      offset: num('Offset'),
    }),
    run: (env, a) => svc.listReplies(env, a as never),
  },
  {
    name: 'list_categories',
    description: 'Reply categories the AI categorizer chooses from (name + description), with reply counts, plus the categorizer settings (model, outreach context, full system prompt). "stop" always exists and adds the sender to do-not-send.',
    inputSchema: obj({}),
    run: async (env) => ({ ai: await cat.aiConfig(env), categories: await cat.listCategories(env) }),
  },
  {
    name: 'save_category',
    description: 'Create a reply category, or change an existing one\'s description (the model reads it to decide) or name. "stop" can\'t be renamed.',
    inputSchema: obj({ name: str('Category name, e.g. "new_site"'), description: str('When a reply belongs here'), rename_to: str('New name (optional)') }, ['name', 'description']),
    run: (env, a) => cat.saveCategory(env, a as never),
  },
  {
    name: 'delete_category',
    description: 'Delete a reply category (not "stop"). Past replies keep their label.',
    inputSchema: obj({ name: str('Category name') }, ['name']),
    run: (env, a) => cat.deleteCategory(env, String(a.name)),
  },
  {
    name: 'set_categorizer',
    description:
      'Configure the reply categorizer: the OpenRouter model, and/or "context" — a few sentences about who we are, what we offer and who we email. The context goes into the system prompt so the model understands replies.',
    inputSchema: obj({ model: str('OpenRouter model id, e.g. "openai/gpt-6-luna"'), context: str('About us and our outreach (max 2000 characters). Empty string clears it.') }),
    run: (env, a) => cat.setAiSettings(env, a as never),
  },
  {
    name: 'set_reply_category',
    description: 'Manually set a reply\'s category. Setting "stop" adds the sender to do-not-send.',
    inputSchema: obj({ reply_id: num('Reply id'), category: str('Category name') }, ['reply_id', 'category']),
    run: async (env, a) => svc.publicReply(await applyCategory(env, Number(a.reply_id), cat.normCategoryName(a.category), 'manual')),
  },
  {
    name: 'check_replies',
    description: 'Check a mailbox for new replies right now (normally done every minute), then deliver any pending reply webhooks.',
    inputSchema: obj({ mailbox: str('Mailbox email or id') }, ['mailbox']),
    run: async (env, a) => {
      const mb = await svc.getMailbox(env, a.mailbox as string);
      const r = await syncMailbox(env, mb);
      return { new_replies: r.processed, webhooks: await deliverWebhooks(env) };
    },
  },
  {
    name: 'redeliver_webhook',
    description: 'Send a reply to its mailbox\'s webhook again (e.g. after fixing your endpoint).',
    inputSchema: obj({ reply_id: num('Reply id') }, ['reply_id']),
    run: async (env, a) => {
      const id = Number(a.reply_id);
      await env.DB.prepare("UPDATE replies SET webhook_status = 'pending' WHERE id = ?").bind(id).run();
      const r = await deliverWebhooks(env, id);
      const row = await env.DB.prepare('SELECT webhook_status, webhook_response FROM replies WHERE id = ?').bind(id).first();
      return { ...r, ...row };
    },
  },
  {
    name: 'recategorize_reply',
    description: 'Ask the AI categorizer again for one reply. If it now says "stop", the sender goes on the do-not-send list.',
    inputSchema: obj({ reply_id: num('Reply id') }, ['reply_id']),
    run: async (env, a) => {
      const { reply, result } = await recategorize(env, Number(a.reply_id));
      return { reply: svc.publicReply(reply), result };
    },
  },
  {
    name: 'refresh_send_as',
    description: 'Reload a mailbox\'s verified Gmail "Send mail as" addresses (after adding an alias in Gmail).',
    inputSchema: obj({ mailbox: str('Mailbox email or id') }, ['mailbox']),
    run: async (env, a) => svc.refreshSendAs(env, await svc.getMailbox(env, a.mailbox as string)),
  },
  {
    name: 'delete_template',
    description: 'Delete a saved template. Emails already sent with it are kept, and re-creating the same template_id still skips everyone who got it.',
    inputSchema: obj({ template_id: str('Template id') }, ['template_id']),
    run: (env, a) => tmpl.deleteTemplate(env, String(a.template_id)),
  },
  {
    name: 'get_conversation',
    description: 'Fetch the live Gmail thread for a sent email, split into messages with role "us" or "them" and quoted text removed.',
    inputSchema: obj({ email_id: num('Email id') }, ['email_id']),
    run: (env, a) => svc.conversation(env, Number(a.email_id)),
  },
  {
    name: 'list_campaigns',
    description: 'All campaigns with stats: scheduled, sent, failed, opened, replied, stopped, open/reply rates.',
    inputSchema: obj({}),
    run: (env) => svc.listCampaigns(env),
  },
  {
    name: 'campaign_stats',
    description: 'Detailed stats for one campaign including a per-day breakdown.',
    inputSchema: obj({ campaign: str('Campaign name') }, ['campaign']),
    run: (env, a) => svc.campaignStats(env, String(a.campaign)),
  },
  {
    name: 'dnc_list',
    description: 'List the do-not-send list. Each entry has a scope: all (every mailbox), marketing (outreach and newsletter mailboxes) or newsletter (newsletter mailboxes only).',
    inputSchema: obj({ q: str('Search'), scope: { type: 'string', enum: ['all', 'marketing', 'newsletter'] }, limit: num('Default 200'), offset: num('Offset') }),
    run: (env, a) => svc.dncList(env, a as never),
  },
  {
    name: 'dnc_add',
    description:
      'Add addresses to the do-not-send list. scope: all (default; no mailbox emails them), marketing (no outreach or newsletters; conversations can still answer them) or newsletter (newsletters only). An address already on the list keeps the wider scope. Pending emails it now blocks are skipped.',
    inputSchema: obj(
      { emails: { type: 'array', items: { type: 'string' }, minItems: 1 }, reason: str('Why'), scope: { type: 'string', enum: ['all', 'marketing', 'newsletter'] } },
      ['emails'],
    ),
    run: (env, a) => svc.dncAdd(env, a.emails as string[], (a.reason as string) || null, 'mcp', null, ((a.scope as string) || 'all') as never),
  },
  {
    name: 'dnc_remove',
    description: 'Remove addresses from the do-not-send list.',
    inputSchema: obj({ emails: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['emails']),
    run: (env, a) => svc.dncRemove(env, a.emails as string[]),
  },
];

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Json;
}

async function handleOne(env: Env, req: RpcRequest): Promise<Json | null> {
  const isNotification = req.id === undefined || req.id === null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id ?? null, error: { code, message } });
  try {
    switch (req.method) {
      case 'initialize': {
        const requested = String(req.params?.protocolVersion || '');
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cms-outbound', version: '0.1.0' },
          instructions:
            'Outbound email scheduler. Use list_mailboxes to find a sender, schedule_emails to queue mail (times are ISO 8601), ' +
            'list_campaigns / campaign_stats for performance, list_replies / get_conversation to read responses. ' +
            'Recipients who reply STOP are added to the do-not-send list automatically.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = String(req.params?.name || '');
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        try {
          const result = await tool.run(env, (req.params?.arguments as Json) || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: wrapStructured(result) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return ok({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
        return fail(-32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    return fail(err instanceof HttpError ? -32602 : -32603, err instanceof Error ? err.message : String(err));
  }
}

function wrapStructured(result: unknown): Json {
  return result && typeof result === 'object' && !Array.isArray(result) ? (result as Json) : { result };
}

/** Streamable-HTTP MCP transport (stateless, JSON responses). */
export async function handleMcp(env: Env, request: Request): Promise<Response> {
  if (request.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((r) => handleOne(env, r as RpcRequest)))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const res = await handleOne(env, body as RpcRequest);
  return res ? Response.json(res) : new Response(null, { status: 202 });
}
