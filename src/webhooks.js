const axios = require('axios');

const THREAT_EMOJI = { low: '🟢', medium: '🟡', high: '🔴' };
const THREAT_COLOR = { low: 0x10b981, medium: 0xf59e0b, high: 0xef4444 };
const THREAT_HEX = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };

async function sendSlackAlert(webhookUrl, competitor, analysis, changeId) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const emoji = THREAT_EMOJI[analysis.threat_level] || '⚪';

  const payload = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔍 Competitor Change: ${competitor.name}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${analysis.headline}*\n${analysis.summary}` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Threat Level*\n${emoji} ${analysis.threat_level.toUpperCase()}` },
          { type: 'mrkdwn', text: `*Page*\n<${competitor.url}|View Page>` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Recommended Action*\n${analysis.recommended_response}` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Sales Talking Points*\n${analysis.talking_points.map(p => `• ${p}`).join('\n')}`,
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Foresight | <${appUrl}/#/history/${changeId}|View Full Brief>` },
        ],
      },
    ],
  };

  await axios.post(webhookUrl, payload, { timeout: 10000 });
}

async function sendDiscordAlert(webhookUrl, competitor, analysis, changeId) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const emoji = THREAT_EMOJI[analysis.threat_level] || '⚪';

  const payload = {
    username: 'Foresight',
    embeds: [
      {
        title: `🔍 ${competitor.name} — Page Changed`,
        description: `**${analysis.headline}**\n\n${analysis.summary}`,
        color: THREAT_COLOR[analysis.threat_level] || 0x6366f1,
        fields: [
          { name: `${emoji} Threat Level`, value: analysis.threat_level.toUpperCase(), inline: true },
          { name: '🌐 URL', value: `[View Page](${competitor.url})`, inline: true },
          { name: '🎯 Recommended Action', value: analysis.recommended_response, inline: false },
          { name: '💬 Sales Talking Points', value: analysis.talking_points.map(p => `• ${p}`).join('\n'), inline: false },
        ],
        url: `${appUrl}/#/history/${changeId}`,
        footer: { text: 'Foresight • AI-Powered Competitive Intelligence' },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await axios.post(webhookUrl, payload, { timeout: 10000 });
}

async function sendAlerts(settings, competitor, analysis, changeId) {
  const promises = [];

  if (settings.slack_webhook) {
    promises.push(
      sendSlackAlert(settings.slack_webhook, competitor, analysis, changeId)
        .catch(err => console.error(`Slack alert failed for change ${changeId}:`, err.message))
    );
  }

  if (settings.discord_webhook) {
    promises.push(
      sendDiscordAlert(settings.discord_webhook, competitor, analysis, changeId)
        .catch(err => console.error(`Discord alert failed for change ${changeId}:`, err.message))
    );
  }

  await Promise.all(promises);
}

module.exports = { sendAlerts, sendSlackAlert, sendDiscordAlert };
