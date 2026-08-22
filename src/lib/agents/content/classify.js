// Content pipeline — relevance classifier (PURE, uses the shared callClaude wrapper).
//
// Given a normalized news item + a product config, decides whether the item is worth turning
// into a community post, and if so tags it with a topic + segment. Irrelevant items are
// dropped by the orchestrator BEFORE the (more expensive) generation step — cost control
// belongs early, so this runs on the cheap classify model.
//
// Returns (never throws):
//   { relevant, topic, segment, score, usage, costUsd }  on a successful call
//   { error, ...cost }                                    on a call failure
const { callClaude } = require('../../llm');

const CLASSIFY_PROMPT_VERSION = 'content-classify-v1';

function buildPrompt(item, config) {
  return `You are a content curator for ${config.description}. Decide whether the news item below is genuinely relevant to that community, and if so classify it.
${config.classifyGuidance ? '\n' + config.classifyGuidance + '\n' : ''}
ITEM:
Title: ${item.title || '(none)'}
Summary: ${item.summary || '(none)'}
URL: ${item.url || '(none)'}
Published: ${item.published_at || '(unknown)'}

Return ONLY this JSON, no prose, no code fences:
{
  "relevant": true,
  "topic": "one of: ${config.topics.join(', ')}",
  "segment": "one of: ${config.segments.join(', ')}",
  "score": 0.0
}

Rules:
- relevant=false if the item is off-topic, spam, or not about this community — when false, topic/segment may be null.
- topic = null if none of the listed topics clearly fits.
- segment = who the post would be FOR; null if unclear.
- score is 0-1 confidence that this makes a worthwhile community post.`;
}

async function classifyItem(item, config, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const prompt = buildPrompt(item, config);
  const r = await callClaude({ model: config.classifyModel, prompt, maxTokens: 300, expectJson: true, apiKey });
  if (r.error) return { error: r.error, usage: r.usage || null, costUsd: r.costUsd || 0, prompt_version: CLASSIFY_PROMPT_VERSION };

  const data = r.json;
  const cost = { usage: r.usage || null, costUsd: r.costUsd || 0, prompt_version: CLASSIFY_PROMPT_VERSION };
  if (!data) return { relevant: false, topic: null, segment: null, score: 0, unparseable: true, ...cost };

  return {
    relevant: data.relevant === true,
    topic: config.topics.includes(data.topic) ? data.topic : null,
    segment: config.segments.includes(data.segment) ? data.segment : null,
    score: (typeof data.score === 'number') ? Math.min(1, Math.max(0, data.score)) : null,
    ...cost,
  };
}

module.exports = { classifyItem, buildPrompt, CLASSIFY_PROMPT_VERSION };
