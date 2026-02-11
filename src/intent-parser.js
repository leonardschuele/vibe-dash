// intent-parser.js — Rule-based natural language → Intent
//
// Pure function. Stateless. No bus dependency.
// Extracts action, parameters, and subject from raw user text.
// Leaves targetWidgetId null — the Context Resolver (Wave 2) fills it in.
//
// The parameter key vocabulary matches contracts.ts IntentParameters exactly.
// If a new data source needs a new key, add it to contracts.ts FIRST,
// then add extraction logic here.

// --- Coin vocabulary (subset — crypto source has the authoritative list) ---

const COINS = {
  bitcoin: 'btc', ethereum: 'eth', solana: 'sol', cardano: 'ada',
  dogecoin: 'doge', polkadot: 'dot', ripple: 'xrp', litecoin: 'ltc',
  chainlink: 'link', avalanche: 'avax', polygon: 'matic', uniswap: 'uni',
  stellar: 'xlm', cosmos: 'atom', monero: 'xmr', tezos: 'xtz',
  algorand: 'algo', near: 'near', aptos: 'apt', arbitrum: 'arb',
  optimism: 'op', tron: 'trx', shiba: 'shib', pepe: 'pepe',
  bonk: 'bonk', sui: 'sui', sei: 'sei'
};

const SYMBOLS_TO_COINS = Object.fromEntries(
  Object.entries(COINS).map(([name, sym]) => [sym, name])
);

// --- Patterns ---

const REMOVE_WORDS = ['remove', 'delete', 'close', 'dismiss', 'hide', 'get rid of', 'clear'];
const MODIFY_WORDS = ['change', 'make', 'update', 'switch', 'modify', 'resize', 'convert', 'set'];

const PERIOD_MAP = [
  { pattern: /\b24\s*h(?:ours?)?\b|\btoday\b|\blast\s+day\b/i, value: '24h' },
  { pattern: /\b7\s*d(?:ays?)?\b|\bweek(?:ly)?\b|\bpast\s+week\b/i, value: '7d' },
  { pattern: /\b30\s*d(?:ays?)?\b|\bmonth(?:ly)?\b|\bpast\s+month\b/i, value: '30d' },
  { pattern: /\b(?:1\s+)?year(?:ly)?\b|\b365\s*d\b|\bannual\b/i, value: '1y' },
];

const FORMAT_MAP = [
  { pattern: /\bline\s+chart\b/i, value: 'chart' },
  { pattern: /\bbar\s+chart\b/i, value: 'chart' },
  { pattern: /\bchart\b/i, value: 'chart' },
  { pattern: /\btable\b/i, value: 'table' },
  { pattern: /\bcard\b/i, value: 'card' },
];

const SIZE_MAP = [
  { pattern: /\b(?:big(?:ger)?|large(?:r)?|expand(?:ed)?|full\s*(?:width|size)?)\b/i, value: 'large' },
  { pattern: /\b(?:small(?:er)?|compact|shrink|tiny|minimize)\b/i, value: 'small' },
  { pattern: /\bmedium\b/i, value: 'medium' },
];

// Phrases that look like "in <something>" but aren't locations
const NON_LOCATION_SUFFIXES = [
  /^(usd|eur|gbp|jpy|cad|aud)\b/i,
  /^(the last|the past|a|an|detail|full|more)\b/i,
  /^(real\s*time|real-time|live)\b/i,
  /^(dollars|euros|percent|%)/i,
];

// --- Public API ---

export function createIntentParser() {
  return { parse };
}

/**
 * @param {string} text — raw user utterance
 * @returns {import('../contracts').Intent}
 */
function parse(text) {
  const raw = text;
  const lower = text.trim().toLowerCase();

  const action = detectAction(lower);
  const parameters = extractParameters(lower);
  const subject = extractSubject(lower, parameters);

  return { action, subject, parameters, raw, targetWidgetId: null };
}

// --- Action detection ---

function detectAction(lower) {
  // Check modify first because "show X as Y" is a modify if there's a "that/it" reference
  if (hasReference(lower) && MODIFY_WORDS.some(w => lower.includes(w))) return 'modify';
  if (/\bshow\b.*\bas\s+a?\s*(chart|table|card|line|bar)\b/i.test(lower) && hasReference(lower)) return 'modify';

  for (const word of REMOVE_WORDS) {
    if (lower.startsWith(word) || lower.includes(` ${word} `)) return 'remove';
  }

  // "make it/that bigger" — modify, not create
  if (MODIFY_WORDS.some(w => lower.startsWith(w)) && hasReference(lower)) return 'modify';

  return 'create';
}

/** Does the text reference an existing widget? ("that", "it", "the X one") */
function hasReference(text) {
  return /\b(that|it|this|the\s+\w+\s+one|the\s+\w+\s+widget)\b/i.test(text);
}

// --- Parameter extraction ---

function extractParameters(lower) {
  const params = {};

  // Coin: match against known names and symbols
  const coinMatch = findCoin(lower);
  if (coinMatch) {
    params.coin = coinMatch.name;
    params.symbol = coinMatch.symbol.toUpperCase();
  }

  // Location: "in <Place>" — but not "in USD" or "in the last 7 days"
  const locationMatch = extractLocation(lower);
  if (locationMatch) {
    params.location = locationMatch;
  }

  // Period
  for (const { pattern, value } of PERIOD_MAP) {
    if (pattern.test(lower)) { params.period = value; break; }
  }

  // Display format
  for (const { pattern, value } of FORMAT_MAP) {
    if (pattern.test(lower)) { params.displayFormat = value; break; }
  }

  // Size
  for (const { pattern, value } of SIZE_MAP) {
    if (pattern.test(lower)) { params.size = value; break; }
  }

  // Count: "top N", "last N", "first N"
  const countMatch = lower.match(/\b(?:top|last|first)\s+(\d+)\b/);
  if (countMatch) {
    params.count = parseInt(countMatch[1], 10);
  }

  return params;
}

function findCoin(lower) {
  // Split on non-alpha to catch things like "what's ETH at?"
  const tokens = lower.split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (COINS[token]) return { name: token, symbol: COINS[token] };
    if (SYMBOLS_TO_COINS[token]) return { name: SYMBOLS_TO_COINS[token], symbol: token };
  }
  return null;
}

function extractLocation(lower) {
  // Pattern: "in <Location>" — capturing words after "in" at or near end of string
  // We try end-of-string first, then mid-string with known terminators
  const patterns = [
    // "weather in Colorado Springs" — "in <words>" at end
    /\bin\s+([a-z][a-z\s,.']+?)\s*$/i,
    // "weather in Denver right now" — "in <words>" before trailing noise
    /\bin\s+([a-z][a-z\s,.']+?)\s+(?:right now|today|tomorrow|this week|please|for me)\s*$/i,
    // "what's the weather in New York like" — "in <words> like"
    /\bin\s+([a-z][a-z\s,.']+?)\s+like\s*$/i,
  ];

  for (const re of patterns) {
    const m = lower.match(re);
    if (m) {
      const candidate = m[1].trim();
      // Filter out non-location phrases
      if (NON_LOCATION_SUFFIXES.some(re => re.test(candidate))) continue;
      // Filter out very short matches that are likely noise
      if (candidate.length < 2) continue;
      return titleCase(candidate);
    }
  }

  return null;
}

// --- Subject extraction ---

function extractSubject(lower, params) {
  let s = lower;

  // Strip leading action verbs / filler
  s = s.replace(
    /^(?:show\s+me|display|give\s+me|what(?:'s|s|\s+is|\s+are)?|track|monitor|add|create|i\s+want|let\s+me\s+see|pull\s+up|get|tell\s+me|can\s+(?:you|i)\s+(?:see|get|have)?|please)\s+/i,
    ''
  );
  // Strip articles
  s = s.replace(/^(?:the|a|an|some|my)\s+/i, '');

  // Strip location phrase
  if (params.location) {
    s = s.replace(new RegExp(`\\bin\\s+${escapeRegex(params.location)}`, 'i'), '');
  }

  // Strip period phrases
  for (const { pattern } of PERIOD_MAP) {
    s = s.replace(pattern, '');
  }

  // Strip format phrases
  s = s.replace(/\bas\s+a?\s*(line\s+)?chart\b/i, '');
  s = s.replace(/\bas\s+a?\s*table\b/i, '');
  s = s.replace(/\bas\s+a?\s*card\b/i, '');

  // Strip size phrases
  for (const { pattern } of SIZE_MAP) {
    s = s.replace(pattern, '');
  }

  // Strip trailing filler
  s = s.replace(/\s+(?:right now|please|for me|currently|like|today|tomorrow|this week)\s*$/i, '');

  // Strip references (these are for modify/remove, not the subject)
  s = s.replace(/\b(?:that|it|this|the\s+\w+\s+one|the\s+\w+\s+widget)\b/i, '');

  // Clean up
  s = s.replace(/\s{2,}/g, ' ').trim();

  // If we stripped everything, fall back to the cleaned lower
  return s || lower.replace(/^(?:show\s+me|what's|track)\s+/i, '').trim() || lower;
}

// --- Util ---

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
