// LinkedIn AI Content Engine — generates pharma/biotech posts for the Abiozen
// company page. Weekly campaign pulls combined demand signals (market analysis +
// GSC + Algolia), enriches against the catalog, and drafts 3 posts (Mon product /
// Wed trend / Fri capability). Drafts go into linkedin_content_queue; approval
// auto-publishes via the LinkedIn UGC API.
const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { logAgentActivity, getCEOUser, parseClaudeJSON } = require('../agent-core');

const AGENT = 'linkedin-agent';
const MAX_POST_CHARS = 1300;
const DEFAULT_HASHTAGS = '#Pharmaceuticals #API #Biotech #DrugDiscovery #ResearchChemicals';

const isoDay = d => new Date(d).toISOString().slice(0, 10);

function clampPost(text) {
  if (!text) return '';
  return text.length <= MAX_POST_CHARS ? text : text.slice(0, MAX_POST_CHARS - 1).replace(/\s+\S*$/, '') + '…';
}

// Shared assembler: pulls headline/body/hashtags/full_post out of Claude's JSON,
// builds full_post if Claude omitted it, and clamps to LinkedIn's 1300-char limit.
function composePost(post_type, parsed, source_molecule) {
  const headline = parsed.headline || parsed.title || parsed.hook || '';
  const body = parsed.body || parsed.text || parsed.post || '';
  const hashtags = typeof parsed.hashtags === 'string'
    ? parsed.hashtags
    : Array.isArray(parsed.hashtags)
      ? parsed.hashtags.map(h => h.startsWith('#') ? h : '#' + h).join(' ')
      : DEFAULT_HASHTAGS;
  let full_post = parsed.full_post || [headline, body, hashtags].filter(Boolean).join('\n\n');
  full_post = clampPost(full_post);
  return { post_type, headline, body, hashtags, full_post, source_molecule: source_molecule || null };
}

// 1) Product post — uses the user's exact prompt structure.
async function generateProductPost(molecule) {
  const m = typeof molecule === 'string' ? { name: molecule } : (molecule || {});
  const molecule_name = (m.name || '').trim();
  const cas_number = (m.cas || m.cas_number || '').trim();
  const purity = (m.purity || '99%').toString().trim();
  if (!molecule_name) throw new Error('generateProductPost requires a molecule name');

  const prompt = `You are a LinkedIn content writer for Abiozen LLC, a US-based pharmaceutical API distributor.

Generate a professional LinkedIn post about ${molecule_name} (CAS: ${cas_number || 'not provided'}, Purity: ${purity}).

The post must:
- Be written for biotech/pharma procurement managers, lab directors, and researchers
- Highlight: availability, ${purity} purity, COA available, 3-5 day US delivery
- Include market relevance and why this molecule matters now
- End with CTA: "Available now at abiozen.com | Request quote: naren@abiozen.com"
- Be under 1300 characters total
- Sound authoritative and professional, not salesy

Return ONLY valid JSON in this exact format:
{
  "headline": "compelling 10-word headline",
  "body": "the full post body text",
  "hashtags": "#Pharmaceuticals #API #Biotech #DrugDiscovery #ResearchChemicals",
  "full_post": "headline + body + hashtags combined"
}`;

  const raw = await runClaudeAnalysis(prompt);
  console.log('[linkedin-agent] generateProductPost raw response (first 600 chars):', String(raw || '').slice(0, 600));
  const parsed = parseClaudeJSON(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    console.error('[linkedin-agent] generateProductPost: failed to parse Claude JSON. Raw:', String(raw || '').slice(0, 500));
    throw new Error('Claude returned an unparseable LinkedIn product post');
  }
  return composePost('product', parsed, molecule_name);
}

// 2) Wednesday market-trend post — uses combined demand signals.
async function generateMarketTrendPost(molecules = []) {
  const top = molecules.slice(0, 5);
  const list = top.length
    ? top.map((m, i) => `${i + 1}. ${m.name}${m.in_catalog ? ' (in stock)' : ''} — demand score ${m.demand_score || '?'}`).join('\n')
    : '(no signals available — write a generic 2026 pharma trend post)';

  const prompt = `You are a LinkedIn content writer for Abiozen LLC, a US-based pharmaceutical API distributor.

Generate a professional LinkedIn post about THIS WEEK'S MARKET TREND in pharmaceutical APIs, using the demand signals below:

${list}

The post must:
- Open with a hook about why pharma buying patterns are shifting in 2026
- Reference 2-3 of the molecules above as examples
- Position Abiozen as a market-intelligence source for procurement managers and lab directors
- Be authoritative and analytical, not salesy
- End with CTA: "Track demand trends with us | naren@abiozen.com"
- Be under 1300 characters total

Return ONLY valid JSON in this exact format:
{
  "headline": "compelling 10-word headline about a 2026 pharma trend",
  "body": "the full post body referencing the molecules above",
  "hashtags": "#Pharmaceuticals #PharmaIntel #DrugDiscovery #Biotech #API",
  "full_post": "headline + body + hashtags combined"
}`;

  const raw = await runClaudeAnalysis(prompt);
  console.log('[linkedin-agent] generateMarketTrendPost raw (first 600 chars):', String(raw || '').slice(0, 600));
  const parsed = parseClaudeJSON(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    console.error('[linkedin-agent] generateMarketTrendPost: failed to parse Claude JSON. Raw:', String(raw || '').slice(0, 500));
    throw new Error('Claude returned an unparseable market-trend post');
  }
  return composePost('market_intelligence', parsed, null);
}

// 3) Friday capability post — Abiozen QC + sourcing highlight.
async function generateCapabilityPost() {
  const prompt = `You are a LinkedIn content writer for Abiozen LLC, a US-based pharmaceutical API distributor.

Generate a professional LinkedIn post highlighting Abiozen's CAPABILITIES — specifically QC testing services and API sourcing services for biotech labs and pharma manufacturers.

The post must:
- Highlight: GMP-grade QC testing, COA generation, full SDS documentation, US-based logistics, 3-5 day delivery
- Speak directly to procurement managers, lab directors, and R&D leads
- Include CTA: "Available now at abiozen.com | Request quote: naren@abiozen.com"
- Sound professional and confident, not promotional
- Be under 1300 characters total

Return ONLY valid JSON in this exact format:
{
  "headline": "compelling 10-word headline about Abiozen capabilities",
  "body": "the full post body",
  "hashtags": "#Pharmaceuticals #API #QC #GMP #Biotech",
  "full_post": "headline + body + hashtags combined"
}`;

  const raw = await runClaudeAnalysis(prompt);
  console.log('[linkedin-agent] generateCapabilityPost raw (first 600 chars):', String(raw || '').slice(0, 600));
  const parsed = parseClaudeJSON(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    console.error('[linkedin-agent] generateCapabilityPost: failed to parse Claude JSON. Raw:', String(raw || '').slice(0, 500));
    throw new Error('Claude returned an unparseable capability post');
  }
  return composePost('company_update', parsed, null);
}

// Legacy alias — keep existing market_intelligence / company_update generators
// callable from the POST /linkedin/generate-post endpoint.
async function generateMarketIntelligencePost(analysisData) {
  let molecules = [];
  if (analysisData && Array.isArray(analysisData.top_molecules)) {
    molecules = analysisData.top_molecules.map(m => ({ name: m.molecule || m.name, demand_score: m.demand_signal === 'high' ? 90 : 50 }));
  } else {
    molecules = await getCombinedDemandMolecules();
  }
  return generateMarketTrendPost(molecules);
}
async function generateCompanyUpdate(/* metrics */) {
  return generateCapabilityPost();
}

// Short factual chemical profile — appended to the post body as a footer.
async function generateChemicalProfile({ name, cas }) {
  if (!name) return '';
  const prompt = `Provide a concise 2-3 sentence chemical profile of ${name}${cas ? ' (CAS ' + cas + ')' : ''} covering: molecular class or formula, primary mechanism or biological action, and why researchers or labs need it. Plain text only — no markdown, no JSON, no preamble. Under 280 characters total.`;
  try {
    const raw = await runClaudeAnalysis(prompt);
    if (!raw || raw.startsWith('Claude API') || raw.startsWith('Claude error')) return '';
    // Strip leading conversational tokens until the first capital letter
    const text = String(raw).replace(/^[^A-Z]*/, '').trim();
    return text.slice(0, 350);
  } catch (e) {
    console.error('[linkedin-agent] chemical profile generation failed:', e.message);
    return '';
  }
}

// Image prompt for DALL-E / Midjourney — templated by post type for reliability.
function generateImagePrompt(post_type, molecule_name) {
  const m = (molecule_name || '').trim();
  const hasMolecule = m && m.toLowerCase() !== 'pharmaceutical molecule';
  const exclusions = 'Strictly avoid: warehouses, distribution centers, glass vials, boxes, conveyor belts, logistics imagery, stock-photo aesthetics, any text or labels.';

  if (post_type === 'product' && hasMolecule) {
    return `Premium 3D molecular structure visualization of ${m}, crystalline chemical bonds suspended in light, abstract scientific art combining chemistry and computation, gradient deep blue and purple lighting, journal-cover quality, photorealistic with cinematic depth of field. ${exclusions}`;
  }

  if (post_type === 'market_intelligence') {
    const moleculeRef = hasMolecule ? ` with abstract visual reference to ${m} suggested through glowing molecular bonds in the composition` : '';
    return `Premium scientific data visualization, holographic molecular structures floating over abstract market data flows, neural-network-style connections suggesting AI-driven analysis, deep navy and teal palette with soft glowing accents, executive biotech aesthetic, journal-cover quality${moleculeRef}. ${exclusions}`;
  }

  if (post_type === 'company_update') {
    const moleculeRef = hasMolecule ? ` with abstract visual reference to ${m} suggested through glowing molecular bonds in the composition` : '';
    return `Premium abstract scientific composition suggesting innovation at the intersection of chemistry and artificial intelligence, flowing molecular patterns and computational geometry, deep color palette with soft glowing accents, modern AI-augmented research aesthetic, journal-cover quality, photorealistic with cinematic depth of field${moleculeRef}. ${exclusions}`;
  }

  // Fallback for any unknown post_type — same as company_update with no molecule
  return `Premium abstract scientific composition suggesting innovation at the intersection of chemistry and artificial intelligence, flowing molecular patterns and computational geometry, deep color palette with soft glowing accents, modern AI-augmented research aesthetic, journal-cover quality, photorealistic with cinematic depth of field. ${exclusions}`;
}

// Construct a PubChem 2D-structure PNG URL for a CAS number or chemical name.
// PubChem's PUG REST /compound/name/{lookup}/PNG accepts both. No fetch is
// performed — the URL is direct and the browser loads the image.
function getMoleculeStructureImage(casOrName) {
  if (!casOrName) return null;
  const encoded = encodeURIComponent(String(casOrName).trim());
  return `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encoded}/PNG`;
}

// Generate a 1024x1024 background image for a post via OpenAI DALL-E 3, then
// download it to public/linkedin-images/ (OpenAI URLs expire ~1h). Returns
// { url, prompt } on success, { skipped|error, reason } on failure.
async function generatePostImage(molecule_name, post_type) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { skipped: true, reason: 'OPENAI_API_KEY is not set' };

  // Single source of truth — the same template drives the displayed prompt (:638)
  // and the actually-generated image, so they never diverge.
  const prompt = generateImagePrompt(post_type, molecule_name);

  // OpenAI's image endpoint is the same path for every model — gpt-image-1,
  // dall-e-3, and dall-e-2 all POST to /v1/images/generations. The fallback
  // chain handles accounts where one or more models aren't enabled.
  const url = 'https://api.openai.com/v1/images/generations';
  const maskedKey = apiKey.slice(0, 7) + '…' + apiKey.slice(-4);

  // tryModel — one OpenAI request. Returns:
  //   { url, model }       — dall-e-* (or anything returning data[0].url)
  //   { b64, model }       — gpt-image-1 (returns data[0].b64_json by default)
  //   { error, status, raw } — any HTTP error
  async function tryModel(model, size, extraBody) {
    const body = { model, prompt, n: 1, size, ...(extraBody || {}) };
    console.log('[linkedin-agent] OpenAI image request →', JSON.stringify({
      url, method: 'POST',
      headers: { Authorization: 'Bearer ' + maskedKey, 'Content-Type': 'application/json' },
      body: { ...body, prompt: body.prompt.slice(0, 200) + (body.prompt.length > 200 ? '…' : '') },
    }, null, 2));

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error('[linkedin-agent] ' + model + ' network error:', e.message);
      return { error: 'network: ' + e.message, status: 0, raw: '' };
    }

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const hdrs = {};
      for (const [k, v] of res.headers.entries()) hdrs[k] = v;
      console.error('[linkedin-agent] ' + model + ' FAILED — status ' + res.status + ' ' + res.statusText);
      console.error('  response headers:', JSON.stringify(hdrs, null, 2));
      console.error('  response body:', t.slice(0, 800));
      return { error: 'OpenAI ' + res.status + ': ' + t.slice(0, 300), status: res.status, raw: t };
    }

    const data = await res.json();
    const item = (data.data && data.data[0]) || {};
    console.log('[linkedin-agent] ' + model + ' success — response keys:', Object.keys(data || {}).join(','),
      '· data[0] keys:', Object.keys(item).join(','));

    if (item.url) return { url: item.url, model };
    if (item.b64_json) return { b64: item.b64_json, model };
    console.error('[linkedin-agent] ' + model + ' returned neither url nor b64_json. Full response:', JSON.stringify(data).slice(0, 500));
    return { error: 'OpenAI response had no image payload (url or b64_json)', status: 200, raw: JSON.stringify(data) };
  }

  // Trigger fallback only when the error is genuinely about model access /
  // existence — NOT auth (401), quota (429), or content policy (400).
  const isModelError = (raw, status) => {
    if (status === 404) return true;
    if (!raw) return false;
    return /model_not_found|does not exist|does not have access|invalid[_ ]model|unsupported model|invalid model id|model.*not available|"model"/i.test(raw)
      && /model/i.test(raw);
  };

  // Tier 1: gpt-image-1 (the newer image model — replaces dall-e on some
  // accounts; does NOT accept response_format and returns b64_json by default).
  let attempt = await tryModel('gpt-image-1', '1024x1024');
  let modelUsed = 'gpt-image-1';

  // Tier 2: dall-e-3 with explicit response_format=url.
  if (attempt.error && isModelError(attempt.raw, attempt.status)) {
    console.log('[linkedin-agent] gpt-image-1 unavailable — falling back to dall-e-3');
    attempt = await tryModel('dall-e-3', '1024x1024', { response_format: 'url' });
    modelUsed = 'dall-e-3';
  }

  // Tier 3: dall-e-2 at 512x512 with explicit response_format=url.
  if (attempt.error && isModelError(attempt.raw, attempt.status)) {
    console.log('[linkedin-agent] dall-e-3 unavailable — falling back to dall-e-2 / 512x512');
    attempt = await tryModel('dall-e-2', '512x512', { response_format: 'url' });
    modelUsed = 'dall-e-2';
  }

  if (attempt.error) return { error: attempt.error, last_model_tried: modelUsed };

  // Convert the response into a Buffer either by downloading the URL or
  // base64-decoding the b64_json payload.
  try {
    let buffer;
    if (attempt.url) {
      const imageRes = await fetch(attempt.url);
      if (!imageRes.ok) return { error: 'image download failed: ' + imageRes.status, model: modelUsed };
      buffer = Buffer.from(await imageRes.arrayBuffer());
    } else if (attempt.b64) {
      buffer = Buffer.from(attempt.b64, 'base64');
    } else {
      return { error: 'no image payload in successful response', model: modelUsed };
    }

    const fs = require('fs');
    const pathMod = require('path');
    const dir = pathMod.join(process.cwd(), 'public', 'linkedin-images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = crypto.randomUUID() + '.png';
    const diskPath = pathMod.join(dir, filename);
    fs.writeFileSync(diskPath, buffer);
    // Upload to LinkedIn now (generation time), not at publish time: the local file
    // lives on ephemeral container disk and may be gone after a redeploy. We capture
    // the durable asset URN here. Failure is non-blocking — image still saved locally,
    // asset_urn comes back null, and the post falls back to text-only at publish.
    let asset_urn = null;
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    if (token) {
      const a = await getAuthorUrn(token);
      if (a.error) console.warn('[linkedin-agent] image upload skipped — author URN: ' + a.error);
      else asset_urn = await uploadImageToLinkedIn(diskPath, a.urn);
    }
    return { url: '/linkedin-images/' + filename, prompt, model: modelUsed, asset_urn };
  } catch (e) {
    return { error: e.message, model: modelUsed };
  }
}

// Resolve the LinkedIn member URN for the authenticated user. Uses
// LINKEDIN_PERSON_ID when set (skips the API roundtrip), otherwise calls the
// OIDC /v2/userinfo endpoint and uses the returned `sub` field.
async function getMemberURN(token) {
  const envId = (process.env.LINKEDIN_PERSON_ID || '').trim();
  if (envId) {
    const id = envId.replace(/^urn:li:[^:]+:/, '');
    return { urn: `urn:li:person:${id}`, source: 'env' };
  }
  try {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `userinfo ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    if (!data.sub) return { error: 'userinfo response had no sub field' };
    return { urn: `urn:li:person:${data.sub}`, source: 'userinfo' };
  } catch (e) {
    return { error: 'userinfo fetch failed: ' + e.message };
  }
}

// Resolve the author URN for posts/asset uploads. Switches on LINKEDIN_POST_AS_ORG:
//   true  -> urn:li:organization:<LINKEDIN_ORGANIZATION_ID> (needs w_organization_social)
//   false -> urn:li:person:<sub> via getMemberURN (needs w_member_social)
// Returns { urn } or { error }.
async function getAuthorUrn(token) {
  if (String(process.env.LINKEDIN_POST_AS_ORG).toLowerCase() === 'true') {
    const DEFAULT_ORG = '106395356';
    const orgRaw = (process.env.LINKEDIN_ORGANIZATION_ID || '').trim();
    let orgId;
    if (!orgRaw) orgId = DEFAULT_ORG;
    else if (/^urn:li:organization:/.test(orgRaw)) orgId = orgRaw.replace(/^urn:li:organization:/, '');
    else if (/^urn:li:[^:]+:/.test(orgRaw)) {
      console.warn('[linkedin-agent] LINKEDIN_ORGANIZATION_ID is a non-organization URN (' + orgRaw + '); falling back to ' + DEFAULT_ORG);
      orgId = DEFAULT_ORG;
    } else orgId = orgRaw;
    return { urn: `urn:li:organization:${orgId}` };
  }
  const member = await getMemberURN(token);
  if (member.error) return { error: member.error };
  return { urn: member.urn };
}

// Upload a local image file to LinkedIn via the legacy 3-step /v2/assets flow
// (registerUpload -> PUT binary). Returns the asset URN (urn:li:digitalmediaAsset:…)
// on success, or null on ANY failure — it never throws, so a failed/blocked upload
// degrades to a text-only post rather than breaking draft creation or publishing.
// `owner` on the asset must match the post author URN (org or person).
async function uploadImageToLinkedIn(localPath, authorUrn) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token || !authorUrn) return null;
  try {
    const fs = require('fs');
    if (!fs.existsSync(localPath)) {
      console.warn('[linkedin-agent] image upload skipped — file not found: ' + localPath);
      return null;
    }
    // Step 1 — registerUpload to get an asset URN + a one-time upload URL.
    const reg = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
      body: JSON.stringify({ registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: authorUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
      } }),
    });
    if (!reg.ok) {
      console.warn('[linkedin-agent] registerUpload ' + reg.status + ': ' + (await reg.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const regData = await reg.json();
    const asset = regData?.value?.asset;
    const uploadUrl = regData?.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
    if (!asset || !uploadUrl) {
      console.warn('[linkedin-agent] registerUpload response missing asset/uploadUrl');
      return null;
    }
    // Step 2 — PUT the raw image bytes to the upload URL (LinkedIn's documented
    // `--upload-file` semantics). Files written by generatePostImage are PNG.
    const bytes = fs.readFileSync(localPath);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'image/png' },
      body: bytes,
    });
    if (!put.ok) {
      console.warn('[linkedin-agent] image binary upload ' + put.status + ': ' + (await put.text().catch(() => '')).slice(0, 200));
      return null;
    }
    console.log('[linkedin-agent] image uploaded → ' + asset);
    return asset;
  } catch (e) {
    console.warn('[linkedin-agent] image upload failed: ' + e.message);
    return null;
  }
}

// Push a queued post to LinkedIn. The row must be approved. The author URN comes
// from getAuthorUrn; if the row carries a linkedin_image_asset_urn (captured at
// generation time) the post attaches that image, else it posts text-only.
async function publishPost(queueRow) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    return { skipped: true, reason: 'LINKEDIN_ACCESS_TOKEN is not set' };
  }
  const a = await getAuthorUrn(token);
  if (a.error) return { error: a.error };
  const author = a.urn;
  const text = clampPost(queueRow.full_post || '');
  const assetUrn = (queueRow.linkedin_image_asset_urn || '').trim();
  const shareContent = {
    shareCommentary: { text },
    shareMediaCategory: assetUrn ? 'IMAGE' : 'NONE',
  };
  if (assetUrn) {
    shareContent.media = [{
      status: 'READY',
      media: assetUrn,
      title: { text: (queueRow.headline || 'Abiozen').slice(0, 200) },
      description: { text: '' },
    }];
  }
  const body = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  try {
    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `LinkedIn API ${res.status}: ${t.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => ({}));
    const postId = res.headers.get('x-restli-id') || data.id || null;
    return { success: true, post_id: postId };
  } catch (e) {
    return { error: e.message };
  }
}

function nextWeekdayDates() {
  const out = {};
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 1 && !out.monday) out.monday = isoDay(d);
    else if (dow === 3 && !out.wednesday) out.wednesday = isoDay(d);
    else if (dow === 5 && !out.friday) out.friday = isoDay(d);
    if (out.monday && out.wednesday && out.friday) break;
  }
  return out;
}

async function insertDraft(post, scheduledFor) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO linkedin_content_queue
       (id, post_type, headline, body, hashtags, full_post, status, scheduled_for, source_molecule, image_prompt, structure_image_url, generated_image_url, linkedin_image_asset_urn, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,NOW())`,
    [id, post.post_type, post.headline, post.body, post.hashtags, post.full_post,
     scheduledFor, post.source_molecule, post.image_prompt || null,
     post.structure_image_url || null, post.generated_image_url || null,
     post.linkedin_image_asset_urn || null]
  );
  return id;
}

// Step 1: combined demand signals from market intelligence + GSC + Algolia.
async function getCombinedDemandMolecules() {
  const byName = {};
  const add = (name, cas, weight, source) => {
    const k = (name || '').toLowerCase().trim();
    if (!k) return;
    if (!byName[k]) byName[k] = { name: name.trim(), cas: cas || '', score: 0, sources: new Set() };
    byName[k].score += weight;
    byName[k].sources.add(source);
    if (!byName[k].cas && cas) byName[k].cas = cas;
  };

  // Source 1: latest market-intelligence / growth-intelligence
  const mi = (await query(
    `SELECT content FROM ai_analyses
     WHERE analysis_type IN ('growth_intelligence','market_analysis')
     ORDER BY created_at DESC LIMIT 1`
  )).rows[0];
  if (mi) {
    try {
      const c = JSON.parse(mi.content);
      const list = c.top_molecules || c.molecules || [];
      list.slice(0, 5).forEach((x, i) => {
        const w = x.demand_signal === 'high' ? 30 : x.demand_signal === 'medium' ? 20 : 15;
        add(x.molecule || x.name, x.cas || '', w - i, 'market_intelligence');
      });
    } catch {}
  }

  // Source 2: GSC top impressions (seo_rankings table, last 30 days)
  try {
    const gsc = (await query(
      `SELECT query, MAX(impressions) AS imp FROM seo_rankings
       WHERE recorded_date >= (NOW() - INTERVAL '30 days')::date::text
       GROUP BY query ORDER BY imp DESC LIMIT 10`
    )).rows;
    gsc.forEach(r => add(r.query, '', 5 + Math.min(10, Math.log10(Math.max(1, Number(r.imp) || 1)) * 5), 'gsc'));
  } catch (e) { /* seo_rankings may be empty or absent */ }

  // Source 3: Algolia top searches
  try {
    const { syncAlgoliaSearchData } = require('./growth-agent');
    const a = await syncAlgoliaSearchData();
    if (!a.skipped) {
      (a.top_queries || []).slice(0, 10).forEach(q =>
        add(q.query, '', 5 + Math.min(10, Math.log10(Math.max(1, q.count || 1)) * 5), 'algolia'));
    }
  } catch (e) { /* algolia may be unconfigured */ }

  return Object.values(byName)
    .map(m => ({ ...m, sources: Array.from(m.sources), demand_score: Math.round(m.score * 5) }))
    .sort((a, b) => b.demand_score - a.demand_score)
    .slice(0, 10);
}

// Step 2: check each demand molecule against the Abiozen catalog.
async function enrichWithCatalog(molecules) {
  const out = [];
  for (const m of molecules) {
    let sku = null;
    try {
      sku = (await query(
        `SELECT id, name, cas_number, purity, coa_status, sds_status, is_active
         FROM skus
         WHERE LOWER(name) = LOWER($1) OR ($2 <> '' AND cas_number = $2)
         LIMIT 1`,
        [m.name, m.cas || '']
      )).rows[0];
    } catch {}
    out.push({
      ...m,
      in_catalog: !!sku,
      sku_active: sku ? !!sku.is_active : false,
      purity: sku?.purity || null,
      coa_status: sku?.coa_status || null,
      sds_status: sku?.sds_status || null,
      cas: sku?.cas_number || m.cas || '',
    });
  }
  return out;
}

function renderApprovalEmail(date, drafts) {
  const rows = drafts.map(d =>
    `<div style="border:1px solid #e0e0e0;border-radius:8px;padding:12px;margin:8px 0;background:#fff">
       <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.4px">${d.post_type.replace('_', ' ')} · scheduled ${d.scheduled_for}${d.source_molecule ? ' · ' + d.source_molecule : ''}</div>
       <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-top:4px">${(d.headline || '').replace(/</g, '&lt;')}</div>
       <pre style="font-family:Arial,sans-serif;white-space:pre-wrap;font-size:12px;color:#333;margin:6px 0 0;line-height:1.5">${(d.full_post || '').replace(/</g, '&lt;')}</pre>
       ${d.image_prompt ? `<div style="font-size:11px;color:#0D7377;margin-top:6px"><strong>Image prompt:</strong> ${d.image_prompt.replace(/</g, '&lt;')}</div>` : ''}
     </div>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
    <div style="background:#1B3A6B;padding:18px;border-radius:8px 8px 0 0;color:#fff">
      <h2 style="margin:0;font-size:18px">LinkedIn content queue — week of ${date}</h2>
      <p style="margin:6px 0 0;color:#9FE1CB;font-size:12px">${drafts.length} drafts awaiting approval — approve in PlaybookOS to auto-publish</p>
    </div>
    <div style="border:1px solid #e0e0e0;border-top:none;padding:16px;background:#f8f9fa">${rows}</div>
  </div>`;
}

// Main weekly campaign — Steps 1-6. Step 7 (auto-publish on approval) lives in
// the routes.js PUT /linkedin/content-queue/:id approve handler.
async function runWeeklyLinkedInCampaign({ dryRun = false } = {}) {
  const week = nextWeekdayDates();
  const ceo = await getCEOUser();

  // Step 1 + 2
  const demand = await getCombinedDemandMolecules();
  const enriched = await enrichWithCatalog(demand);

  // Pick top: prefer an in-stock catalog molecule, else top overall.
  const top = enriched.find(m => m.in_catalog && m.sku_active) || enriched[0] || { name: 'Semaglutide', cas: '910463-68-2', purity: '99%' };

  // Step 3 + 4 + 5
  const drafts = [];
  const safe = async (label, generator, slot) => {
    try {
      const post = await generator();
      // Step 4 — chemical profile (only useful for molecule-specific posts)
      if (post.source_molecule) {
        const profile = await generateChemicalProfile({ name: post.source_molecule, cas: top.cas });
        if (profile) post.full_post = clampPost(post.full_post + '\n\n🔬 Chemical profile: ' + profile);
      }
      // Part 4 — text image prompt for DALL-E / Midjourney
      post.image_prompt = generateImagePrompt(post.post_type, post.source_molecule);
      // Part 1 — PubChem 2D structure for molecule-specific posts (free, no key)
      if (post.source_molecule) {
        post.structure_image_url = getMoleculeStructureImage(top.cas || post.source_molecule);
      }
      // Part 2 / 6 — note: DALL-E auto-generation is wired but commented out
      // by default. Each campaign run would cost ~$0.12 in DALL-E credits.
      // Uncomment to enable, or use POST /api/linkedin/regenerate-image/:id
      // from the LinkedIn Content page to generate on-demand.
      // const img = await generatePostImage(post.source_molecule, post.post_type);
      // if (img.url) post.generated_image_url = img.url;
      // Step 5 — persist
      const id = dryRun ? null : await insertDraft(post, slot);
      drafts.push({ id, slot_label: label, scheduled_for: slot, ...post });
    } catch (e) {
      console.error(`[linkedin-agent] ${label} failed:`, e.message);
      drafts.push({ slot_label: label, scheduled_for: slot, error: e.message });
    }
  };

  await safe('Monday — product post', () => generateProductPost({
    name: top.name, cas: top.cas || '', purity: top.purity || '99%',
  }), week.monday);
  await safe('Wednesday — market trend', () => generateMarketTrendPost(enriched), week.wednesday);
  await safe('Friday — capability highlight', () => generateCapabilityPost(), week.friday);

  // Step 6 — log + email Naresh
  if (!dryRun) {
    await logAgentActivity({
      agent_name: AGENT, action_type: 'linkedin_weekly_campaign',
      user_id: ceo ? ceo.id : null,
      reasoning: `Drafted ${drafts.filter(d => d.id).length} weekly LinkedIn posts (top molecule: ${top.name}, demand score ${top.demand_score || '?'}).`,
      source_kpi: 'kpi-sg-marketing', confidence_score: 78,
      output_summary: drafts.map(d => `${d.slot_label}: ${d.error ? 'ERROR ' + d.error : (d.headline || 'draft')}`).join(' | '),
    });
    if (ceo?.email) {
      try {
        await sendEmail({
          to: ceo.email,
          subject: `LinkedIn campaign drafts — week of ${week.monday}`,
          html: renderApprovalEmail(week.monday, drafts.filter(d => d.id)),
        });
      } catch (e) { console.error('[linkedin-agent] approval email failed:', e.message); }
    }
  }

  return {
    week, top_molecule: top, demand_intel: enriched,
    drafts_created: drafts.filter(d => d.id).length, drafts,
  };
}

// Back-compat alias for the existing cron and any importer using the old name.
async function scheduleLinkedInContent(opts) { return runWeeklyLinkedInCampaign(opts); }

module.exports = {
  generateProductPost,
  generateMarketIntelligencePost,
  generateCompanyUpdate,
  generateMarketTrendPost,
  generateCapabilityPost,
  generateChemicalProfile,
  generateImagePrompt,
  getMoleculeStructureImage,
  generatePostImage,
  getCombinedDemandMolecules,
  enrichWithCatalog,
  runWeeklyLinkedInCampaign,
  scheduleLinkedInContent,
  publishPost,
  MAX_POST_CHARS,
};
