const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

app.get('/', (req, res) => {
  res.json({ status: 'Mirra backend running', version: '2.0.0' });
});

app.post('/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let normalizedUrl = url.startsWith('http') ? url : 'https://' + url;
  let domain;
  try { domain = new URL(normalizedUrl).hostname.replace('www.', ''); }
  catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  console.log(`Analyzing: ${normalizedUrl}`);

  try {
    // Use screenshotone free API to get a screenshot
    // No API key needed for basic usage
    const screenshotUrl = `https://api.screenshotone.com/take?url=${encodeURIComponent(normalizedUrl)}&viewport_width=1280&viewport_height=900&format=jpg&image_quality=80&access_key=free`;

    // Fetch screenshot as buffer
    const screenshotRes = await fetch(screenshotUrl, { signal: AbortSignal.timeout(20000) });

    let screenshotBase64 = null;
    let useVision = false;

    if (screenshotRes.ok) {
      const buffer = await screenshotRes.arrayBuffer();
      screenshotBase64 = Buffer.from(buffer).toString('base64');
      useVision = true;
      console.log(`Screenshot captured for ${domain}`);
    } else {
      console.log(`Screenshot failed for ${domain}, using text analysis`);
    }

    // Build message content
    const messageContent = [];

    if (useVision && screenshotBase64) {
      messageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 }
      });
      messageContent.push({
        type: 'text',
        text: buildVisionPrompt(normalizedUrl, domain)
      });
    } else {
      messageContent.push({
        type: 'text',
        text: buildTextPrompt(normalizedUrl, domain)
      });
    }

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: messageContent }]
    });

    const raw = response.content.map(b => b.text || '').join('').trim();
    const result = extractJSON(raw);

    if (!result) return res.status(500).json({ error: 'Could not parse AI response. Try again.' });

    res.json({ success: true, result, usedScreenshot: useVision });

  } catch (err) {
    console.error(`Error analyzing ${domain}:`, err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Try again.' });
  }
});

function buildVisionPrompt(url, domain) {
  return `You are Mirra, an expert competitive intelligence analyst. You are looking at a REAL LIVE SCREENSHOT of ${domain}.

Analyze EXACTLY what you see in this screenshot. Base your entire analysis on what is visible in the image only.

CRITICAL: Return ONLY a raw JSON object. Start with { end with }. No markdown, no backticks, no text outside the JSON.

{"domain":"${domain}","overallScore":<0-100>,"limitedKnowledge":false,"summary":"<2-3 sentences describing exactly what you see — specific headlines, CTAs, design choices visible in screenshot>","components":[{"name":"Navigation","detail":"<exactly what you see in the nav>","status":"strong|partial|missing|unknown","color":"#1D6AF8"},{"name":"Hero Section","detail":"<exact headline text visible>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Primary CTA","detail":"<exact button text and color visible>","status":"strong|partial|missing|unknown","color":"#D93030"},{"name":"Social Proof","detail":"<exactly what logos or numbers you see>","status":"strong|partial|missing|unknown","color":"#C07A00"},{"name":"Pricing Display","detail":"<visible or not>","status":"strong|partial|missing|unknown","color":"#0F9E52"},{"name":"Trust Signals","detail":"<any badges or certifications visible>","status":"strong|partial|missing|unknown","color":"#0891B2"},{"name":"Value Proposition","detail":"<how clear is the why-us message from what you see>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Mobile Experience","detail":"<visual quality and layout observations>","status":"strong|partial|missing|unknown","color":"#1D6AF8"}],"insights":[{"type":"steal","title":"<4-6 words>","text":"<specific visible strength>","action":"Steal"},{"type":"steal","title":"<4-6 words>","text":"<another visible strength>","action":"Steal"},{"type":"gap","title":"<4-6 words>","text":"<specific visible weakness>","action":"Exploit"},{"type":"gap","title":"<4-6 words>","text":"<another visible weakness>","action":"Exploit"},{"type":"watch","title":"<4-6 words>","text":"<interesting pattern>","action":"Note"}],"scoreBreakdown":{"Visual Design":<0-100>,"CTA Clarity":<0-100>,"Social Proof":<0-100>,"Navigation":<0-100>,"Trust Signals":<0-100>}}`;
}

function buildTextPrompt(url, domain) {
  return `You are Mirra, an expert competitive intelligence analyst with deep knowledge of ${domain}.

Analyze ${url} based on your training knowledge. Be specific and honest — only state what you actually know about this site.

CRITICAL: Return ONLY a raw JSON object. Start with { end with }. No markdown, no backticks, no text outside the JSON.

{"domain":"${domain}","overallScore":<0-100, conservative>,"limitedKnowledge":<true if limited knowledge>,"summary":"<2-3 honest specific sentences about this site>","components":[{"name":"Navigation","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#1D6AF8"},{"name":"Hero Section","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Primary CTA","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#D93030"},{"name":"Social Proof","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#C07A00"},{"name":"Pricing Display","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#0F9E52"},{"name":"Trust Signals","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#0891B2"},{"name":"Value Proposition","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},{"name":"Mobile Experience","detail":"<specific finding>","status":"strong|partial|missing|unknown","color":"#1D6AF8"}],"insights":[{"type":"steal","title":"<4-6 words>","text":"<specific real strength>","action":"Steal"},{"type":"steal","title":"<4-6 words>","text":"<another real strength>","action":"Steal"},{"type":"gap","title":"<4-6 words>","text":"<specific real weakness>","action":"Exploit"},{"type":"gap","title":"<4-6 words>","text":"<another real weakness>","action":"Exploit"},{"type":"watch","title":"<4-6 words>","text":"<interesting pattern>","action":"Note"}],"scoreBreakdown":{"Visual Design":<0-100>,"CTA Clarity":<0-100>,"Social Proof":<0-100>,"Navigation":<0-100>,"Trust Signals":<0-100>}}`;
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
