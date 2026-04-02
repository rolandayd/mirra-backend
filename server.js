const express = require('express');
const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Mirra backend running', version: '1.0.0' });
});

// Main analysis endpoint
app.post('/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let normalizedUrl = url;
  if (!normalizedUrl.startsWith('http')) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  let domain;
  try {
    domain = new URL(normalizedUrl).hostname.replace('www.', '');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  console.log(`Analyzing: ${normalizedUrl}`);

  let browser;
  try {
    // Launch Puppeteer
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to page with timeout
    await page.goto(normalizedUrl, {
      waitUntil: 'networkidle2',
      timeout: 25000
    });

    // Wait a beat for any animations/lazy loads
    await new Promise(r => setTimeout(r, 2000));

    // Take full-page screenshot as base64
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 80,
      fullPage: false // above-fold only for speed
    });

    const screenshotBase64 = screenshotBuffer.toString('base64');
    await browser.close();
    browser = null;

    console.log(`Screenshot taken for ${domain}, sending to Claude...`);

    // Send to Claude with vision
    const prompt = buildPrompt(normalizedUrl, domain);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: screenshotBase64
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ]
    });

    const raw = response.content.map(b => b.text || '').join('').trim();
    console.log(`Claude responded for ${domain}`);

    // Parse JSON from response
    const result = extractJSON(raw);
    if (!result) {
      return res.status(500).json({ error: 'Could not parse AI response. Try again.' });
    }

    res.json({ success: true, result });

  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    console.error(`Error analyzing ${domain}:`, err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Try again.' });
  }
});

function buildPrompt(url, domain) {
  return `You are Mirra, an expert competitive intelligence analyst. You are looking at a REAL LIVE SCREENSHOT of ${domain} (${url}).

Analyze EXACTLY what you see in this screenshot. Do not use prior knowledge — only analyze what is visible in the image.

Look for:
- Navigation: what links, structure, sticky header?
- Hero section: what is the headline, subheadline, CTA?
- Primary CTA: button text, color, placement?
- Social proof: logos, numbers, testimonials visible?
- Pricing: visible or not?
- Trust signals: badges, certifications, guarantees?
- Value proposition: how clear is it?
- Mobile/UX: overall visual quality?

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no backticks, no explanation.

{
  "domain": "${domain}",
  "overallScore": <0-100, based only on what you see>,
  "limitedKnowledge": false,
  "summary": "<2-3 sentences describing exactly what you see on this page — specific headlines, CTAs, design choices>",
  "components": [
    {"name":"Navigation","detail":"<exactly what you see>","status":"strong|partial|missing|unknown","color":"#1D6AF8"},
    {"name":"Hero Section","detail":"<exact headline and subheadline you can read>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},
    {"name":"Primary CTA","detail":"<exact button text and color>","status":"strong|partial|missing|unknown","color":"#D93030"},
    {"name":"Social Proof","detail":"<exactly what logos or numbers you see>","status":"strong|partial|missing|unknown","color":"#C07A00"},
    {"name":"Pricing Display","detail":"<visible or not — what you see>","status":"strong|partial|missing|unknown","color":"#0F9E52"},
    {"name":"Trust Signals","detail":"<any badges or certifications visible>","status":"strong|partial|missing|unknown","color":"#0891B2"},
    {"name":"Value Proposition","detail":"<how clear is the why-us message>","status":"strong|partial|missing|unknown","color":"#6B3FD4"},
    {"name":"Mobile Experience","detail":"<visual quality and layout observations>","status":"strong|partial|missing|unknown","color":"#1D6AF8"}
  ],
  "insights":[
    {"type":"steal","title":"<4-6 word title>","text":"<specific thing visible in screenshot that is done well>","action":"Steal"},
    {"type":"steal","title":"<4-6 word title>","text":"<another specific strength visible>","action":"Steal"},
    {"type":"gap","title":"<4-6 word title>","text":"<specific weakness visible in screenshot>","action":"Exploit"},
    {"type":"gap","title":"<4-6 word title>","text":"<another specific weakness>","action":"Exploit"},
    {"type":"watch","title":"<4-6 word title>","text":"<interesting pattern worth noting>","action":"Note"}
  ],
  "scoreBreakdown":{
    "Visual Design":<0-100>,
    "CTA Clarity":<0-100>,
    "Social Proof":<0-100>,
    "Navigation":<0-100>,
    "Trust Signals":<0-100>
  }
}`;
}

function extractJSON(text) {
  // Try direct parse
  try { return JSON.parse(text); } catch (_) {}

  // Strip markdown fences
  const stripped = text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  try { return JSON.parse(stripped); } catch (_) {}

  // Find first { last }
  const fi = text.indexOf('{');
  const li = text.lastIndexOf('}');
  if (fi !== -1 && li > fi) {
    try { return JSON.parse(text.slice(fi, li + 1)); } catch (_) {}
  }

  return null;
}

app.listen(PORT, () => {
  console.log(`Mirra backend running on port ${PORT}`);
});
