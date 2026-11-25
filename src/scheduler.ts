// On the SleekSky platform, apps have no cron triggers. This Durable Object does the same work as the self-hosted
// cron (send what's due, sync replies, deliver webhooks, renew Gmail watches) on a 1-minute alarm. The manifest's
// 15-minute schedule (POST /_sky/tick, sleeksky.json "schedules") wakes it, so the alarm is restarted if it ever
// stops. Platform sign-in wakes it too.
import type { Env } from './util';
import { withConfig } from './config';
import { runCron } from './index';

const EVERY_MS = 60_000;

// A plain class (no `cloudflare:workers` import), so the app's Node tests can still load index.ts.
export class Scheduler {
  constructor(private state: DurableObjectState, private env: Env) {}

  /** Makes sure the alarm is set; answers when it last ran and when it runs next. */
  async fetch(): Promise<Response> {
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 1000);
    return Response.json({ next: await this.state.storage.getAlarm(), lastRun: (await this.state.storage.get<number>('lastRun')) ?? null });
  }

  async alarm(): Promise<void> {
    // The next run is set first, so a run that throws (or runs long) doesn't stop the schedule.
    await this.state.storage.setAlarm(Date.now() + EVERY_MS);
    await runCron(await withConfig(this.env));
    await this.state.storage.put('lastRun', Date.now());
  }
}
