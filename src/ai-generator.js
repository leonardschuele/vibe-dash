// ai-generator.js — LLM-powered fallback widget generator
//
// Contract:
//   createAiWidgetGenerator(config)
//   generate(intent) → Promise<DataSourceResult>
//
// Calls an OpenAI-compatible chat completions API to produce
// self-contained HTML/CSS/JS rendered inside a sandboxed iframe.
//
// Config:
//   apiKey:  string (required) — bearer token for the LLM API
//   apiUrl:  string (optional) — defaults to OpenAI's chat completions endpoint
//   model:   string (optional) — defaults to "gpt-4o-mini"

const DEFAULT_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are a dashboard widget generator. Given a user's request, produce a single self-contained HTML document that visualizes or implements what they asked for.

Rules:
- Output ONLY the HTML. No markdown fences, no explanation, no commentary.
- The HTML must be completely self-contained: inline <style> and <script> tags.
- Dark theme: use background-color: transparent or #1a1a2e. Text color: #e0e0e0. Accent color: #6c63ff.
- The widget renders inside a fixed-size iframe. Use width: 100% and height: 100%. Use flexbox for layout.
- You may load libraries from CDN (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com) if needed.
- Do not use document.cookie, localStorage, fetch to external APIs with credentials, or any form submission.
- If the request involves live data you cannot access, create a realistic static mockup and label it as sample data.
- The widget should look polished and professional. Use rounded corners, subtle shadows, clean typography.
- Keep it simple. One clear visualization or interaction per widget.`;

export function createAiWidgetGenerator(config = {}) {
  const apiKey = config.apiKey || null;
  const apiUrl = config.apiUrl || DEFAULT_API_URL;
  const model = config.model || DEFAULT_MODEL;

  return {
    /**
     * @param {import('../contracts').Intent} intent
     * @returns {Promise<import('../contracts').DataSourceResult>}
     */
    async generate(intent) {
      if (!apiKey) {
        return {
          kind: 'error',
          message: 'AI widget generation requires an API key. Configure one to enable custom widgets.',
          retryable: false
        };
      }

      const userPrompt = buildUserPrompt(intent);

      let resp;
      try {
        resp = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 4096,
            temperature: 0.7
          })
        });
      } catch (e) {
        return {
          kind: 'error',
          message: 'Network error calling AI service. Check your connection.',
          retryable: true
        };
      }

      if (resp.status === 401 || resp.status === 403) {
        return {
          kind: 'error',
          message: 'AI API key is invalid or expired.',
          retryable: false
        };
      }

      if (resp.status === 429) {
        return {
          kind: 'error',
          message: 'AI service rate limit reached. Try again in a moment.',
          retryable: true
        };
      }

      if (!resp.ok) {
        return {
          kind: 'error',
          message: `AI service returned status ${resp.status}.`,
          retryable: true
        };
      }

      let body;
      try {
        body = await resp.json();
      } catch (e) {
        return {
          kind: 'error',
          message: 'Invalid response from AI service.',
          retryable: false
        };
      }

      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        return {
          kind: 'error',
          message: "AI didn't produce a response. Try rephrasing your request.",
          retryable: false
        };
      }

      const html = extractHtml(content);
      if (!html) {
        return {
          kind: 'error',
          message: "AI response didn't contain valid HTML. Try being more specific.",
          retryable: false
        };
      }

      return {
        kind: 'success',
        descriptor: {
          sourceId: 'ai-generated',
          title: generateTitle(intent),
          size: determineSizeHint(intent),
          refreshIntervalMs: null, // AI widgets are static by default
          data: null, // HTML lives in render.config.html, which survives persistence
          render: {
            type: 'html-block',
            config: { type: 'html-block', html }
          },
          resolvedIntent: intent
        }
      };
    }
  };
}


// --- Prompt construction ---

function buildUserPrompt(intent) {
  const parts = [`Create a dashboard widget for: "${intent.raw}"`];

  if (intent.parameters.period) {
    parts.push(`Time period: ${intent.parameters.period}`);
  }
  if (intent.parameters.displayFormat) {
    parts.push(`Display as: ${intent.parameters.displayFormat}`);
  }
  if (intent.parameters.size) {
    parts.push(`Size preference: ${intent.parameters.size}`);
  }
  if (intent.parameters.count) {
    parts.push(`Show ${intent.parameters.count} items`);
  }

  return parts.join('\n');
}


// --- HTML extraction ---

function extractHtml(content) {
  let html = content.trim();

  // Strip markdown code fences if present
  // Match ```html ... ``` or ``` ... ```
  const fenceMatch = html.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    html = fenceMatch[1].trim();
  }

  // Validate: must contain at least one HTML tag
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    return null;
  }

  // If it's a fragment (no <html> or <!DOCTYPE>), wrap it
  if (!/<html/i.test(html) && !/<\!doctype/i.test(html)) {
    html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; }
</style></head>
<body>${html}</body>
</html>`;
  }

  return html;
}


// --- Title generation ---

function generateTitle(intent) {
  const subject = intent.subject || intent.raw;
  // Title-case the subject, cap at 40 chars
  const titled = subject
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return titled.length > 40 ? titled.slice(0, 37) + '...' : titled;
}


// --- Size hinting ---

function determineSizeHint(intent) {
  // Respect explicit size requests
  if (intent.parameters.size) return intent.parameters.size;

  // Heuristic: complex-sounding things get medium, simple things get small
  const raw = intent.raw.toLowerCase();
  if (/\b(chart|graph|table|list|calendar|schedule|timeline)\b/.test(raw)) {
    return 'medium';
  }
  if (/\b(dashboard|overview|summary|full)\b/.test(raw)) {
    return 'large';
  }
  return 'medium'; // default for AI widgets — they usually need space
}
