/**
 * OpenAPI 3.0 description of the REST API under /api. Served at /api-docs/openapi.json and rendered with
 * Swagger UI at /api-docs. A test checks every route in index.ts is listed here.
 */

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Schema = {}): Schema => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const int = (description?: string, extra: Schema = {}): Schema => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const num = (description?: string): Schema => ({ type: 'number', ...(description ? { description } : {}) });
const bool = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) });
const time = (description?: string): Schema => ({ type: 'string', format: 'date-time', nullable: true, ...(description ? { description } : {}) });
const arr = (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});
const freeform = (description?: string): Schema => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) });
const nullable = (s: Schema): Schema => ({ ...s, nullable: true });

const json = (schema: Schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const body = (schema: Schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const pathId = (name = 'id', description = 'Numeric id') => ({ name, in: 'path', required: true, schema: name === 'id' && description === 'Numeric id' ? int() : str(), description });
const query = (name: string, schema: Schema, description?: string) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const errors = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '404': { $ref: '#/components/responses/NotFound' },
};

interface Op {
  tag: string;
  summary: string;
  description?: string;
  params?: unknown[];
  body?: unknown;
  res?: unknown;
  status?: string;
}
const op = (o: Op) => ({
  tags: [o.tag],
  summary: o.summary,
  ...(o.description ? { description: o.description } : {}),
  ...(o.params ? { parameters: o.params } : {}),
  ...(o.body ? { requestBody: o.body } : {}),
  responses: { [o.status || '200']: o.res || json(freeform()), ...errors },
});

// ---------- schemas ----------

const PURPOSE = str('outreach: cold 1:1 email. newsletter: bulk mail to subscribers. conversation: back-and-forth replies.', { enum: ['outreach', 'newsletter', 'conversation'] });
const SCOPE = str('Which mailboxes it blocks. all: every mailbox. marketing: outreach and newsletter mailboxes. newsletter: newsletter mailboxes only.', { enum: ['all', 'marketing', 'newsletter'] });

const WARMUP = obj(
  {
    enabled: bool(),
    start: int('Emails a day on day 1'),
    step: int('Extra emails a day, each day'),
    started_at: time(),
    day: nullable(int('Day of the warm-up, from 1')),
    today_limit: int(),
    target: int('The daily limit it grows to'),
    complete: bool(),
    completes_at: time(),
  },
  [],
);

const CONTACT_FILTER_PARAMS = [
  query('list', str(), 'List name or id'),
  query('q', str(), 'Search email, name or fields'),
  query(
    'rules',
    str(),
    'JSON list of {field, op, value}. Fields: email, name, field:<name>, sent_count, created_at, last_sent_at, last_reply_at, opened, replied, do_not_send, list, series. Ops: is, is_not, contains, not_contains, starts_with, ends_with, is_empty, is_not_empty, gt, lt; within_days, older_than_days, before, after; is true/false; in, not_in.',
  ),
  query('match', str(undefined, { enum: ['all', 'any'] }), 'all (default) or any of the rules'),
];

const emailFilterParams = [
  query('series', str(), 'Series name or id'),
  query('sender', str(), 'Sender key or id'),
  query('group', str(), 'Mailbox group name or id'),
  query('purpose', PURPOSE, 'Only emails from mailboxes with this purpose'),
  query('campaign', str(), 'Campaign name; "(none)" for emails without one'),
  query('status', str(), 'Comma-separated: scheduled, sending, sent, failed, skipped, cancelled, bounced'),
  query('mailbox', str(), 'Mailbox email or id'),
  query('template', str(), 'template_id'),
  query('to', str(), 'Recipient email'),
  query('q', str(), 'Search recipient or subject'),
  query('opened', bool(), 'Only emails opened at least once'),
  query('replied', bool(), 'Only emails with a reply'),
  query('limit', int(undefined, { default: 100, maximum: 500 })),
  query('offset', int(undefined, { default: 0 })),
];

const schemas: Record<string, Schema> = {
  Error: obj({ error: str() }, ['error']),
  Overview: obj({
    scheduled: int(),
    due_now: int(),
    sent: int(),
    failed: int(),
    opened: int(),
    replied: int(),
    do_not_send: int(),
    webhooks_pending: int(),
    replies_7d: int(),
    sent_24h: int(),
  }),
  Config: obj({
    base_url: str(),
    app_name: str(),
    mcp_url: str(),
    oauth_redirect_uri: str(),
    google_configured: bool(),
    pubsub_topic: nullable(str()),
    gmail_push_endpoint: str(),
    ses_webhook_endpoint: str('HTTPS endpoint for the SNS subscription'),
    ses_sns: nullable(freeform('Set once SNS has confirmed the subscription')),
    ses_last_event: nullable(freeform()),
  }),
  Setting: obj({
    key: str(undefined, { enum: ['APP_NAME', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPENROUTER_API_KEY', 'GMAIL_PUBSUB_TOPIC', 'SEND_BATCH', 'PUBLIC_URL'] }),
    label: str(),
    help: str(),
    secret: bool(),
    source: str('Where the current value comes from', { enum: ['app', 'deploy', 'none'] }),
    is_set: bool(),
    value: nullable(str('Current value (null for secrets, which are never returned)')),
    deploy_value: str('Deploy-time value ("(set)" for secrets)'),
  }),
  Mailbox: obj({
    id: int(),
    email: str(),
    name: nullable(str('Default From name')),
    from_email: str('Default From address (the mailbox or a verified alias)'),
    reply_to: nullable(str('Default Reply-To')),
    send_as: arr(obj({ email: str(), name: nullable(str()) }), 'Addresses this mailbox can send as'),
    senders: arr(obj({ id: int(), key: str(), label: str(), description: nullable(str()), from_name: nullable(str()), from_email: str(), reply_to: nullable(str()), is_default: bool() })),
    webhook_url: nullable(str('Where replies are POSTed')),
    has_webhook_secret: bool(),
    daily_limit: int('Max emails per rolling 24 hours'),
    throttle_minutes: int('Minimum minutes between sends'),
    sent_24h: int(),
    provider: str(undefined, { enum: ['google', 'ses'] }),
    purpose: PURPOSE,
    today_limit: int('Daily limit in force now (lower while warming up)'),
    warmup: WARMUP,
    group_id: nullable(int()),
    group: nullable(obj({ id: int(), name: str() }, [])),
    format: obj(
      {
        track_opens: bool('Tracking pixel'),
        list_unsubscribe: bool('List-Unsubscribe and one-click headers'),
        footer: str('Plain-text footer added to every email ({{unsubscribe_url}} is replaced); "" = none'),
        bulk_headers: bool('List-Id and Precedence: bulk (newsletters)'),
      },
      [],
    ),
    format_overrides: obj({ track_opens: nullable(bool()), list_unsubscribe: nullable(bool()), footer: nullable(str()) }, [], ),
    ses: nullable(obj({ region: str(), access_key_id: str('Last 4 characters'), has_secret: bool(), configuration_set: nullable(str()), status: freeform('Last account check: sandbox, quota, verified identity') })),
    reply_domain: nullable(str('SES: replies arrive at reply+<token>@this domain')),
    forward_to: nullable(str('SES: replies are also forwarded here')),
    active: bool(),
    connected: bool(),
    push_watch_expires_at: time(),
    last_sync_at: time(),
    last_error: nullable(str()),
    created_at: time(),
  }),
  MailboxPatch: obj({
    name: str('Default From name'),
    from_email: str('Default From: the mailbox or a verified alias; "" resets to the mailbox'),
    reply_to: str('Default Reply-To; "" removes it'),
    webhook_url: str('Reply webhook URL; "" removes it'),
    webhook_secret: str('Signs webhook bodies (x-outbound-signature: sha256=HMAC)'),
    daily_limit: int('1-2000', { minimum: 1, maximum: 2000 }),
    throttle_minutes: int('1-1440', { minimum: 1, maximum: 1440 }),
    active: bool(),
    reply_domain: str('SES only'),
    forward_to: str('SES only'),
    ses_region: str('SES only'),
    ses_access_key_id: str('SES only'),
    ses_secret_access_key: str('SES only'),
    ses_configuration_set: str('SES only'),
    purpose: PURPOSE,
    track_opens: nullable(bool('null = purpose default')),
    list_unsubscribe: nullable(bool('null = purpose default')),
    footer: nullable(str('"" = no footer, null = purpose default. Include a postal address for commercial email.')),
    warmup: bool('Turn warm-up on (starts day 1 now) or off'),
    warmup_start: int('1-500', { minimum: 1, maximum: 500 }),
    warmup_step: int('1-200', { minimum: 1, maximum: 200 }),
    warmup_restart: bool('Start the warm-up again from day 1'),
    group: nullable({ oneOf: [str(), int()], description: 'Group name or id; null or "" removes it from its group' }),
  }),
  Activity: obj({
    email: str(),
    contact: nullable(ref('Contact')),
    summary: obj(
      {
        emails: int(),
        sent: int(),
        scheduled: int(),
        opened: int('Sent emails opened at least once'),
        replied: int('Emails that got a reply'),
        replies: int('Human replies (not auto-replies or bounces)'),
        mailboxes: arr(str()),
        first_sent_at: time(),
        last_sent_at: time(),
        last_reply_at: time(),
        next_send_at: time(),
        do_not_send: nullable(obj({ scope: str(), reason: nullable(str()), source: nullable(str()), at: time() }, [])),
      },
      [],
    ),
    series: arr(obj({ id: int(), name: str(), status: str(), stop_reason: nullable(str()), steps_done: int(), steps_total: int(), enrolled_at: time() }, [])),
    events: arr(
      obj(
        {
          type: str(undefined, { enum: ['email', 'reply', 'contact_created', 'list_joined', 'series_enrolled', 'series_stopped', 'do_not_send'] }),
          at: time(),
          email: freeform('type email: id, subject, status, mailbox, from, sender, campaign, template_id, series {name, step}, group, open_count, first_opened_at, reply_count, …'),
          reply: freeform('type reply: id, email_id, from, text, kind, category, …'),
          list: str('type list_joined'),
          series: obj({ id: int(), name: str() }, []),
          reason: nullable(str()),
          scope: str('type do_not_send'),
        },
        ['type', 'at'],
      ),
    ),
    truncated: bool('More than 500 emails; the oldest are left out'),
  }),
  SeriesStep: obj({
    id: int(),
    position: int('1, 2, 3, … in send order'),
    template_id: str(),
    template_exists: bool(),
    name: nullable(str()),
    subject: nullable(str()),
    delay_days: int('Step 1: days after joining. Later steps: days after the previous email went out.'),
    day: int('Days after joining, if every step goes out on time'),
    stats: obj({ sent: int(), scheduled: int(), opened: int(), replied: int() }, []),
  }),
  Series: obj({
    id: int(),
    name: str(),
    description: nullable(str()),
    active: bool('false = paused: nobody gets their next step'),
    sender: nullable(obj({ id: int(), key: str(), label: str(), mailbox: str() }, [])),
    group: nullable(obj({ id: int(), name: str() }, [])),
    campaign: str(),
    stop_on_reply: bool(),
    lists: arr(obj({ id: int(), name: str(), only_new: bool(), attached_at: time() }, [])),
    steps: arr(ref('SeriesStep')),
    stats: obj({ enrolled: int(), in_progress: int(), completed: int(), stopped: int(), not_on_list: int() }, []),
    last_run_at: time(),
    last_error: nullable(str('e.g. a step whose template was deleted')),
    created_at: time(),
    updated_at: time(),
  }),
  StepInput: obj({
    template_id: str('An existing template; or give subject + body to create one for this step'),
    subject: str(),
    body: str(),
    name: str(),
    delay_days: int('0-365. Step 1: days after joining; later steps: days after the previous email went out', { minimum: 0, maximum: 365 }),
    position: int('1-based; default at the end'),
  }),
  SeriesInput: obj({
    name: str(),
    description: str(),
    sender: { oneOf: [str(), int()], description: 'Sender key or id, or give group' },
    group: { oneOf: [str(), int()], description: 'Mailbox group name or id' },
    campaign: str('Defaults to the series name'),
    stop_on_reply: bool('Stop someone\'s series when they reply'),
    active: bool(),
    lists: arr({ oneOf: [str(), int(), obj({ list: { oneOf: [str(), int()] }, only_new: bool('Only contacts added to the list from now on') }, ['list'])] }, 'Replaces the attached lists'),
    steps: arr(ref('StepInput'), 'Only when creating'),
  }),
  Enrollment: obj({
    id: int(),
    contact_id: int(),
    email: str(),
    name: nullable(str()),
    state: str(undefined, { enum: ['in_progress', 'completed', 'stopped', 'not_on_list'] }),
    stop_reason: nullable(str('do-not-send, bounced, replied, stopped by hand')),
    steps_done: int(),
    steps_total: int(),
    next_step: nullable(obj({ position: int(), due_at: time() }, [])),
    sending: nullable(obj({ status: str(), send_at: time() }, [])),
    enrolled_at: time(),
    last_at: time(),
  }),
  Group: obj({
    id: int(),
    name: str(),
    description: nullable(str()),
    purpose: nullable(str('Shared purpose of the members, or "mixed"')),
    mailboxes: arr(obj({ id: int(), email: str(), purpose: PURPOSE, provider: str(), sending: bool(), daily_limit: int(), today_limit: int(), throttle_minutes: int(), warmup: WARMUP, sent_24h: int() }, [])),
    capacity_today: int('Emails the group can send in the next 24 hours'),
    sent_24h: int(),
    created_at: time(),
    updated_at: time(),
  }),
  GroupInput: obj({ name: str(), description: str(), mailboxes: arr({ oneOf: [str(), int()] }, 'Member mailbox emails or ids; replaces the membership') }),
  GroupPlan: obj({
    group: str(),
    count: int(),
    first_send_at: time(),
    last_send_at: time(),
    slots: arr(str()),
    mailboxes: arr(obj({ mailbox: str(), count: int(), today_limit: int(), warming_up: bool(), first_send_at: time(), last_send_at: time() }, [])),
  }),
  Sender: obj({
    id: int(),
    key: str('Stable handle for the API and MCP'),
    label: str(),
    description: nullable(str('When to use this sender')),
    mailbox_id: int(),
    mailbox: str(),
    provider: str(undefined, { enum: ['google', 'ses'] }),
    purpose: PURPOSE,
    from_name: nullable(str()),
    from_email: str(),
    reply_to: nullable(str()),
    is_default: bool(),
    stats: obj({ sent: int(), scheduled: int(), opened: int(), replied: int() }),
    created_at: time(),
    updated_at: time(),
  }),
  SenderInput: obj({
    mailbox: { oneOf: [str(), int()], description: 'Required when creating' },
    key: str('Auto-generated from the label if omitted'),
    label: str(),
    description: str('When to use it'),
    from_name: str(),
    from_email: str('The mailbox, a verified Gmail alias, or an address on a verified SES domain'),
    reply_to: str(),
    is_default: bool(),
  }),
  EmailInput: obj(
    {
      sender: { oneOf: [str(), int()], description: 'Sender key or id: picks the mailbox and fills From/Reply-To unless given' },
      mailbox: { oneOf: [str(), int()], description: 'Mailbox email or id, if no sender (uses its default sender)' },
      to: str('Recipient'),
      to_name: str(),
      subject: str('Required unless template_id is given'),
      body_html: str('HTML body (a tracking pixel is added)'),
      body_text: str('Plain-text body'),
      body: str('Either; treated as HTML if it contains tags'),
      send_at: str('ISO 8601 or epoch. Omit to send on the next minute. Ignored with auto_schedule'),
      campaign: str(),
      from_name: str(),
      from_email: str('Mailbox or verified alias'),
      reply_to: str(),
      template_id: str('Send a saved template; sent to each address at most once'),
      vars: freeform('Template variables, e.g. {"first_name":"Jane"}'),
      metadata: freeform('Echoed back in reply webhooks'),
      in_reply_to: int('Id of a sent email to answer in the same thread. to, subject, mailbox, sender and From then default to the conversation.'),
      group: { oneOf: [str(), int()], description: 'Mailbox group instead of sender/mailbox: sent from the member with the earliest free slot, as its default sender. Always planned by the members\' limits and warm-up; send_at is the earliest time.' },
    },
    ['to'],
  ),
  ReplyInput: obj({
    body: str('HTML or text'),
    subject: str('Default "Re: <original subject>"'),
    to: str('Default: whoever last replied, else the original recipient'),
    to_name: str(),
    sender: { oneOf: [str(), int()], description: 'Another sender of the same mailbox' },
    from_name: str(),
    reply_to: str(),
    send_at: str('Omit to send now'),
    metadata: freeform(),
  }, ['body']),
  ScheduleRequest: obj({
    emails: arr(ref('EmailInput'), 'Up to 1000'),
    auto_schedule: bool("Spread sends by each mailbox's throttle and daily limit"),
    start_at: str('With auto_schedule: earliest send time'),
  }, ['emails']),
  ScheduleResult: obj({
    scheduled: arr(obj({ id: int(), to: str(), send_at: str(), campaign: nullable(str()), template_id: nullable(str()) })),
    skipped: arr(obj({ index: int(), to: str(), reason: str() })),
    plan: arr(obj({ mailbox: str(), count: int(), first_send_at: time(), last_send_at: time(), daily_limit: int(), throttle_minutes: int() }), 'Only with auto_schedule'),
  }),
  Email: obj({
    id: int(),
    mailbox_id: int(),
    mailbox: str(),
    campaign: nullable(str()),
    template_id: nullable(str()),
    in_reply_to: nullable(int('The email this one answers')),
    group_id: nullable(int('The mailbox group it was sent through')),
    series_id: nullable(int('The series it belongs to')),
    ai: nullable(obj({ status: str(undefined, { enum: ['personalized', 'skipped', 'fallback', 'failed'] }), note: nullable(str('Skip reason or error')), model: nullable(str()), cost: nullable({ type: 'number' }), at: time() }, [])),
    series_step_id: nullable(int()),
    from_name: nullable(str()),
    from_email: nullable(str()),
    reply_to: nullable(str()),
    to: str(),
    to_name: nullable(str()),
    subject: str(),
    snippet: str('Start of the body (lists only)'),
    send_at: time(),
    status: str(undefined, { enum: ['scheduled', 'sending', 'sent', 'failed', 'skipped', 'cancelled', 'bounced'] }),
    status_reason: nullable(str('Why it failed/was skipped, or why it is still waiting')),
    sent_at: time(),
    open_count: int(),
    first_opened_at: time(),
    last_opened_at: time(),
    reply_count: int(),
    last_reply_at: time(),
    gmail_thread_id: nullable(str()),
    metadata: nullable(freeform()),
    created_at: time(),
  }),
  EmailList: obj({ total: int(), limit: int(), offset: int(), counts: freeform('Emails per status for the same filter, ignoring status'), emails: arr(ref('Email')) }),
  EmailDetail: {
    allOf: [
      ref('Email'),
      obj({
        body_html: nullable(str()),
        body_text: nullable(str()),
        mailbox_name: nullable(str()),
        opens: arr(obj({ opened_at: time(), ip: nullable(str()), user_agent: nullable(str()) })),
        replies: arr(ref('Reply')),
      }),
    ],
  },
  ConversationMessage: obj({ gmail_message_id: str(), role: str(undefined, { enum: ['us', 'them'] }), from: str(), from_name: nullable(str()), to: str(), subject: str(), date: str(), text: str('Quoted history removed') }),
  Reply: obj({
    id: int(),
    email_id: int(),
    from: str(),
    from_name: nullable(str()),
    subject: nullable(str()),
    received_at: time(),
    kind: str(undefined, { enum: ['reply', 'stop', 'auto', 'bounce'] }),
    category: nullable(str()),
    category_source: nullable(str(undefined, { enum: ['ai', 'rule', 'manual'] })),
    category_error: nullable(str()),
    text: nullable(str('Reply with quoted history removed')),
    webhook_status: str(undefined, { enum: ['pending', 'delivered', 'failed', 'skipped', 'none'] }),
    webhook_attempts: int(),
    webhook_response: nullable(str()),
  }),
  Template: obj({
    template_id: str(),
    name: nullable(str()),
    subject: str(),
    body: str(),
    columns: arr(str(), 'Variables it needs (always includes "to")'),
    ai: obj({ enabled: bool(), prompt: nullable(str()), model: nullable(str()), on_error: str(undefined, { enum: ['retry', 'send'] }), system: nullable(str('Custom system prompt, or null for the default')) }, []),
    created_at: time(),
    updated_at: time(),
    stats: obj({ sent: int(), scheduled: int(), opened: int(), replied: int() }),
  }),
  TemplateInput: obj(
    {
      template_id: str('Permanent; letters, numbers, . _ -'),
      name: str(),
      subject: str('Use {{variables}}'),
      body: str('HTML or text with {{variables}}'),
      ai_enabled: bool("Rewrite each email with AI just before it's sent. Missing {{variables}} don't skip anyone; the AI fills them in."),
      ai_prompt: str('What to change, in plain words. The AI sees the contact\'s fields, lists, engagement and today\'s date, and may answer skip.'),
      ai_model: str('OpenRouter model id; default the app AI model'),
      ai_on_error: str('If the AI fails: retry (then fail) or send as written', { enum: ['retry', 'send'] }),
      ai_system: nullable(str('Replaces the default personalization system prompt; "" or null = the default (GET /ai → personalization). The output format and date are always added.')),
    },
    ['template_id', 'subject', 'body'],
  ),
  PersonalizeRequest: obj(
    {
      template_id: str('Template to test (or give subject and body)'),
      contact: { oneOf: [str(), int()], description: 'Contact email or id' },
      ai_prompt: str('Unsaved instructions to try'),
      ai_model: str(),
      ai_system: nullable(str('System prompt to try; "" = the default')),
      subject: str(),
      body: str(),
      vars: freeform('Extra values for this email'),
    },
    ['contact'],
  ),
  Category: obj({ name: str(), description: str(), system: bool('"stop" is permanent'), replies: int() }),
  AiConfig: obj({ configured: bool(), model: str(), default_model: str(), context: str('About your outreach (in the system prompt)'), system_prompt: str() }),
  CategorizeResult: obj({ category: nullable(str()), source: nullable(str()), cost: nullable(num('USD')), error: nullable(str()), model: str(), raw: str() }),
  Contact: obj({
    id: int(),
    email: str(),
    name: nullable(str()),
    fields: freeform('Every other attribute (first_name, company, …); usable as {{variables}}'),
    lists: arr(str()),
    sent_count: int(),
    last_sent_at: time(),
    do_not_send: bool(),
    do_not_send_scope: nullable(SCOPE),
    created_at: time(),
    updated_at: time(),
  }),
  ContactDetail: {
    allOf: [
      ref('Contact'),
      obj({ emails: arr(obj({ id: int(), subject: str(), status: str(), campaign: nullable(str()), template_id: nullable(str()), send_at: time(), sent_at: time(), open_count: int(), reply_count: int() })) }),
    ],
  },
  ContactInput: obj(
    {
      email: str(),
      first_name: str(),
      last_name: str(),
      name: str('Defaults to first + last name'),
      lists: arr(str(), 'Lists to add them to (created if missing)'),
      fields: freeform('Attributes; may also be given at the top level'),
    },
    ['email'],
    { additionalProperties: { type: 'string' }, example: { email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe', company: 'Acme', title: 'CTO', lists: ['Q1 Leads'] } },
  ),
  List: obj({ id: int(), name: str(), description: nullable(str()), contacts: int(), created_at: time() }),
  ListSendInput: obj(
    {
      lists: arr({ oneOf: [str(), int()] }, 'List names or ids'),
      sender: { oneOf: [str(), int()], description: 'Sender key or id (or give mailbox, or group)' },
      group: { oneOf: [str(), int()], description: 'Mailbox group: spread across its mailboxes by their limits and warm-up (always planned)' },
      mailbox: { oneOf: [str(), int()] },
      template_id: str('Recommended: anyone who already has it is skipped'),
      subject: str('If not using a template'),
      body: str('If not using a template'),
      campaign: str(),
      from_name: str(),
      from_email: str(),
      reply_to: str(),
      auto_schedule: bool(),
      start_at: str('With auto_schedule'),
      send_at: str('Without auto_schedule: first send'),
      interval_minutes: int('Without auto_schedule: gap between sends'),
      filter: obj({ q: str(), rules: arr(freeform(), 'Same conditions as GET /contacts rules'), match: str('all (default) or any', { enum: ['all', 'any'] }) }, undefined, { description: 'Only contacts matching these conditions' }),
      sort: str('added_to_list (default: the order they joined the lists), name, email, created_at, sent_count, last_sent_at, lists, or field:<name>'),
      dir: str('asc (default) or desc', { enum: ['asc', 'desc'] }),
      limit: int('At most this many emails: the first ones in order who can get it. Re-send a template to reach the next ones.'),
    },
    ['lists'],
  ),
  ListPreview: obj({
    contacts: int('On the lists and matching the filter'),
    on_lists: int('With a filter: everyone on the lists'),
    will_send: int(),
    held_back: int('Could get it, but beyond limit'),
    skipped: obj({ do_not_send: int(), already_received: int(), missing_values: int() }),
    columns: arr(str()),
    coverage: freeform('Column → how many contacts have a value'),
    fields: arr(str(), 'Variables the contacts provide'),
    sample: nullable(freeform('First contact that would get it')),
    first: arr(obj({ email: str(), name: nullable(str()) }), 'The first few who would get it, in send order'),
  }),
  Campaign: obj({
    campaign: str(),
    total: int(),
    scheduled: int(),
    sent: int(),
    failed: int(),
    skipped: int(),
    cancelled: int(),
    bounced: int(),
    opened: int(),
    total_opens: int(),
    replied: int(),
    stopped: int(),
    open_rate: num('Percent of sent'),
    reply_rate: num('Percent of sent'),
    first_send_at: time(),
    last_send_at: time(),
  }),
  DncEntry: obj({ email: str(), scope: SCOPE, reason: nullable(str()), source: str(undefined, { enum: ['reply', 'unsubscribe', 'manual', 'mcp', 'api', 'bounce', 'complaint'] }), email_id: nullable(int()), created_at: time() }),
};

// ---------- paths ----------

const paths: Record<string, Record<string, unknown>> = {
  '/overview': { get: op({ tag: 'General', summary: 'Totals across all emails', res: json(ref('Overview')) }) },
  '/config': { get: op({ tag: 'General', summary: 'Public URL, MCP URL, OAuth redirect URI and Gmail push endpoint', res: json(ref('Config')) }) },
  '/run': { post: op({ tag: 'General', summary: 'Run the every-minute work now', description: 'Sends due emails, checks for replies, retries webhooks and renews Gmail watches.' }) },
  '/settings': {
    get: op({ tag: 'Settings', summary: 'App settings and where each value comes from', res: json(arr(ref('Setting'))) }),
    put: op({
      tag: 'Settings',
      summary: 'Change app settings',
      description: 'Values override any deploy-time ones; "" clears an app value. The passcode is changed with POST /passcode.',
      body: body(obj(Object.fromEntries(['APP_NAME', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPENROUTER_API_KEY', 'GMAIL_PUBSUB_TOPIC', 'SEND_BATCH', 'PUBLIC_URL'].map((k) => [k, str()])))),
      res: json(obj({ changed: arr(str()), watch: freeform(), settings: arr(ref('Setting')) })),
    }),
  },
  '/passcode': {
    post: op({
      tag: 'Settings',
      summary: 'Change the passcode',
      description: 'The passcode is the Bearer token for the API and MCP and the sign-in for the app. At least 12 characters. Sessions stay signed in. Not available when the passcode was set at deploy time.',
      body: body(obj({ passcode: str() })),
      res: json(obj({ ok: { type: 'boolean' } })),
    }),
  },
  '/settings/push-token': {
    post: op({ tag: 'Settings', summary: 'Regenerate the Gmail push token', description: 'The old push URL stops working; update your Pub/Sub subscription.', res: json(obj({ gmail_push_endpoint: str() })) }),
  },

  '/mailboxes': { get: op({ tag: 'Mailboxes', summary: 'Connected mailboxes', description: 'Connect new mailboxes in the app (Google sign-in).', res: json(arr(ref('Mailbox'))) }) },
  '/mailboxes/{id}': {
    patch: op({ tag: 'Mailboxes', summary: 'Update a mailbox', params: [pathId()], body: body(ref('MailboxPatch')), res: json(ref('Mailbox')) }),
    delete: op({ tag: 'Mailboxes', summary: 'Disconnect a mailbox', description: 'Cancels its scheduled emails.', params: [pathId()] }),
  },
  '/mailboxes/{id}/plan': {
    get: op({
      tag: 'Mailboxes',
      summary: 'Preview auto-send times',
      description: "Where N auto-scheduled emails would land, given the mailbox's limits and queue. Schedules nothing.",
      params: [pathId(), query('count', int()), query('start_at', str())],
    }),
  },
  '/mailboxes/ses': {
    post: op({
      tag: 'Mailboxes',
      summary: 'Add an AWS SES mailbox',
      description: 'Checks the keys and that the From address or its domain is verified. Replies come back to reply+<token>@reply_domain via Cloudflare Email Routing.',
      body: body(
        obj(
          { email: str('From address'), name: str(), region: str(), access_key_id: str(), secret_access_key: str(), configuration_set: str(), reply_domain: str('e.g. reply.example.com'), forward_to: str(), purpose: PURPOSE },
          ['email', 'region', 'access_key_id', 'secret_access_key', 'reply_domain'],
        ),
      ),
      res: json(ref('Mailbox'), 'Created'),
      status: '201',
    }),
  },
  '/mailboxes/{id}/ses-check': { post: op({ tag: 'Mailboxes', summary: 'Re-check an SES mailbox (keys, sandbox, quota, verification)', params: [pathId()], res: json(ref('Mailbox')) }) },
  '/mailboxes/{id}/send-as': { post: op({ tag: 'Mailboxes', summary: "Reload the mailbox's verified Gmail aliases", params: [pathId()], res: json(arr(obj({ email: str(), name: nullable(str()) }))) }) },
  '/mailboxes/{id}/sync': { post: op({ tag: 'Mailboxes', summary: 'Check for replies now', params: [pathId()] }) },

  '/senders': {
    get: op({ tag: 'Senders', summary: 'Senders (From identities) with their descriptions and stats', params: [query('mailbox', str(), 'Mailbox email or id')], res: json(arr(ref('Sender'))) }),
    post: op({ tag: 'Senders', summary: 'Create a sender', description: "The first sender of a mailbox becomes its default.", body: body(ref('SenderInput')), res: json(ref('Sender'), 'Created'), status: '201' }),
  },
  '/senders/{id}': {
    get: op({ tag: 'Senders', summary: 'One sender (by id or key)', params: [pathId('id', 'Sender id or key')], res: json(ref('Sender')) }),
    patch: op({ tag: 'Senders', summary: 'Update a sender', params: [pathId('id', 'Sender id or key')], body: body(ref('SenderInput')), res: json(ref('Sender')) }),
    delete: op({ tag: 'Senders', summary: 'Delete a sender (not the default)', params: [pathId('id', 'Sender id or key')] }),
  },
  '/people/{ref}/activity': {
    get: op({
      tag: 'Contacts',
      summary: "One person's full history",
      description: 'Every email sent or queued to the address (any mailbox, sender, list send, series or group, with opens), their replies, list joins, series enrollments and stops, and do-not-send. Newest first. Works for addresses that are not saved as contacts.',
      params: [pathId('ref', 'Email address (URL-encoded) or contact id')],
      res: json(ref('Activity')),
    }),
  },
  '/contacts/fields': {
    get: op({ tag: 'Contacts', summary: 'Field names in use, most common first', res: json(arr(obj({ key: str(), contacts: int() }))) }),
  },
  '/contacts/export': {
    get: op({
      tag: 'Contacts',
      summary: 'Export contacts as CSV',
      description: 'ids=1,2,3, or everyone matching list, q, rules and match. Columns: email, name, lists, every field, emails_sent, last_emailed, do_not_send, added.',
      params: [query('ids', str(), 'Comma-separated contact ids'), ...CONTACT_FILTER_PARAMS, query('exclude_ids', str(), 'With a filter: comma-separated ids to leave out')],
      res: { description: 'CSV', content: { 'text/csv': { schema: str() } } },
    }),
  },
  '/series': {
    get: op({ tag: 'Series', summary: 'Series (drip campaigns) with steps and progress', res: json(arr(ref('Series'))) }),
    post: op({
      tag: 'Series',
      summary: 'Create a series',
      description: 'Everyone on the lists is enrolled (contacts added later too) and gets each step in turn. Steps can be added any time; they reach everyone who hasn\'t had them.',
      body: body(ref('SeriesInput')),
      res: json(ref('Series'), 'Created'),
      status: '201',
    }),
  },
  '/series/{id}': {
    get: op({ tag: 'Series', summary: 'One series (by id or name)', params: [pathId('id', 'Series id or name')], res: json(ref('Series')) }),
    patch: op({ tag: 'Series', summary: 'Update, pause/resume, or change lists or sender', params: [pathId('id', 'Series id or name')], body: body(ref('SeriesInput')), res: json(ref('Series')) }),
    delete: op({ tag: 'Series', summary: 'Delete a series', description: 'Cancels its emails that haven\'t gone out. Sent emails and templates stay.', params: [pathId('id', 'Series id or name')] }),
  },
  '/series/{id}/steps': {
    post: op({ tag: 'Series', summary: 'Add a step', params: [pathId('id', 'Series id or name')], body: body(ref('StepInput')), res: json(ref('Series'), 'Added'), status: '201' }),
  },
  '/series/{id}/steps/{step}': {
    patch: op({ tag: 'Series', summary: 'Change a step', description: 'delay_days, position or template_id; subject/body/name edit the template itself.', params: [pathId('id', 'Series id or name'), pathId('step', 'Step id')], body: body(ref('StepInput')), res: json(ref('Series')) }),
    delete: op({ tag: 'Series', summary: 'Remove a step', description: 'Its unsent emails are cancelled and people move on. The template stays.', params: [pathId('id', 'Series id or name'), pathId('step', 'Step id')], res: json(ref('Series')) }),
  },
  '/series/{id}/enrollments': {
    get: op({
      tag: 'Series',
      summary: 'Who is in the series and where they are',
      params: [pathId('id', 'Series id or name'), query('status', str(undefined, { enum: ['in_progress', 'completed', 'stopped', 'not_on_list'] })), query('q', str()), query('limit', int()), query('offset', int())],
      res: json(obj({ total: int(), enrollments: arr(ref('Enrollment')) })),
    }),
  },
  '/series/{id}/enrollments/{enrollment}': {
    patch: op({ tag: 'Series', summary: 'Stop someone, or let them carry on', params: [pathId('id', 'Series id or name'), pathId('enrollment', 'Enrollment id')], body: body(obj({ status: str(undefined, { enum: ['active', 'stopped'] }) }, ['status'])), res: json(ref('Enrollment')) }),
  },
  '/series/{id}/run': {
    post: op({ tag: 'Series', summary: 'Run the series now', description: 'Enrolls new list members and schedules whatever is due. The cron does this every minute.', params: [pathId('id', 'Series id or name')], res: json(obj({ series: int(), enrolled: int(), scheduled: int(), skipped: int(), stopped: int() })) }),
  },
  '/groups': {
    get: op({ tag: 'Mailbox groups', summary: 'Mailbox groups with members, warm-up and capacity today', res: json(arr(ref('Group'))) }),
    post: op({ tag: 'Mailbox groups', summary: 'Create a group', description: 'A mailbox is in at most one group; listing it here moves it.', body: body(ref('GroupInput')), res: json(ref('Group'), 'Created'), status: '201' }),
  },
  '/groups/{id}': {
    get: op({ tag: 'Mailbox groups', summary: 'One group (by id or name)', params: [pathId('id', 'Group id or name')], res: json(ref('Group')) }),
    patch: op({ tag: 'Mailbox groups', summary: 'Rename, describe or change members', params: [pathId('id', 'Group id or name')], body: body(ref('GroupInput')), res: json(ref('Group')) }),
    delete: op({ tag: 'Mailbox groups', summary: 'Delete a group (its mailboxes stay)', params: [pathId('id', 'Group id or name')] }),
  },
  '/groups/{id}/plan': {
    get: op({
      tag: 'Mailbox groups',
      summary: 'Preview a send through the group',
      description: 'When N emails would go out and how many each mailbox takes. Schedules nothing.',
      params: [pathId('id', 'Group id or name'), query('count', int()), query('start_at', str())],
      res: json(ref('GroupPlan')),
    }),
  },
  '/emails': {
    get: op({ tag: 'Emails', summary: 'List emails', description: 'Scheduled first (soonest first), then most recently sent.', params: emailFilterParams, res: json(ref('EmailList')) }),
    post: op({
      tag: 'Emails',
      summary: 'Schedule emails',
      description: 'Body may be one email, an array, or {emails, auto_schedule, start_at}. Do-not-send recipients and template repeats are skipped.',
      body: body({ oneOf: [ref('ScheduleRequest'), ref('EmailInput'), arr(ref('EmailInput'))] }),
      res: json(ref('ScheduleResult'), 'Created'),
      status: '201',
    }),
  },
  '/emails/cancel': {
    post: op({
      tag: 'Emails',
      summary: 'Cancel unsent emails',
      description: 'By ids, by every email matching filter (the GET /emails query, across all pages) minus exclude_ids, or by campaign and/or to.',
      body: body(obj({ ids: arr(int()), filter: freeform('Same fields as the GET /emails query: campaign, status, mailbox, q, template, …'), exclude_ids: arr(int()), campaign: str(), to: str() })),
      res: json(obj({ cancelled: int() })),
    }),
  },
  '/emails/send-now': {
    post: op({
      tag: 'Emails',
      summary: 'Send scheduled emails now',
      description: 'By ids, or every scheduled email matching filter minus exclude_ids. The first 25 go straight away (skipping the throttle, not the daily limit); the rest become due now and go out over the next minutes within each mailbox\'s limits (queued).',
      body: body(obj({ ids: arr(int()), filter: freeform('Same fields as the GET /emails query'), exclude_ids: arr(int()) })),
      res: json(obj({ sent: int(), failed: int(), skipped: int(), deferred: int(), queued: int() })),
    }),
  },
  '/emails/{id}': {
    get: op({ tag: 'Emails', summary: 'One email with body, opens and replies', params: [pathId()], res: json(ref('EmailDetail')) }),
    patch: op({
      tag: 'Emails',
      summary: 'Edit or reschedule an unsent email',
      description: 'Editing a cancelled or failed email re-queues it.',
      params: [pathId()],
      body: body(obj({ send_at: str(), subject: str(), body_html: str(), body_text: str(), campaign: str(), mailbox: str(), to_name: str(), from_name: str(), from_email: str(), reply_to: str() })),
      res: json(ref('Email')),
    }),
  },
  '/emails/{id}/conversation': { get: op({ tag: 'Emails', summary: 'The Gmail thread as a conversation', params: [pathId()], res: json(arr(ref('ConversationMessage'))) }) },
  '/emails/{id}/reply': {
    post: op({
      tag: 'Emails',
      summary: 'Reply in the same thread',
      description: 'Answers one of our sent emails with In-Reply-To/References (and in the same Gmail thread). Defaults come from the conversation. Sends now unless send_at is given.',
      params: [pathId()],
      body: body(ref('ReplyInput')),
      res: json(obj({ sent: bool(), email: ref('Email'), scheduled: freeform(), skipped: arr(freeform()) }), 'Sent or scheduled'),
      status: '201',
    }),
  },

  '/templates/personalize': {
    post: op({
      tag: 'Templates',
      summary: 'Test AI personalization on a contact',
      description: 'Returns the draft (template filled for them), the data the AI saw, and the result: {ok, subject, body} or {ok, skip} or {ok: false, error}, with cost and model. Sends nothing.',
      body: body(ref('PersonalizeRequest')),
      res: json(obj({ to: str(), draft: freeform(), data: freeform(), result: freeform() })),
    }),
  },
  '/templates': {
    get: op({ tag: 'Templates', summary: 'List templates', res: json(arr(ref('Template'))) }),
    post: op({ tag: 'Templates', summary: 'Create a template', body: body(ref('TemplateInput')), res: json(ref('Template'), 'Created'), status: '201' }),
  },
  '/templates/{template_id}': {
    get: op({ tag: 'Templates', summary: 'One template', params: [pathId('template_id', 'Template id')], res: json(ref('Template')) }),
    patch: op({ tag: 'Templates', summary: 'Update a template', params: [pathId('template_id', 'Template id')], body: body(obj({ name: str(), subject: str(), body: str() })), res: json(ref('Template')) }),
    delete: op({ tag: 'Templates', summary: 'Delete a template', description: 'Email history is kept, so re-creating the same id still skips past recipients.', params: [pathId('template_id', 'Template id')] }),
  },
  '/templates/{template_id}/check': {
    post: op({
      tag: 'Templates',
      summary: 'Who already has this template queued or sent',
      params: [pathId('template_id', 'Template id')],
      body: body(obj({ emails: arr(str()) }, ['emails'])),
      res: json(obj({ template_id: str(), checked: int(), already_received: arr(obj({ to: str(), status: str() })), new_recipients: int() })),
    }),
  },

  '/contacts': {
    get: op({
      tag: 'Contacts',
      summary: 'List contacts',
      params: [...CONTACT_FILTER_PARAMS, query('email', str(), 'Exact email'), query('sort', str(), 'name, email, lists, sent_count, last_sent_at, created_at, updated_at (default), or field:<name>'), query('dir', str(undefined, { enum: ['asc', 'desc'] })), query('limit', int()), query('offset', int())],
      res: json(obj({ total: int(), limit: int(), offset: int(), contacts: arr(ref('Contact')) })),
    }),
    post: op({
      tag: 'Contacts',
      summary: 'Add or update one contact',
      description: 'Matched by email. Values update; blanks never erase. Returns 201 when created, 200 when updated.',
      body: body(ref('ContactInput')),
      res: json(obj({ created: bool(), contact: ref('ContactDetail') }), 'Created'),
      status: '201',
    }),
  },
  '/contacts/import': {
    post: op({
      tag: 'Contacts',
      summary: 'Import many contacts',
      description: 'Each row needs email (or to); name optional; other keys become fields. Up to 5000 rows.',
      body: body(obj({ rows: arr(freeform()), lists: arr(str()) }, ['rows'])),
      res: json(obj({ rows: int(), created: int(), updated: int(), invalid: arr(obj({ row: int(), reason: str(), value: str() })), lists: arr(obj({ list: str(), added: int() })), on_do_not_send: int() })),
    }),
  },
  '/contacts/lists': {
    post: op({
      tag: 'Contacts',
      summary: 'Add contacts to lists / remove them',
      description: 'Contacts by id, email, or everyone matching a filter (same as GET /contacts). Lists in add are created if missing; unknown emails come back in not_found.',
      body: body(obj({ ids: arr(int()), emails: arr(str()), filter: obj({ list: { oneOf: [str(), int()] }, q: str(), rules: arr(obj({ field: str(), op: str(), value: {} }, ['field', 'op'])), match: str(undefined, { enum: ['all', 'any'] }) }, [], ), exclude_ids: arr(int(), 'With filter: leave these out'), add: arr(str()), remove: arr(str()) })),
      res: json(obj({ added: int(), removed: int(), not_found: arr(str()) })),
    }),
  },
  '/contacts/delete': { post: op({ tag: 'Contacts', summary: 'Delete contacts', description: 'By id, email, or everyone matching a filter. Email history is kept.', body: body(obj({ ids: arr(int()), emails: arr(str()), filter: obj({ list: { oneOf: [str(), int()] }, q: str(), rules: arr(obj({ field: str(), op: str(), value: {} }, ['field', 'op'])), match: str(undefined, { enum: ['all', 'any'] }) }, [], ), exclude_ids: arr(int(), 'With filter: leave these out') })), res: json(obj({ deleted: int() })) }) },
  '/contacts/{id}': {
    get: op({ tag: 'Contacts', summary: 'One contact with its emails', params: [pathId()], res: json(ref('ContactDetail')) }),
    patch: op({
      tag: 'Contacts',
      summary: 'Edit a contact',
      description: '`set` adds/changes fields, `remove` deletes fields, `fields` replaces all of them.',
      params: [pathId()],
      body: body(obj({ name: str(), set: freeform(), remove: arr(str()), fields: freeform() })),
      res: json(ref('ContactDetail')),
    }),
  },

  '/lists': {
    get: op({ tag: 'Lists', summary: 'All lists with contact counts', res: json(arr(ref('List'))) }),
    post: op({ tag: 'Lists', summary: 'Create a list', body: body(obj({ name: str(), description: str() }, ['name'])), res: json(ref('List'), 'Created'), status: '201' }),
  },
  '/lists/{id}': {
    patch: op({ tag: 'Lists', summary: 'Rename a list', params: [pathId()], body: body(obj({ name: str(), description: str() })), res: json(ref('List')) }),
    delete: op({ tag: 'Lists', summary: 'Delete a list (contacts stay)', params: [pathId()] }),
  },
  '/lists/preview': { post: op({ tag: 'Lists', summary: 'Who a list send would reach, and who is skipped', body: body(ref('ListSendInput')), res: json(ref('ListPreview')) }) },
  '/lists/send': {
    post: op({
      tag: 'Lists',
      summary: 'Schedule to contacts on lists',
      description: 'Each contact once: everyone, or those matching filter, in sort order, up to limit. With template_id, anyone who already has it is skipped, so re-sending to a growing list reaches only new contacts, and re-sending with a limit reaches the next ones. Up to 5000 per send.',
      body: body(ref('ListSendInput')),
      res: json(obj({ contacts: int(), scheduled: int(), held_back: int('Could get it, but beyond limit'), skipped: arr(obj({ to: str(), reason: str() })), first_send_at: time(), last_send_at: time(), emails: arr(freeform()) }), 'Created'),
      status: '201',
    }),
  },

  '/replies': {
    get: op({
      tag: 'Replies',
      summary: 'Replies to your emails',
      params: [query('campaign', str()), query('mailbox', str()), query('purpose', PURPOSE), query('group', str()), query('kind', str(undefined, { enum: ['reply', 'stop', 'auto', 'bounce'] })), query('category', str(), '"(none)" for uncategorized'), query('since', str()), query('limit', int()), query('offset', int())],
      res: json(obj({ total: int(), replies: arr(ref('Reply')) })),
    }),
  },
  '/replies/{id}/redeliver': { post: op({ tag: 'Replies', summary: 'Send the reply webhook again', params: [pathId()], res: json(obj({ delivered: int(), attempted: int() })) }) },
  '/replies/{id}/category': {
    post: op({ tag: 'Replies', summary: 'Set a reply category by hand', description: '"stop" adds the sender to do-not-send.', params: [pathId()], body: body(obj({ category: str() }, ['category'])), res: json(ref('Reply')) }),
  },
  '/replies/{id}/categorize': { post: op({ tag: 'Replies', summary: 'Ask the AI categorizer again', params: [pathId()], res: json(obj({ reply: ref('Reply'), result: ref('CategorizeResult') })) }) },

  '/categories': {
    get: op({ tag: 'Reply categories', summary: 'Reply categories', res: json(arr(ref('Category'))) }),
    post: op({
      tag: 'Reply categories',
      summary: 'Create or update a category',
      body: body(obj({ name: str(), description: str(), rename_to: str(), create_only: bool('Fail if it exists') }, ['name', 'description'])),
      res: json(ref('Category')),
    }),
  },
  '/categories/{name}': { delete: op({ tag: 'Reply categories', summary: 'Delete a category (not "stop")', params: [pathId('name', 'Category name')] }) },
  '/ai': {
    get: op({ tag: 'Reply categories', summary: 'Categorizer settings', res: json(ref('AiConfig')) }),
    put: op({ tag: 'Reply categories', summary: 'Set the categorizer model and outreach context', body: body(obj({ model: str(), context: str() })), res: json(ref('AiConfig')) }),
  },
  '/ai/test': { post: op({ tag: 'Reply categories', summary: 'Categorize any text (one real model call)', body: body(obj({ text: str(), subject: str() }, ['text'])), res: json(ref('CategorizeResult')) }) },

  '/campaigns': { get: op({ tag: 'Campaigns', summary: 'Stats for every campaign', res: json(arr(ref('Campaign'))) }) },
  '/campaigns/{name}': {
    get: op({
      tag: 'Campaigns',
      summary: 'One campaign with daily breakdown and reply categories',
      params: [pathId('name', 'Campaign name')],
      res: json({ allOf: [ref('Campaign'), obj({ daily: arr(freeform()), reply_categories: arr(obj({ category: str(), n: int() })) })] }),
    }),
  },

  '/dnc': {
    get: op({ tag: 'Do-not-send', summary: 'The do-not-send list', params: [query('q', str()), query('scope', SCOPE), query('limit', int()), query('offset', int())], res: json(obj({ total: int(), entries: arr(ref('DncEntry')) })) }),
    post: op({
      tag: 'Do-not-send',
      summary: 'Add addresses',
      description: 'scope defaults to all. An address already on the list keeps the wider scope. Scheduled emails the entry blocks are skipped.',
      body: body(obj({ emails: arr(str()), reason: str(), scope: SCOPE })),
      res: json(obj({ added: int(), cancelled: int(), scope: SCOPE })),
    }),
    delete: op({ tag: 'Do-not-send', summary: 'Remove addresses', body: body(obj({ emails: arr(str()) })), res: json(obj({ removed: int() })) }),
  },
};

export function openApiSpec(baseUrl: string, appName: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: `${appName} API`,
      version: '1.0.0',
      description:
        'REST API for scheduling outbound email from connected Gmail mailboxes, with templates, contacts and lists, reply tracking and do-not-send.\n\n' +
        '**Authentication:** send your passcode as `Authorization: Bearer <PASSCODE>` (click **Authorize**). While signed in to the app in this browser, requests also work through your session.\n\n' +
        `The same actions are available to AI agents over MCP at \`${baseUrl}/mcp\`.`,
    },
    servers: [{ url: `${baseUrl}/api` }],
    security: [{ passcode: [] }],
    tags: ['General', 'Settings', 'Mailboxes', 'Mailbox groups', 'Senders', 'Emails', 'Templates', 'Series', 'Contacts', 'Lists', 'Replies', 'Reply categories', 'Campaigns', 'Do-not-send'].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { passcode: { type: 'http', scheme: 'bearer', description: 'Your PASSCODE' } },
      responses: {
        BadRequest: json(ref('Error'), 'Invalid request'),
        Unauthorized: json(ref('Error'), 'Missing or wrong passcode'),
        NotFound: json(ref('Error'), 'Not found'),
      },
      schemas,
    },
  };
}

/** Swagger UI page (assets from the swagger-ui-dist CDN). */
export function swaggerPage(appName: string) {
  const title = `${appName} API`.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light"><title>${title}</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">
<style>html{color-scheme:light;background:#fff}body{margin:0;background:#fff} .topbar{display:none}</style></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/api-docs/openapi.json',
    dom_id: '#ui',
    deepLinking: true,
    persistAuthorization: true,
    tryItOutEnabled: false,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    requestInterceptor: (req) => { req.credentials = 'same-origin'; return req; },
  });
</script></body></html>`;
}
