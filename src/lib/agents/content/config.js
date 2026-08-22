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
    // Injected into the CLASSIFIER prompt only (classify.js), not the generator. Tightens
    // relevance so an item passes ONLY when the golf business or the golf playing experience
    // IS the subject — not merely mentioned. Worked examples discipline the model better than
    // rules alone, so one clear pass / one clear fail / one borderline are included.
    classifyGuidance: `RELEVANCE BAR — pass an item ONLY if its SUBJECT is the golf business or the golf playing experience. If golf is merely mentioned or incidental, mark it NOT relevant.

RELEVANT (the golf business / playing experience is the subject):
- course openings, closures, renovations, or ownership changes
- equipment releases and reviews
- tournament results and schedules
- instruction and technique
- industry trends, pricing, participation data
- facility operations

NOT RELEVANT (golf is incidental, a detail, or a backdrop):
- celebrity or property/real-estate stories where a course happens to be a feature
- general business, finance, or M&A news that merely mentions a golf course
- sports or lifestyle news with no golf-operations or golf-play angle
- anything where the golf connection is a passing detail rather than the topic

WORKED EXAMPLES:
- PASS: "Pebble Beach begins $20M clubhouse and course renovation" → relevant (course renovation is the subject; topic=course-openings).
- FAIL: "AI researcher buys $80M California estate that includes a private nine-hole course" → NOT relevant (a celebrity property story; the course is one incidental amenity, not the subject).
- BORDERLINE: "City council debates raising the municipal golf course's operating budget" → relevant (facility operations / pricing IS the subject, even though it's local-government news).`,
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
