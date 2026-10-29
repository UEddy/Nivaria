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
          { type: 'mrkdwn', text: `Nivaria | <${appUrl}/#/history/${changeId}|View Full Brief>` },
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
    username: 'Nivaria',
    embeds: [
      {
        title: `🔍 ${competitor.name}: Page Changed`,
        description: `**${analysis.headline}**\n\n${analysis.summary}`,
        color: THREAT_COLOR[analysis.threat_level] || 0x6366f1,
        fields: [
          { name: `${emoji} Threat Level`, value: analysis.threat_level.toUpperCase(), inline: true },
          { name: '🌐 URL', value: `[View Page](${competitor.url})`, inline: true },
          { name: '🎯 Recommended Action', value: analysis.recommended_response, inline: false },
          { name: '💬 Sales Talking Points', value: analysis.talking_points.map(p => `• ${p}`).join('\n'), inline: false },
        ],
        url: `${appUrl}/#/history/${changeId}`,
        footer: { text: 'Nivaria • AI-Powered Competitive Intelligence' },
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

// Phase 9 — forward-looking pattern alert. Fired when a competitor repeats a
// kind of move (pricing / messaging / feature) the user subscribed to from a
// pattern card on the Revenue Impact Dashboard. Deliberately terse: it's a nudge, not a
// full brief. Deal values are never included — this goes to a shared channel.
async function sendPatternAlert(settings, competitor, analysis, changeId, typeLabel) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const headline = analysis?.headline ? `: ${analysis.headline}` : '';
  const slackText = `:rotating_light: *Pattern alert*: ${competitor.name} just made a ${typeLabel}${headline}. This is the kind of move that has correlated with deals you lost. <${appUrl}/app#/history/${changeId}|View change> · <${appUrl}/app#/deals|Revenue Impact Dashboard>`;
  const discordText = `🚨 **Pattern alert**: ${competitor.name} just made a ${typeLabel}${headline}. This is the kind of move that has correlated with deals you lost. [View change](${appUrl}/app#/history/${changeId})`;

  const promises = [];
  if (settings.slack_webhook) {
    promises.push(axios.post(settings.slack_webhook, { text: slackText }, { timeout: 10000 })
      .catch(err => console.error(`Pattern-alert Slack failed for change ${changeId}:`, err.message)));
  }
  if (settings.discord_webhook) {
    promises.push(axios.post(settings.discord_webhook, { content: discordText }, { timeout: 10000 })
      .catch(err => console.error(`Pattern-alert Discord failed for change ${changeId}:`, err.message)));
  }
  await Promise.all(promises);
}

// Taste Gap: a finished brief, sent on request from the brief page. summary
// comes from tasteShares.briefSummary: the pair, the headline, up to three
// win-first picks (segment, campaign hook, Qloo numbers) and the public link.
// Throws on a failed post so the page can say so.
function slackEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTasteBriefSlack(webhookUrl, summary) {
  const picks = summary.picks.map(p => `*${p.rank}. ${slackEscape(p.segment)}*\n${slackEscape(p.hook)}${p.numbers ? `\n_${slackEscape(p.numbers)}_` : ''}`);
  const payload = {
    text: `Taste Gap brief: ${summary.headline}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: summary.pair.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(summary.headline)}*` } },
      ...(picks.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Win these first*\n\n${picks.join('\n\n')}`.slice(0, 2900) } }] : []),
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the full brief' }, url: summary.url }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Made with Nivaria · powered by Qloo | <${summary.url}|${slackEscape(summary.url)}>` }] },
    ],
  };
  await axios.post(webhookUrl, payload, { timeout: 10000 });
}

async function sendTasteBriefDiscord(webhookUrl, summary) {
  const payload = {
    username: 'Nivaria',
    embeds: [{
      title: summary.pair.slice(0, 250),
      url: summary.url,
      description: `**${summary.headline}**`.slice(0, 4000),
      color: 0x6366f1,
      fields: summary.picks.map(p => ({
        name: `${p.rank}. ${p.segment}`.slice(0, 250),
        value: (p.hook + (p.numbers ? `\n*${p.numbers}*` : '')).slice(0, 1000) || '\u200b',
        inline: false,
      })),
      footer: { text: 'Made with Nivaria · powered by Qloo' },
      timestamp: new Date().toISOString(),
    }],
    content: `Full brief: ${summary.url}`,
  };
  await axios.post(webhookUrl, payload, { timeout: 10000 });
}

module.exports = { sendAlerts, sendSlackAlert, sendDiscordAlert, sendPatternAlert, sendTasteBriefSlack, sendTasteBriefDiscord };
