export const config = { runtime: 'nodejs20.x' };

export default async function handler(req, res) {

  // ── CORS ────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', 'https://ibsr.institute');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  // ── INPUT VALIDATION ────────────────────────────────────────
  const { brand, market = 'global' } = req.body || {};
  if (!brand || brand.trim().length < 2)
    return res.status(400).json({ error: 'Brand name required (min. 2 characters).' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY    = process.env.OPENAI_API_KEY;

  if (!ANTHROPIC_KEY || !OPENAI_KEY)
    return res.status(500).json({ error: 'API keys not configured.' });

  const brandClean = brand.trim();

  // ── LLM CALL HELPERS ────────────────────────────────────────

  async function callClaude(prompt, maxTokens = 300) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw new Error(`Claude error: ${r.status}`);
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || '';
  }

  async function callOpenAI(prompt, maxTokens = 300) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw new Error(`OpenAI error: ${r.status}`);
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || '';
  }

  // ── PROMPT TEMPLATES ────────────────────────────────────────

  const categoryPrompt =
    `What industry or product category is the brand "${brandClean}" in? ` +
    `Answer in 3–6 words only — e.g. "enterprise CRM software" or "luxury automotive". ` +
    `If completely unknown, answer exactly: unknown brand`;

  function staticPrompt(model) {
    return (
      `You are a brand knowledge assessor for ${model}.\n` +
      `Rate how deeply the brand "${brandClean}" is encoded in your training data ` +
      `on a scale from 0 to 100:\n` +
      `  0   = completely unknown\n` +
      `  30  = recognised name, minimal documented information\n` +
      `  60  = moderately documented — some history, press, competitive context\n` +
      `  85  = well documented globally — financials, history, extensive press coverage\n` +
      `  100 = exhaustively documented — one of the world's most covered brands\n\n` +
      `Factors: global recognition, media volume, financial reporting, ` +
      `competitive landscape documentation, Wikipedia depth.\n\n` +
      `Respond with a SINGLE integer between 0 and 100. Nothing else.`
    );
  }

  function dynamicPrompt(category) {
    const isUnknown = category.toLowerCase().includes('unknown');
    if (isUnknown) {
      return (
        `List the 7 most recommended global brands right now. ` +
        `Rank them 1–7 by overall market presence and reputation. ` +
        `One brand per line, format exactly: "1. BrandName"`
      );
    }
    return (
      `A business professional asks you: ` +
      `"Which brands should I consider in the ${category} space?" ` +
      `List your top 7 recommendations, ranked by market presence, reputation, ` +
      `and how frequently you would recommend them. ` +
      `One brand per line, format exactly: "1. BrandName". ` +
      `No explanations — brand names only.`
    );
  }

  // ── SCORING HELPERS ─────────────────────────────────────────

  function parseDynamicRank(responseText, brandName) {
    const lines = responseText.split('\n').filter(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(brandName.toLowerCase())) {
        return i + 1; // 1-indexed
      }
    }
    return -1; // not mentioned
  }

  function rankToScore(rank, isUnknown) {
    if (rank === -1) return isUnknown ? 5 : 15;
    const table = { 1: 95, 2: 83, 3: 72, 4: 62, 5: 52, 6: 42, 7: 32 };
    return table[rank] || 25;
  }

  function toGvsScale(score0to100) {
    // Convert 0–100 to 0–10 with one decimal
    return Math.round(score0to100) / 10;
  }

  // ── MAIN EXECUTION ──────────────────────────────────────────
  try {

    // Step 1: Detect category (Claude only — fast, one call)
    const category = await callClaude(categoryPrompt, 40);
    const isUnknown = category.toLowerCase().includes('unknown');

    // Step 2: Static + Dynamic — Claude and OpenAI in PARALLEL
    const [
      claudeStaticRaw,
      openaiStaticRaw,
      claudeDynamicRaw,
      openaiDynamicRaw
    ] = await Promise.all([
      callClaude(staticPrompt('Claude'), 10),
      callOpenAI(staticPrompt('GPT-4o'), 10),
      callClaude(dynamicPrompt(category), 220),
      callOpenAI(dynamicPrompt(category), 220)
    ]);

    // Parse static scores
    const claudeStatic = Math.min(100, Math.max(0,
      parseInt(claudeStaticRaw.replace(/\D/g, '')) || 0
    ));
    const openaiStatic = Math.min(100, Math.max(0,
      parseInt(openaiStaticRaw.replace(/\D/g, '')) || 0
    ));
    const staticAvg = (claudeStatic + openaiStatic) / 2;

    // Parse dynamic ranks
    const claudeRank   = parseDynamicRank(claudeDynamicRaw, brandClean);
    const openaiRank   = parseDynamicRank(openaiDynamicRaw, brandClean);
    const claudeDynScore = rankToScore(claudeRank, isUnknown);
    const openaiDynScore = rankToScore(openaiRank, isUnknown);
    const dynamicAvg   = (claudeDynScore + openaiDynScore) / 2;

    // Step 3: Calculate final GVS scores (0–10 scale)
    const gvsStatic  = toGvsScale(staticAvg);
    const gvsDynamic = toGvsScale(dynamicAvg);
    const gap        = Math.round((gvsDynamic - gvsStatic) * 10) / 10;

    // ── MODEL BREAKDOWN ───────────────────────────────────────
    const breakdown = {
      claude: {
        static:  toGvsScale(claudeStatic),
        dynamic: toGvsScale(claudeDynScore),
        dynamic_rank: claudeRank === -1 ? 'not mentioned' : `#${claudeRank}`
      },
      openai: {
        static:  toGvsScale(openaiStatic),
        dynamic: toGvsScale(openaiDynScore),
        dynamic_rank: openaiRank === -1 ? 'not mentioned' : `#${openaiRank}`
      }
    };

    // ── INTERPRETATION ────────────────────────────────────────
    let interpretation;
    if (isUnknown) {
      interpretation =
        `"${brandClean}" is not yet well-represented in AI training data across ` +
        `both Claude and GPT-4o. This is an early-mover opportunity — ` +
        `building AI brand presence now costs significantly less than doing so once competitors establish themselves.`;
    } else if (gap <= -3) {
      interpretation =
        `${brandClean} shows a significant negative Inference Gap of ${gap}. ` +
        `Both Claude and GPT-4o have strong recall of the brand in training data, ` +
        `but it underperforms in spontaneous recommendation contexts. ` +
        `AI knows the brand — but doesn't proactively surface it when customers ask.`;
    } else if (gap < 0) {
      interpretation =
        `${brandClean} has a moderate Inference Gap of ${gap}. ` +
        `AI recall is stronger than spontaneous recommendation — ` +
        `a common pattern for established brands with strong legacy presence ` +
        `but weaker recent content signals.`;
    } else if (gap < 1.5) {
      interpretation =
        `${brandClean} shows a balanced GVS profile across Claude and GPT-4o. ` +
        `AI recall and spontaneous recommendation are closely aligned — ` +
        `an indicator of consistent brand signal in training data.`;
    } else {
      interpretation =
        `${brandClean} shows a positive Inference Gap of +${gap}. ` +
        `Both models recommend the brand spontaneously at higher rates ` +
        `than parametric recall alone would predict — ` +
        `a strong signal of active AI brand presence.`;
    }

    // ── RESPONSE ─────────────────────────────────────────────
    return res.status(200).json({
      brand: brandClean,
      category,
      market,
      gvs_static:    gvsStatic,
      gvs_dynamic:   gvsDynamic,
      inference_gap: gap,
      breakdown,
      interpretation,
      methodology:
        'IBSR GVS Preview — spontaneous inference method, averaged across Claude and GPT-4o. ' +
        'Full report: 3 LLMs × 5 markets × 50+ probes. Available on request.'
    });

  } catch (err) {
    console.error('[IBSR scan error]', err);
    return res.status(500).json({
      error: 'Scan failed. Please try again in a moment.'
    });
  }
}
