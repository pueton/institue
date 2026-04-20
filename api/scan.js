export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {

  // ── CORS ────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  // ── TEMPORARY DEBUG ─────────────────────────────────────────
  console.log('ANTHROPIC present:', !!ANTHROPIC_KEY);
  console.log('OPENAI present:', !!OPENAI_KEY);
  const foundKeys = Object.keys(process.env).filter(k => k.includes('API') || k.includes('KEY'));
  console.log('Env API keys found:', foundKeys);

  if (!ANTHROPIC_KEY || !OPENAI_KEY)
    return res.status(500).json({
      error: 'API keys not configured.',
      debug: {
        anthropic: !!ANTHROPIC_KEY,
        openai: !!OPENAI_KEY,
        found_keys: foundKeys
      }
    });

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
    `Answer in 3-6 words only. If completely unknown, answer exactly: unknown brand`;

  function staticPrompt(model) {
    return (
      `You are a brand knowledge assessor for ${model}.\n` +
      `Rate how deeply the brand "${brandClean}" is encoded in your training data ` +
      `on a scale from 0 to 100:\n` +
      `  0   = completely unknown\n` +
      `  30  = recognised name, minimal documented information\n` +
      `  60  = moderately documented\n` +
      `  85  = well documented globally\n` +
      `  100 = exhaustively documented\n\n` +
      `Respond with a SINGLE integer between 0 and 100. Nothing else.`
    );
  }

  function dynamicPrompt(category) {
    const isUnknown = category.toLowerCase().includes('unknown');
    if (isUnknown) {
      return (
        `List the 7 most recommended global brands right now. ` +
        `One brand per line, format exactly: "1. BrandName"`
      );
    }
    return (
      `A business professional asks: ` +
      `"Which brands should I consider in the ${category} space?" ` +
      `List your top 7 recommendations. ` +
      `One brand per line, format exactly: "1. BrandName". No explanations.`
    );
  }

  // ── SCORING HELPERS ─────────────────────────────────────────

  function parseDynamicRank(responseText, brandName) {
    const lines = responseText.split('\n').filter(l => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(brandName.toLowerCase())) {
        return i + 1;
      }
    }
    return -1;
  }

  function rankToScore(rank, isUnknown) {
    if (rank === -1) return isUnknown ? 5 : 15;
    const table = { 1: 95, 2: 83, 3: 72, 4: 62, 5: 52, 6: 42, 7: 32 };
    return table[rank] || 25;
  }

  function toGvsScale(score0to100) {
    return Math.round(score0to100) / 10;
  }

  // ── MAIN EXECUTION ──────────────────────────────────────────
  try {

    const category = await callClaude(categoryPrompt, 40);
    const isUnknown = category.toLowerCase().includes('unknown');

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

    const claudeStatic = Math.min(100, Math.max(0,
      parseInt(claudeStaticRaw.replace(/\D/g, '')) || 0
    ));
    const openaiStatic = Math.min(100, Math.max(0,
      parseInt(openaiStaticRaw.replace(/\D/g, '')) || 0
    ));
    const staticAvg = (claudeStatic + openaiStatic) / 2;

    const claudeRank     = parseDynamicRank(claudeDynamicRaw, brandClean);
    const openaiRank     = parseDynamicRank(openaiDynamicRaw, brandClean);
    const claudeDynScore = rankToScore(claudeRank, isUnknown);
    const openaiDynScore = rankToScore(openaiRank, isUnknown);
    const dynamicAvg     = (claudeDynScore + openaiDynScore) / 2;

    const gvsStatic  = toGvsScale(staticAvg);
    const gvsDynamic = toGvsScale(dynamicAvg);
    const gap        = Math.round((gvsDynamic - gvsStatic) * 10) / 10;

    const breakdown = {
      claude: {
        static: toGvsScale(claudeStatic),
        dynamic: toGvsScale(claudeDynScore),
        dynamic_rank: claudeRank === -1 ? 'not mentioned' : `#${claudeRank}`
      },
      openai: {
        static: toGvsScale(openaiStatic),
        dynamic: toGvsScale(openaiDynScore),
        dynamic_rank: openaiRank === -1 ? 'not mentioned' : `#${openaiRank}`
      }
    };

    let interpretation;
    if (isUnknown) {
      interpretation =
        `"${brandClean}" is not yet well-represented in AI training data. ` +
        `This is an early-mover opportunity.`;
    } else if (gap <= -3) {
      interpretation =
        `${brandClean} shows a significant negative Inference Gap of ${gap}. ` +
        `Both models have strong recall but the brand underperforms in spontaneous recommendation contexts.`;
    } else if (gap < 0) {
      interpretation =
        `${brandClean} has a moderate Inference Gap of ${gap}. ` +
        `AI recall is stronger than spontaneous recommendation — common for established brands.`;
    } else if (gap < 1.5) {
      interpretation =
        `${brandClean} shows a balanced GVS profile. ` +
        `AI recall and spontaneous recommendation are closely aligned.`;
    } else {
      interpretation =
        `${brandClean} shows a positive Inference Gap of +${gap}. ` +
        `Both models recommend the brand spontaneously at higher rates than parametric recall alone predicts.`;
    }

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
        'Full report: 3 LLMs x 5 markets x 50+ probes. Available on request.'
    });

  } catch (err) {
    console.error('[IBSR scan error]', err);
    return res.status(500).json({
      error: 'Scan failed. Please try again.',
      detail: err.message
    });
  }
}
