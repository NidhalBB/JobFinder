import { telegramConfig } from '../telegram.mjs';

try {
  const config = telegramConfig();
  if (!config) throw new Error('Configure TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET and PUBLIC_ORIGIN in the server environment first.');
  async function call(method, body) {
    let response;
    try {
      response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { throw new Error('Could not reach Telegram. Check network access; bot secrets have not been printed.'); }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(`Telegram rejected ${method} (HTTP ${response.status}). Verify your bot configuration.`);
    return data.result;
  }
  const bot = await call('getMe', {});
  if (bot.username?.toLowerCase() !== config.username.toLowerCase()) throw new Error('Bot username does not match the configured token. Correct TELEGRAM_BOT_USERNAME.');
  await call('setWebhook', {
    url: `${config.origin}/api/telegram/webhook`, secret_token: config.secret,
    allowed_updates: ['message'], max_connections: 1,
  });
  console.log(`Telegram webhook registered for ${config.origin}. Users can now opt in from Profile & preferences.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
