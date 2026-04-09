import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const pushEnv = readEnvFile(['PUSHOVER_USER_KEY', 'PUSHOVER_API_TOKEN']);

export function isSmsConfigured(): boolean {
  return !!(pushEnv.PUSHOVER_USER_KEY && pushEnv.PUSHOVER_API_TOKEN);
}

/** Send a push notification via Pushover. Named sendSms for backward compat with pipes/MCP. */
export async function sendSms(body: string): Promise<boolean> {
  const user = pushEnv.PUSHOVER_USER_KEY;
  const token = pushEnv.PUSHOVER_API_TOKEN;

  if (!user || !token) {
    logger.warn(
      'Pushover not configured — set PUSHOVER_USER_KEY and PUSHOVER_API_TOKEN in .env',
    );
    return false;
  }

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, user, message: body, title: 'Albot' }),
    });

    if (!res.ok) {
      const err = (await res.json()) as { errors?: string[] };
      logger.error({ errors: err.errors }, 'Pushover notification failed');
      return false;
    }

    logger.info('Pushover notification sent');
    return true;
  } catch (err) {
    logger.error({ err }, 'Pushover send error');
    return false;
  }
}
