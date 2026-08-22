// Content pipeline — per-product configuration. Adding a NEW product is a config entry
// here, NOT new code: the source adapter, classifier, generator, and orchestrator are all
// product-agnostic and read everything they need from this object.
//
// A config supplies: the community it serves (description), the NewsAPI search query, the
// classifier's allowed topics + segments, the generator's voice, and which model each stage
// uses (classify cheap, generate higher-quality).

const CONFIGS = {
  golfnex: {
    product: 'golfnex',
    description: 'GolfNex, a golf-facility management and community platform for golf courses and the people who play them',
    // NewsAPI query — broad golf-community coverage across the topic set below.
    query: '(golf equipment OR golf tournament OR golf course opening OR golf instruction OR golf industry)',
    topics: ['equipment', 'tournaments', 'course-openings', 'instruction', 'industry'],
    segments: ['facility_owner', 'player'],
    voice: 'Friendly, knowledgeable golf-community voice — concise, upbeat, and practical. '
      + 'Write like a helpful club pro, not a marketer. No hype, no clickbait, no exclamation spam.',
    classifyModel: 'claude-haiku-4-5-20251001', // cheap gate — most items get dropped here
    generateModel: 'claude-sonnet-5',            // only the relevant few reach this
  },
};

function getConfig(product) {
  return CONFIGS[product] || null;
}

module.exports = { getConfig, CONFIGS };
