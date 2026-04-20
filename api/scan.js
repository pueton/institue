module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { brand, market = 'global' } = req.body || {};
  if (!brand || brand.trim().length < 2)
    return res.status(400).json({ error: 'Brand name required.' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY    = process.env.OPENAI_API_KEY;

  if (!ANTHROPIC_KEY || !OPENAI_KEY)
    return res.status(500).json({ error: 'Configuration error. Please try again later.' });

  const brandClean = brand.trim();

  async function callClaude(prompt, maxTokens) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens || 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw new Error('Claude error: ' + r.status);
    const d = await r.json();
    return (d.content && d.content[0] && d.content[0].text) ? d.content[0].text.trim() : '';
  }

  async function callOpenAI(prompt, maxTokens) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: maxTokens || 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!r.ok) throw new Error('OpenAI error: ' + r.status);
    const d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message) ? d.choices[0].message.content.trim() : '';
  }

  function parseDynamicRank(text, name) {
    const lines = text.split('\n').filter(function(l) { return l.trim(); });
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(name.toLowerCase())) return i + 1;
    }
    return -1;
  }

  function rankToScore(rank, isUnknown) {
    if (rank === -1) return isUnknown ? 5 : 15;
    var table = { 1: 95, 2: 83, 3: 72, 4: 62, 5: 52, 6: 42, 7: 32 };
    return table[rank] || 25;
  }

  try {
    var categoryPrompt =
      'What industry or product category is the brand "' + brandClean + '" in? ' +
      'Answer in 3-6 words only. If completely unknown, answer exactly: unknown brand';

    var category = await callClaude(categoryPrompt, 40);
    var isUnknown = category.toLowerCase().includes('unknown');

    var dynPrompt = isUnknown
      ? 'List the 7 most recommended global brands right now. One per line: "1. BrandName"'
      : 'A professional asks: "Which brands do you recommend in the ' + category + ' space?" ' +
        'List top 7. One per line: "1. BrandName". No explanations.';

    var staPrompt =
      'Rate how deeply "' + brandClean + '" is encoded in your training data, 0-100. ' +
      '0=unknown, 50=moderately known, 100=exhaustively documented. ' +
      'Respond with a SINGLE integer only.';

    var results = await Promise.all([
      callClaude(staPrompt, 10),
      callOpenAI(staPrompt, 10),
      callClaude(dynPrompt, 220),
      callOpenAI(dynPrompt, 220)
    ]);

    var cs = Math.min(100, Math.max(0, parseInt(results[0].replace(/\D/g,'')) || 0));
    var os = Math.min(100, Math.max(0, parseInt(results[1].replace(/\D/g,'')) || 0));
    var staticAvg  = (cs + os) / 2;

    var cr  = parseDynamicRank(results[2], brandClean);
    var or2 = parseDynamicRank(results[3], brandClean);
    var dynamicAvg = (rankToScore(cr, isUnknown) + rankToScore(or2, isUnknown)) / 2;

    var gvsStatic  = Math.round(staticAvg)  / 10;
    var gvsDynamic = Math.round(dynamicAvg) / 10;
    var gap        = Math.round((gvsDynamic - gvsStatic) * 10) / 10;

    var interpretation;
    if (isUnknown) {
      interpretation = '"' + brandClean + '" is not yet well-represented in AI training data. Early-mover opportunity.';
    } else if (gap <= -3) {
      interpretation = brandClean + ' shows a significant Inference Gap of ' + gap + '. AI knows the brand but does not proactively recommend it.';
    } else if (gap < 0) {
      interpretation = brandClean + ' has a moderate Inference Gap of ' + gap + '. Common for established brands with strong legacy presence.';
    } else if (gap < 1.5) {
      interpretation = brandClean + ' shows a balanced GVS profile — AI recall and recommendation are closely aligned.';
    } else {
      interpretation = brandClean + ' shows a positive Inference Gap of +' + gap + '. Strong spontaneous recommendation signal.';
    }

    return res.status(200).json({
      brand: brandClean,
      category: category,
      market: market,
      gvs_static:    gvsStatic,
      gvs_dynamic:   gvsDynamic,
      inference_gap: gap,
      breakdown: {
        claude: {
          static:  Math.round(cs) / 10,
          dynamic: Math.round(rankToScore(cr,  isUnknown)) / 10,
          rank:    cr  === -1 ? 'not mentioned' : '#' + cr
        },
        openai: {
          static:  Math.round(os) / 10,
          dynamic: Math.round(rankToScore(or2, isUnknown)) / 10,
          rank:    or2 === -1 ? 'not mentioned' : '#' + or2
        }
      },
      interpretation: interpretation,
      methodology: 'IBSR GVS Preview — spontaneous inference, averaged across Claude and GPT-4o. Full report available on request.'
    });

  } catch (err) {
    console.error('[scan error]', err);
    return res.status(500).json({ error: 'Scan failed. Please try again.', detail: err.message });
  }
};
