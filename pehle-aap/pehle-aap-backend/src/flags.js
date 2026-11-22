const Flagsmith = require('flagsmith-nodejs');

let client;
function getClient() {
  if (!process.env.FLAGSMITH_SERVER_KEY) return null;
  if (!client) client = new Flagsmith({
    environmentKey: process.env.FLAGSMITH_SERVER_KEY,
    enableLocalEvaluation: true,
    environmentRefreshIntervalSeconds: Number(process.env.FLAGSMITH_REFRESH_SECONDS || 10)
  });
  return client;
}
async function flagsFor(person) {
  const fs = getClient();
  if (!fs) return { source: 'defaults', flags: defaults() };
  try {
    const result = await fs.getIdentityFlags(person.id, {
      role: person.role, wedding: person.wedding_id, elders: Boolean(person.elders)
    });
    const flags = {};
    for (const key of Object.keys(defaults())) {
      flags[key] = result.isFeatureEnabled(key);
      const value = result.getFeatureValue(key);
      if (value !== undefined && value !== null) {
        try { flags[key] = JSON.parse(value); } catch { flags[key] = value; }
      }
    }
    return { source: 'flagsmith', flags };
  } catch (e) {
    console.error(JSON.stringify({ level:'warn', event:'flagsmith_fallback', message:e.message }));
    return { source: 'defaults', flags: defaults() };
  }
}
function defaults() {
  return {
    low_bandwidth_mode: false, photo_upload_enabled: true, upi_button: true,
    push_notifications: true, pinky_bua: true, voice_announcements: true,
    risk_bar_voice: false,
    queue_due_minutes: { regular: 45, elder: 15, leave_buffer: 10 },
    stage_time_seed: { a: 30, b: 8 }, poll_interval_s: 20,
    plate_margin: 0.10, expense_category_threshold: 0.8,
    thank_you_variant: 'photos-first'
  };
}
module.exports = { flagsFor };
