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
  res.json({ status: 'Mirra backend running', version: '2.2.0' });
});

app.post('/analyze', async (req, res) => {
  const { url } = req.body;
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
      console.log(`[screenshot] captured for ${domain} (${screenshotBase64.length} bytes)`);
    } else {
      const errText = await ssRes.text();
      console.log(`[screenshot] failed ${ssRes.status} for ${domain}: ${errText.slice(0,100)}`);
    }
  } catch (ssErr) {
    console.log(`[screenshot] error for ${domain}: ${ssErr.message}`);
  }

  const messageContent = [];
  if (screenshotBase64) {
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } });
    messageContent.push({ type: 'text', text: buildVisionPrompt(normalizedUrl, domain) });
  } else {
    messageContent.push({ type: 'text', text: buildTextPrompt(normalizedUrl, domain) });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
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

function buildVisionPrompt(url, domain) {
  return `You are Mirra, a competitive intelligence analyst. You are looking at a LIVE screenshot of ${domain} right now.

Analyze ONLY what you can see in this screenshot. Do not rely on prior knowledge — use the image.

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no backticks, no text outside the JSON.

{"domain":"${domain}","overallScore":<0-100 based on what you see>,"limitedKnowledge":false,"summary":"<2-3 sentences describing exactly what you see — specific headlines, CTAs, design choices visible>","components":[{"name":"Navigation","detail":"<exactly what nav items you can see>","status":"strong|partial|missing|unknown","color":"#1D6AF8"},{"name":"Hero Section","detail":"<exact headline text you can read in the screenshot>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Primary CTA","detail":"<exact button text and color visible>","status":"strong|partial|missing|unknown","color":"#D93030"},{"name":"Social Proof","detail":"<exactly what logos, numbers or testimonials you see>","status":"strong|partial|missing|unknown","color":"#C07A00"},{"name":"Pricing Display","detail":"<visible or not — what you see>","status":"strong|partial|missing|unknown","color":"#0F9E52"},{"name":"Trust Signals","detail":"<any badges or certifications visible>","status":"strong|partial|missing|unknown","color":"#0891B2"},{"name":"Value Proposition","detail":"<how clear is the main message from what you see>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Mobile Experience","detail":"<visual quality and layout observations>","status":"strong|partial|missing|unknown","color":"#1D6AF8"}],"insights":[{"type":"steal","title":"<4-6 words>","text":"<specific visible strength worth copying>","action":"Steal"},{"type":"steal","title":"<4-6 words>","text":"<another specific visible strength>","action":"Steal"},{"type":"gap","title":"<4-6 words>","text":"<specific visible weakness to exploit>","action":"Exploit"},{"type":"gap","title":"<4-6 words>","text":"<another specific visible weakness>","action":"Exploit"},{"type":"watch","title":"<4-6 words>","text":"<interesting pattern worth monitoring>","action":"Note"}],"scoreBreakdown":{"Visual Design":<0-100>,"CTA Clarity":<0-100>,"Social Proof":<0-100>,"Navigation":<0-100>,"Trust Signals":<0-100>}}`;
}

function buildTextPrompt(url, domain) {
  return `You are Mirra, a competitive intelligence analyst. Analyze ${domain} based on your training knowledge. Be specific and honest — only state what you actually know.

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no backticks, no text outside the JSON.

{"domain":"${domain}","overallScore":<0-100 conservative>,"limitedKnowledge":<true if limited knowledge>,"summary":"<2-3 honest specific sentences>","components":[{"name":"Navigation","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#1D6AF8"},{"name":"Hero Section","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Primary CTA","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#D93030"},{"name":"Social Proof","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#C07A00"},{"name":"Pricing Display","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#0F9E52"},{"name":"Trust Signals","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#0891B2"},{"name":"Value Proposition","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Mobile Experience","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#1D6AF8"}],"insights":[{"type":"steal","title":"<4-6 words>","text":"<specific real strength>","action":"Steal"},{"type":"steal","title":"<4-6 words>","text":"<another real strength>","action":"Steal"},{"type":"gap","title":"<4-6 words>","text":"<specific real weakness>","action":"Exploit"},{"type":"gap","title":"<4-6 words>","text":"<another weakness>","action":"Exploit"},{"type":"watch","title":"<4-6 words>","text":"<interesting pattern>","action":"Note"}],"scoreBreakdown":{"Visual Design":<0-100>,"CTA Clarity":<0-100>,"Social Proof":<0-100>,"Navigation":<0-100>,"Trust Signals":<0-100>}}`;
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const stripped = text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const fi = text.indexOf('{'), li = text.lastIndexOf('}');
  if (fi !== -1 && li > fi) { try { return JSON.parse(text.slice(fi, li + 1)); } catch (_) {} }
  return null;
}

app.listen(PORT, () => console.log(`Mirra backend on port ${PORT}`));
