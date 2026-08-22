// Content pipeline — post generator (PURE, uses the shared callClaude wrapper).
//
// Given a RELEVANT news item + its classification + the product config, writes a short
// community post grounded ONLY in the item (no invented facts). Runs on the higher-quality
// generate model; only items that passed the classifier reach here.
//
// Returns (never throws):
//   { headline, body, usage, costUsd }  on success
//   { error, ...cost }                  on a call failure or unparseable output
const { callClaude } = require('../../llm');

const GENERATE_PROMPT_VERSION = 'content-generate-v1';

function buildPrompt(item, classification, config) {
  const topic = (classification && classification.topic) || 'general';
  const segment = (classification && classification.segment) || 'the community';
  return `You are writing a SHORT community content post for ${config.description}.

VOICE: ${config.voice}
AUDIENCE: ${segment}
TOPIC: ${topic}

Base the post ONLY on this news item — do not invent facts, statistics, names, dates, or quotes:
Title: ${item.title || '(none)'}
Summary: ${item.summary || '(none)'}
URL: ${item.url || '(none)'}

Return ONLY this JSON, no prose, no code fences:
{"headline":"...","body":"..."}

Rules:
- headline: under 100 characters, specific, no clickbait.
- body: 2-3 short plain-text paragraphs (~80-150 words total), separated by \\n line breaks.
- No hashtags, no emoji, no markdown, no invented figures.
- If the item is thin, keep it brief rather than padding with speculation.`;
}

async function generateContent(item, classification, config, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const prompt = buildPrompt(item, classification, config);
  const r = await callClaude({ model: config.generateModel, prompt, maxTokens: 900, expectJson: true, apiKey });
  const cost = { usage: r.usage || null, costUsd: r.costUsd || 0, prompt_version: GENERATE_PROMPT_VERSION };
  if (r.error) return { error: r.error, ...cost };

  const data = r.json;
  if (!data || !data.headline || !data.body) return { error: 'unparseable content JSON', ...cost };

  return {
    headline: String(data.headline).trim().slice(0, 300),
    body: String(data.body).trim(),
    ...cost,
  };
}

module.exports = { generateContent, buildPrompt, GENERATE_PROMPT_VERSION };
