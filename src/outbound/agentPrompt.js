// Loads prompts/outbound-agent.md once and caches it. This file is the system
// prompt for the drafting call (see pipeline.js). Kept in the repo (not inline)
// so the outreach voice can be tuned without touching code.

const fs = require('fs');
const path = require('path');

let cached;

function getAgentPrompt() {
  if (cached) return cached;
  try {
    cached = fs.readFileSync(path.join(__dirname, '../../prompts/outbound-agent.md'), 'utf8');
  } catch (err) {
    console.warn('[outbound] could not load prompts/outbound-agent.md:', err?.message || err);
    // Minimal fallback so drafting still runs if the file is missing.
    cached = 'You write short, human, specific B2B outreach for Nivaria, a competitor-'
      + 'intelligence app. One trigger, one low-friction ask. Never use em-dashes, '
      + 'en-dashes, or a connecting "+". Return the message body only.';
  }
  return cached;
}

module.exports = { getAgentPrompt };
