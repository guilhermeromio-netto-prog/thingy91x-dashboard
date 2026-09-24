/**
 * Scheduled warm for alerts (v27).
 * Requires Netlify schedule + env: MEMFAULT_OAT (or MEMFAULT_USER_API_KEY),
 * NRF_TEAM_WRITE_TOKEN (or NRF_TEAM_READ_TOKEN), ALERT_DEFAULT_DEVICE_ID.
 * Does not persist — only evaluates and logs (Blobs optional later).
 */
import { handler as alertsHandler } from './alerts.js';

export async function handler(event, context) {
  const deviceId = (process.env.ALERT_DEFAULT_DEVICE_ID || '').trim();
  const synthetic = {
    httpMethod: 'GET',
    path: '/.netlify/functions/alerts',
    headers: {
      ...(event?.headers || {}),
      'x-nf-scheduled': '1',
      ...(deviceId ? { 'x-device-id': deviceId } : {}),
    },
    queryStringParameters: {
      ...(deviceId ? { deviceId } : {}),
      warm: '1',
    },
  };
  const res = await alertsHandler(synthetic, context);
  console.log(`[alerts-schedule] status=${res.statusCode} body=${String(res.body || '').slice(0, 200)}`);
  return res;
}
