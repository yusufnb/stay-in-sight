import { getSettings, updateSettings, withConfig } from './config';
import { renewWatches } from './sync';
import { Env } from './util';

/** Save app settings and apply side effects; returns the fresh settings list. */
export async function saveSettings(env: Env, patch: Record<string, unknown>) {
  const deployEnv = env.DEPLOY_ENV ?? env;
  const changed = await updateSettings(env, patch);
  const next = await withConfig(deployEnv);
  let watch: { renewed: number } | undefined;
  if (changed.includes('GMAIL_PUBSUB_TOPIC')) {
    // Point every mailbox's Gmail watch at the new topic now (or let them lapse if it was cleared).
    await env.DB.prepare('UPDATE mailboxes SET watch_expires_at = NULL').run();
    if (next.GMAIL_PUBSUB_TOPIC) watch = await renewWatches(next, true);
  }
  return { changed, watch, settings: await getSettings(next, deployEnv) };
}

export const readSettings = (env: Env) => getSettings(env, env.DEPLOY_ENV ?? env);
