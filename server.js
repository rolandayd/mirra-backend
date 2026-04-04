const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SCREENSHOT_API_KEY = process.env.SCREENSHOT_API_KEY;

app.get('/', (req, res) => {
  res.json({ status: 'Mirra backend running', version: '3.0.0' });
});

app.post('/analyze', async (req, res) => {
  const { url, industry } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let normalizedUrl = url.startsWith('http') ? url : 'https://' + url;
  let domain;
  try { domain = new URL(normalizedUrl).hostname.replace('www.', ''); }
  catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  console.log(`[analyze] ${domain}`);

  let screenshotBase64 = null;
  try {
    const ssUrl = `https://api.screenshotone.com/take?access_key=${SCREENSHOT_API_KEY}&url=${encodeURIComponent(normalizedUrl)}&viewport_width=1280&viewport_height=900&format=jpg&image_quality=80&block_ads=true&block_cookie_banners=true&timeout=15`;
    const ssRes = await fetch(ssUrl, { signal: AbortSignal.timeout(20000) });
    if (ssRes.ok) {
      const buf = await ssRes.arrayBuffer();
      screenshotBase64 = Buffer.from(buf).toString('base64');
      console.log(`[screenshot] captured for ${domain}`);
    } else {
      console.log(`[screenshot] failed ${ssRes.status} for ${domain}`);
    }
  } catch (ssErr) {
    console.log(`[screenshot] error: ${ssErr.message}`);
  }

  const messageContent = [];
  if (screenshotBase64) {
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } });
    messageContent.push({ type: 'text', text: buildPrompt(normalizedUrl, domain, industry, true) });
  } else {
    messageContent.push({ type: 'text', text: buildPrompt(normalizedUrl, domain, industry, false) });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{ role: 'user', content: messageContent }]
    });

    const raw = response.content.map(b => b.text || '').join('').trim();
    const result = extractJSON(raw);

    if (!result) {
      console.log(`[parse error] raw: ${raw.slice(0, 300)}`);
      return res.status(500).json({ error: 'Could not parse AI response — try again.' });
    }

    res.json({ success: true, result, usedScreenshot: !!screenshotBase64 });

  } catch (err) {
    console.error(`[claude error] ${domain}: ${err.message}`);
    res.status(500).json({ error: err.message || 'Analysis failed. Try again.' });
  }
});

function buildPrompt(url, domain, industry, hasScreenshot) {
  const source = hasScreenshot
    ? `You are looking at a LIVE screenshot of ${domain}. Analyze ONLY what you can see in the image.`
    : `You are analyzing ${domain} based on your training knowledge. Be specific and honest.`;

  return `You are Mirra, the world's most advanced competitive intelligence analyst. You help businesses anywhere in the world understand exactly what their competitors are doing and how to beat them.

${source}

Your analysis must answer three questions every business owner actually asks:
1. How dangerous is this competitor?
2. What do I do about it tomorrow morning?
3. What does winning against them look like?

Industry context: ${industry || 'detect from the site'}

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no backticks, no text outside the JSON.

{
  "domain": "${domain}",
  "overallScore": <0-100>,
  "threatLevel": "<LOW|MEDIUM|HIGH|CRITICAL — how dangerous is this competitor>",
  "threatReason": "<one specific sentence explaining exactly why they are this threat level>",
  "limitedKnowledge": <true|false>,
  "industry": "<detected industry>",
  "summary": "<2-3 sentences. Specific. What they do well, what they don't, what the opportunity is>",
  "components": [
    {"name":"Navigation","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#1D6AF8"},
    {"name":"Hero Section","detail":"<specific finding — exact headline if visible>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},
    {"name":"Primary CTA","detail":"<specific finding — exact button text if visible>","status":"strong|partial|missing|unknown","color":"#D93030"},
    {"name":"Social Proof","detail":"<specific finding — exact numbers or logos if visible>","status":"strong|partial|missing|unknown","color":"#C07A00"},
    {"name":"Pricing Display","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#0F9E52"},
    {"name":"Trust Signals","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#0891B2"},
    {"name":"Value Proposition","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},
    {"name":"Mobile Experience","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#1D6AF8"}
  ],
  "insights": [
    {"type":"steal","title":"<4-6 words>","text":"<specific strength worth copying and exactly why it works>","action":"Steal"},
    {"type":"steal","title":"<4-6 words>","text":"<another specific strength>","action":"Steal"},
    {"type":"gap","title":"<4-6 words>","text":"<specific weakness and exactly how to exploit it>","action":"Exploit"},
    {"type":"gap","title":"<4-6 words>","text":"<another specific weakness>","action":"Exploit"},
    {"type":"watch","title":"<4-6 words>","text":"<interesting pattern worth monitoring>","action":"Note"}
  ],
  "priorityActions": [
    {
      "priority": 1,
      "impact": "HIGH",
      "action": "<specific thing to do — written as an instruction not a suggestion>",
      "why": "<one sentence: exactly which gap this exploits and why it will work>",
      "effort": "quick|medium|project"
    },
    {
      "priority": 2,
      "impact": "HIGH",
      "action": "<second specific action>",
      "why": "<one sentence explanation>",
      "effort": "quick|medium|project"
    },
    {
      "priority": 3,
      "impact": "MEDIUM",
      "action": "<third specific action>",
      "why": "<one sentence explanation>",
      "effort": "quick|medium|project"
    }
  ],
  "beatThemBrief": {
    "headline": "<a rewritten headline that directly addresses their biggest gap>",
    "cta": "<a rewritten CTA that outperforms theirs>",
    "socialProof": "<specific social proof format to collect that beats theirs>",
    "positioning": "<one sentence positioning statement that exploits their weakness>"
  },
  "gapScore": <0-100 — how many exploitable gaps exist. Higher = more opportunity for competitors>,
  "scoreBreakdown": {
    "Visual Design": <0-100>,
    "CTA Clarity": <0-100>,
    "Social Proof": <0-100>,
    "Navigation": <0-100>,
    "Trust Signals": <0-100>
  }
}`;
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const stripped = text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const fi = text.indexOf('{'), li = text.lastIndexOf('}');
  if (fi !== -1 && li > fi) { try { return JSON.parse(text.slice(fi, li + 1)); } catch (_) {} }
  return null;
}

app.listen(PORT, () => console.log(`Mirra v3 backend on port ${PORT}`));
