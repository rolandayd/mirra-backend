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
  res.json({ status: 'Mirra backend running', version: '4.0.0' });
});

// ── INTELLIGENCE GATHERING ────────────────────────────────

async function fetchTrustpilot(domain) {
  try {
    const cleanDomain = domain.replace('www.', '');
    const url = `https://www.trustpilot.com/review/${cleanDomain}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Pull review text from Trustpilot's data-service-review-text attributes and p tags
    const reviews = [];
    const reviewMatches = html.match(/data-service-review-text-typography[^>]*>([^<]{30,300})</g) || [];
    reviewMatches.slice(0, 10).forEach(m => {
      const text = m.replace(/data-service-review-text-typography[^>]*>/, '').trim();
      if (text.length > 30) reviews.push(text);
    });

    // Also try JSON-LD structured data
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    jsonLdMatch.forEach(block => {
      try {
        const data = JSON.parse(block.replace(/<script[^>]*>/, '').replace('</script>', ''));
        if (data.review) {
          data.review.slice(0, 5).forEach(r => {
            if (r.reviewBody && r.reviewBody.length > 30) reviews.push(r.reviewBody);
          });
        }
      } catch (_) {}
    });

    // Pull star rating distribution if available
    const ratingMatch = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/);
    const countMatch = html.match(/"reviewCount"\s*:\s*"?(\d+)"?/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
    const count = countMatch ? parseInt(countMatch[1]) : null;

    if (reviews.length === 0 && !rating) return null;
    return { reviews: reviews.slice(0, 8), rating, count, source: 'Trustpilot' };
  } catch (e) {
    console.log(`[trustpilot] ${e.message}`);
    return null;
  }
}

async function fetchG2(domain) {
  try {
    const companyName = domain.replace('www.', '').split('.')[0];
    const url = `https://www.g2.com/products/${companyName}/reviews`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const reviews = [];
    // G2 stores reviews in itemprop="reviewBody"
    const matches = html.match(/itemprop="reviewBody"[^>]*>([\s\S]{30,400}?)<\/p>/g) || [];
    matches.slice(0, 8).forEach(m => {
      const text = m.replace(/itemprop="reviewBody"[^>]*>/, '').replace(/<[^>]+>/g, '').trim();
      if (text.length > 30) reviews.push(text);
    });

    const ratingMatch = html.match(/itemprop="ratingValue"[^>]*content="(\d+\.?\d*)"/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

    if (reviews.length === 0 && !rating) return null;
    return { reviews: reviews.slice(0, 8), rating, source: 'G2' };
  } catch (e) {
    console.log(`[g2] ${e.message}`);
    return null;
  }
}

async function fetchNewsSignals(domain) {
  try {
    const companyName = domain.replace('www.', '').split('.')[0];
    const query = encodeURIComponent(`${companyName} funding OR launch OR controversy OR growth OR layoffs`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const xml = await res.text();

    const headlines = [];
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    items.slice(0, 6).forEach(item => {
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
      const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      if (titleMatch) {
        headlines.push({
          title: titleMatch[1].trim(),
          date: dateMatch ? dateMatch[1].trim() : null
        });
      }
    });

    return headlines.length > 0 ? headlines : null;
  } catch (e) {
    console.log(`[news] ${e.message}`);
    return null;
  }
}

async function fetchHiringSignals(domain) {
  try {
    const companyName = domain.replace('www.', '').split('.')[0];
    // Check their careers page directly
    const careerUrls = [
      `https://${domain}/careers`,
      `https://${domain}/jobs`,
      `https://${domain}/about/careers`
    ];

    for (const careerUrl of careerUrls) {
      try {
        const res = await fetch(careerUrl, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }
        });
        if (!res.ok) continue;
        const html = await res.text();

        // Count job listings
        const jobCount = (html.match(/job-listing|position|opening|role|vacancy/gi) || []).length;
        const departments = [];

        // Detect hiring departments
        const deptKeywords = {
          'Engineering': /engineer|developer|backend|frontend|fullstack/gi,
          'Sales': /sales|account executive|business development/gi,
          'Marketing': /marketing|growth|content|seo/gi,
          'Operations': /operations|ops|logistics/gi,
          'Compliance/Legal': /compliance|legal|regulatory|counsel/gi,
          'Customer Success': /customer success|support|success manager/gi,
          'Finance': /finance|accounting|cfo|controller/gi
        };

        Object.entries(deptKeywords).forEach(([dept, pattern]) => {
          if (pattern.test(html)) departments.push(dept);
        });

        if (departments.length > 0 || jobCount > 2) {
          return {
            isHiring: true,
            departments: departments.slice(0, 5),
            signal: departments.includes('Compliance/Legal')
              ? 'Going regulated — hiring compliance/legal'
              : departments.includes('Sales') && departments.includes('Engineering')
              ? 'Scaling aggressively — hiring across sales and engineering'
              : `Active hiring in: ${departments.join(', ')}`
          };
        }
      } catch (_) { continue; }
    }
    return null;
  } catch (e) {
    console.log(`[hiring] ${e.message}`);
    return null;
  }
}

// ── MAIN ANALYZE ROUTE ────────────────────────────────────

app.post('/analyze', async (req, res) => {
  const { url, industry } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let normalizedUrl = url.startsWith('http') ? url : 'https://' + url;
  let domain;
  try { domain = new URL(normalizedUrl).hostname.replace('www.', ''); }
  catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  console.log(`[analyze] ${domain}`);

  // ── Run all intelligence gathering in parallel ──
  const [screenshotResult, trustpilotData, g2Data, newsData, hiringData] = await Promise.allSettled([
    fetchScreenshot(normalizedUrl, domain),
    fetchTrustpilot(domain),
    fetchG2(domain),
    fetchNewsSignals(domain),
    fetchHiringSignals(domain)
  ]);

  const screenshotBase64 = screenshotResult.status === 'fulfilled' ? screenshotResult.value : null;
  const trustpilot = trustpilotData.status === 'fulfilled' ? trustpilotData.value : null;
  const g2 = g2Data.status === 'fulfilled' ? g2Data.value : null;
  const news = newsData.status === 'fulfilled' ? newsData.value : null;
  const hiring = hiringData.status === 'fulfilled' ? hiringData.value : null;

  // Build intelligence summary to inject into prompt
  const intelligence = buildIntelligenceSummary({ trustpilot, g2, news, hiring, domain });
  console.log(`[intelligence] trustpilot:${!!trustpilot} g2:${!!g2} news:${!!news} hiring:${!!hiring}`);

  const messageContent = [];
  if (screenshotBase64) {
    messageContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotBase64 } });
    messageContent.push({ type: 'text', text: buildPrompt(normalizedUrl, domain, industry, true, intelligence) });
  } else {
    messageContent.push({ type: 'text', text: buildPrompt(normalizedUrl, domain, industry, false, intelligence) });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: messageContent }]
    });

    const raw = response.content.map(b => b.text || '').join('').trim();
    const result = extractJSON(raw);

    if (!result) {
      console.log(`[parse error] raw: ${raw.slice(0, 300)}`);
      return res.status(500).json({ error: 'Could not parse AI response — try again.' });
    }

    // Attach raw intelligence metadata
    result._intelligence = {
      hasTrustpilot: !!trustpilot,
      hasG2: !!g2,
      hasNews: !!news,
      hasHiring: !!hiring,
      reviewCount: (trustpilot?.reviews?.length || 0) + (g2?.reviews?.length || 0),
      trustpilotRating: trustpilot?.rating || null,
      hiringSignal: hiring?.signal || null,
      newsCount: news?.length || 0
    };

    res.json({ success: true, result, usedScreenshot: !!screenshotBase64 });

  } catch (err) {
    console.error(`[claude error] ${domain}: ${err.message}`);
    res.status(500).json({ error: err.message || 'Analysis failed. Try again.' });
  }
});

// ── SCREENSHOT ────────────────────────────────────────────

async function fetchScreenshot(normalizedUrl, domain) {
  try {
    const ssUrl = `https://api.screenshotone.com/take?access_key=${SCREENSHOT_API_KEY}&url=${encodeURIComponent(normalizedUrl)}&viewport_width=1280&viewport_height=900&format=jpg&image_quality=80&block_ads=true&block_cookie_banners=true&timeout=15`;
    const ssRes = await fetch(ssUrl, { signal: AbortSignal.timeout(20000) });
    if (ssRes.ok) {
      const buf = await ssRes.arrayBuffer();
      console.log(`[screenshot] captured for ${domain}`);
      return Buffer.from(buf).toString('base64');
    }
    console.log(`[screenshot] failed ${ssRes.status} for ${domain}`);
    return null;
  } catch (e) {
    console.log(`[screenshot] error: ${e.message}`);
    return null;
  }
}

// ── INTELLIGENCE SUMMARY BUILDER ─────────────────────────

function buildIntelligenceSummary({ trustpilot, g2, news, hiring, domain }) {
  const sections = [];

  if (trustpilot?.reviews?.length > 0) {
    sections.push(`TRUSTPILOT CUSTOMER REVIEWS (${trustpilot.rating ? `avg rating: ${trustpilot.rating}/5` : 'rating unknown'}):\n${trustpilot.reviews.map((r, i) => `${i + 1}. "${r}"`).join('\n')}`);
  }

  if (g2?.reviews?.length > 0) {
    sections.push(`G2 CUSTOMER REVIEWS (${g2.rating ? `avg rating: ${g2.rating}/5` : 'rating unknown'}):\n${g2.reviews.map((r, i) => `${i + 1}. "${r}"`).join('\n')}`);
  }

  if (news?.length > 0) {
    sections.push(`RECENT NEWS ABOUT ${domain.toUpperCase()}:\n${news.map(n => `- ${n.title}${n.date ? ` (${n.date})` : ''}`).join('\n')}`);
  }

  if (hiring) {
    sections.push(`HIRING SIGNALS:\n${hiring.signal}\nDepartments actively hiring: ${hiring.departments.join(', ')}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

// ── PROMPT BUILDER ────────────────────────────────────────

function buildPrompt(url, domain, industry, hasScreenshot, intelligence) {
  const source = hasScreenshot
    ? `You are looking at a LIVE screenshot of ${domain}. Analyze what you can see.`
    : `You are analyzing ${domain} based on your training knowledge.`;

  const intelligenceBlock = intelligence
    ? `\n\nREAL INTELLIGENCE DATA GATHERED FROM THE WEB — use this to ground your analysis in actual facts, not assumptions:\n\n${intelligence}\n\nIMPORTANT: The customerAmmunition section MUST be derived directly from the review data above. Quote real complaints. Do not invent.`
    : `\n\nNo review data was found for this domain. For customerAmmunition, use your knowledge of common complaints about this type of company or state that no review data was available.`;

  return `You are Mirra, the world's most advanced competitive intelligence analyst. You help businesses anywhere in the world understand exactly what their competitors are doing and how to beat them.

${source}
${intelligenceBlock}

Industry context: ${industry || 'detect from the site'}

CRITICAL: Return ONLY a raw JSON object. Start with { and end with }. No markdown, no backticks, no text outside the JSON.

{
  "domain": "${domain}",
  "overallScore": <0-100>,
  "threatLevel": "<LOW|MEDIUM|HIGH|CRITICAL>",
  "threatReason": "<one specific sentence — use real data from the intelligence above if available>",
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
    {"priority":1,"impact":"HIGH","action":"<specific instruction — not a suggestion>","why":"<one sentence: which gap this exploits>","effort":"quick|medium|project"},
    {"priority":2,"impact":"HIGH","action":"<second specific action>","why":"<one sentence>","effort":"quick|medium|project"},
    {"priority":3,"impact":"MEDIUM","action":"<third specific action>","why":"<one sentence>","effort":"quick|medium|project"}
  ],
  "beatThemBrief": {
    "headline": "<rewritten headline that directly exploits their biggest gap>",
    "cta": "<rewritten CTA that outperforms theirs>",
    "socialProof": "<specific social proof to collect that beats theirs>",
    "positioning": "<one sentence positioning statement that exploits their weakness>"
  },
  "customerAmmunition": [
    {
      "complaint": "<real complaint their customers make — quoted or paraphrased from reviews if available>",
      "frequency": "high|medium|low",
      "yourAngle": "<exact counter-positioning line you can use in your headline or CTA>",
      "whereToUse": "<hero section|CTA button|pricing page|onboarding email>"
    },
    {
      "complaint": "<second real complaint>",
      "frequency": "high|medium|low",
      "yourAngle": "<counter-positioning line>",
      "whereToUse": "<where to use it>"
    },
    {
      "complaint": "<third real complaint>",
      "frequency": "high|medium|low",
      "yourAngle": "<counter-positioning line>",
      "whereToUse": "<where to use it>"
    }
  ],
  "momentumSignals": {
    "hiringSignal": "<what their hiring pattern reveals about their strategy, or null>",
    "newsSignal": "<most important recent news headline and what it means competitively, or null>",
    "momentumScore": "<accelerating|stable|slowing|unknown — based on available signals>",
    "whatItMeans": "<one sentence: what this momentum means for how you should compete against them right now>"
  },
  "gapScore": <0-100>,
  "scoreBreakdown": {
    "CTA Clarity": <0-100>,
    "Social Proof": <0-100>,
    "Trust Signals": <0-100>,
    "Value Clarity": <0-100>,
    "Navigation UX": <0-100>
  }
}`;
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const stripped = text.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const fi = text.indexOf('{'), li = text.lastIndexOf('}');
  if (fi !== -1 && li > fi) { try { return JSON.parse(text.slice(fi, li + 1)); } catch (_) {} }
  return null;
}

app.listen(PORT, () => console.log(`Mirra v4 backend on port ${PORT}`));      console.log(`[screenshot] failed ${ssRes.status} for ${domain}`);
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
