export const config = { runtime: 'nodejs20.x' };

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://ibsr.institute');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, market = 'global' } = req.body;
  if (!brand || brand.trim().length < 2) {
    return res.status(400).json({ error: 'Brand name required' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API key missing' });

  const brandClean = brand.trim();

  async function claude(prompt, maxTokens = 300) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5-20251101',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const d = await r.json();
    return d.content?.[0]?.text || '';
  }

  try {
    // ── PROBE 1: Category detection (internal, no score) ──────────
    const catResponse = await claude(
      `What industry/product category is the brand "${brandClean}" in? ` +
      `Answer in 3-5 words only, e.g. "enterprise CRM software" or "luxury automotive". ` +
      `If you don't recognise the brand, answer "unknown brand".`,
      50
    );
    const category = catResponse.trim();
    const isUnknown = category.toLowerCase().includes('unknown');

    // ── PROBE 2: GVS Static (Parametric Recall) ───────────────────
    const staticResponse = await claude(
      `You are a brand knowledge assessor. Rate how deeply the brand "${brandClean}" ` +
      `is encoded in your training data on a scale from 0 to 100, where:\n` +
      `0 = completely unknown, no information available\n` +
      `50 = moderately known, some basic information\n` +
      `100 = extremely well documented globally — extensive history, financials, press coverage, competitive analysis\n\n` +
      `Consider: global brand recognition, documented history, media coverage volume, ` +
      `financial reporting availability, competitive landscape documentation.\n\n` +
      `Respond with ONLY a number between 0 and 100. Nothing else.`,
      10
    );
    const staticRaw = parseInt(staticResponse.trim().replace(/\D/g, '')) || 0;
    const staticScore = Math.min(100, Math.max(0, staticRaw));

    // ── PROBE 3: GVS Dynamic (Spontaneous Inference) ──────────────
    // Key: we do NOT mention the brand in this prompt
    const dynamicPrompt = isUnknown
      ? `List the 7 most recommended global brands in the "${category}" category. ` +
        `Rank them 1-7 by overall market presence and reputation. One brand per line, format: "1. BrandName"`
      : `A business professional asks you: "Which brands should I consider in the ${category} space?" ` +
        `List your top 7 recommendations ranked by overall market presence, reputation, and recommendation frequency. ` +
        `One brand per line, format: "1. BrandName". Do not add explanations.`;

    const dynamicResponse = await claude(dynamicPrompt, 200);

    // Parse which position the brand appears at
    const lines = dynamicResponse.split('\n').filter(l => l.trim());
    let brandPosition = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(brandClean.toLowerCase())) {
        brandPosition = i + 1; // 1-indexed
        break;
      }
    }

    // Dynamic score: position-based (0-100 scale)
    let dynamicScore;
    if (brandPosition === -1) {
      dynamicScore = isUnknown ? 5 : 15; // Not mentioned
    } else {
      const positionScores = [95, 82, 70, 60, 50, 40, 30];
      dynamicScore = positionScores[brandPosition - 1] || 25;
    }

    // ── SCORES & GAP ──────────────────────────────────────────────
    const gvsStatic  = Math.round(staticScore / 10 * 10) / 10;  // 0–10
    const gvsDynamic = Math.round(dynamicScore / 10 * 10) / 10; // 0–10
    const gap        = Math.round((gvsDynamic - gvsStatic) * 10) / 10;

    // ── INTERPRETATION ────────────────────────────────────────────
    let interpretation;
    if (isUnknown) {
      interpretation = `"${brandClean}" is not yet well-represented in AI training data. This is an early-mover opportunity.`;
    } else if (gap < -2) {
      interpretation = `${brandClean} has strong AI recall but underperforms in spontaneous recommendations — a significant Inference Gap. AI knows the brand but doesn't proactively recommend it.`;
    } else if (gap < 0) {
      interpretation = `${brandClean} shows a moderate negative Inference Gap — common among established brands. There is measurable room to improve AI recommendation frequency.`;
    } else if (gap >= 0 && gap < 1.5) {
      interpretation = `${brandClean} has a balanced GVS profile. AI recall and spontaneous recommendation are closely aligned.`;
    } else {
      interpretation = `${brandClean} shows strong spontaneous recommendation — AI recommends it more actively than its training depth alone would suggest.`;
    }

    return res.status(200).json({
      brand: brandClean,
      category,
      gvs_static: gvsStatic,
      gvs_dynamic: gvsDynamic,
      inference_gap: gap,
      dynamic_rank: brandPosition,
      interpretation,
      methodology: 'IBSR GVS Preview — spontaneous inference method. Full report available on request.'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}
