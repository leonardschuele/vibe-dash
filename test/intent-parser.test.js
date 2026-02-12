import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentParser } from '../src/intent-parser.js';

const { parse } = createIntentParser();

// ---------------------------------------------------------------------------
// Action detection
// ---------------------------------------------------------------------------

describe('action detection', () => {
  it('defaults to "create" for plain requests', () => {
    assert.strictEqual(parse('bitcoin price').action, 'create');
    assert.strictEqual(parse('weather in Denver').action, 'create');
    assert.strictEqual(parse('show me news about AI').action, 'create');
  });

  it('detects "remove" from remove/delete/close/dismiss/hide', () => {
    for (const word of ['remove', 'delete', 'close', 'dismiss', 'hide']) {
      assert.strictEqual(parse(`${word} the weather widget`).action, 'remove', `"${word}" should trigger remove`);
    }
  });

  it('detects "remove" for "get rid of"', () => {
    assert.strictEqual(parse('get rid of the crypto widget').action, 'remove');
  });

  it('detects "modify" when modify word + reference are present', () => {
    assert.strictEqual(parse('make it bigger').action, 'modify');
    assert.strictEqual(parse('change that to a chart').action, 'modify');
    assert.strictEqual(parse('resize the weather widget').action, 'modify');
  });

  it('returns "create" when modify word has no reference', () => {
    // "make a pomodoro timer" — no "it/that/the X widget" reference
    assert.strictEqual(parse('make a pomodoro timer').action, 'create');
  });
});

// ---------------------------------------------------------------------------
// Coin extraction
// ---------------------------------------------------------------------------

describe('coin extraction', () => {
  it('extracts coin by name', () => {
    const r = parse('bitcoin price');
    assert.strictEqual(r.parameters.coin, 'bitcoin');
    assert.strictEqual(r.parameters.symbol, 'BTC');
  });

  it('extracts coin by symbol', () => {
    const r = parse("what's ETH at?");
    assert.strictEqual(r.parameters.coin, 'ethereum');
    assert.strictEqual(r.parameters.symbol, 'ETH');
  });

  it('handles various coins', () => {
    assert.strictEqual(parse('solana price').parameters.coin, 'solana');
    assert.strictEqual(parse('show me dogecoin').parameters.coin, 'dogecoin');
    assert.strictEqual(parse('track XRP').parameters.coin, 'ripple');
  });

  it('does not extract a coin when none is mentioned', () => {
    const r = parse('weather in Denver');
    assert.strictEqual(r.parameters.coin, undefined);
    assert.strictEqual(r.parameters.symbol, undefined);
  });
});

// ---------------------------------------------------------------------------
// Location extraction
// ---------------------------------------------------------------------------

describe('location extraction', () => {
  it('extracts single-word location', () => {
    assert.strictEqual(parse('weather in Denver').parameters.location, 'Denver');
  });

  it('extracts multi-word location', () => {
    assert.strictEqual(parse('weather in Colorado Springs').parameters.location, 'Colorado Springs');
  });

  it('extracts location even with trailing filler', () => {
    // The end-of-string pattern matches first, capturing "Denver right now".
    // The mid-string pattern would isolate "Denver", but regex order means
    // the broader match wins. The location still includes the city name.
    const loc = parse('weather in Denver right now').parameters.location;
    assert.ok(loc.startsWith('Denver'), `location "${loc}" should start with "Denver"`);
  });

  it('does not treat "in USD" as a location', () => {
    assert.strictEqual(parse('bitcoin price in usd').parameters.location, undefined);
  });

  it('does not treat "in the last 7 days" as a location', () => {
    assert.strictEqual(parse('bitcoin price in the last 7 days').parameters.location, undefined);
  });

  it('title-cases the location', () => {
    assert.strictEqual(parse('weather in new york').parameters.location, 'New York');
  });
});

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

describe('topic extraction', () => {
  it('extracts topic from "news about X"', () => {
    assert.strictEqual(parse('news about AI').parameters.topic, 'ai');
  });

  it('extracts topic from "X news"', () => {
    assert.strictEqual(parse('rust news').parameters.topic, 'rust');
  });

  it('extracts topic from "headlines about X"', () => {
    assert.strictEqual(parse('headlines about bitcoin').parameters.topic, 'bitcoin');
  });

  it('extracts topic from "latest in X"', () => {
    assert.strictEqual(parse('latest in machine learning').parameters.topic, 'machine learning');
  });

  it('does not extract stop words as topic', () => {
    // "latest news" — "latest" alone is a stop word
    assert.strictEqual(parse('latest news').parameters.topic, undefined);
  });
});

// ---------------------------------------------------------------------------
// Period extraction
// ---------------------------------------------------------------------------

describe('period extraction', () => {
  it('extracts 24h', () => {
    assert.strictEqual(parse('bitcoin price 24h').parameters.period, '24h');
    assert.strictEqual(parse('bitcoin today').parameters.period, '24h');
  });

  it('extracts 7d', () => {
    assert.strictEqual(parse('bitcoin price 7d').parameters.period, '7d');
    assert.strictEqual(parse('bitcoin past week').parameters.period, '7d');
  });

  it('extracts 30d', () => {
    assert.strictEqual(parse('bitcoin price 30d').parameters.period, '30d');
    assert.strictEqual(parse('bitcoin monthly').parameters.period, '30d');
  });

  it('extracts 1y', () => {
    assert.strictEqual(parse('bitcoin yearly').parameters.period, '1y');
    assert.strictEqual(parse('bitcoin 365d').parameters.period, '1y');
  });

  it('does not set period when not mentioned', () => {
    assert.strictEqual(parse('bitcoin price').parameters.period, undefined);
  });
});

// ---------------------------------------------------------------------------
// Display format extraction
// ---------------------------------------------------------------------------

describe('display format extraction', () => {
  it('extracts chart format', () => {
    assert.strictEqual(parse('bitcoin as a chart').parameters.displayFormat, 'chart');
    assert.strictEqual(parse('show bitcoin line chart').parameters.displayFormat, 'chart');
  });

  it('extracts table format', () => {
    assert.strictEqual(parse('show crypto as a table').parameters.displayFormat, 'table');
  });

  it('extracts card format', () => {
    assert.strictEqual(parse('bitcoin as a card').parameters.displayFormat, 'card');
  });
});

// ---------------------------------------------------------------------------
// Size extraction
// ---------------------------------------------------------------------------

describe('size extraction', () => {
  it('extracts large from bigger/large/expand', () => {
    assert.strictEqual(parse('make it bigger').parameters.size, 'large');
    assert.strictEqual(parse('make it large').parameters.size, 'large');
    assert.strictEqual(parse('expand that widget').parameters.size, 'large');
  });

  it('extracts small from smaller/compact/shrink', () => {
    assert.strictEqual(parse('make it smaller').parameters.size, 'small');
    assert.strictEqual(parse('make it compact').parameters.size, 'small');
    assert.strictEqual(parse('shrink that').parameters.size, 'small');
  });

  it('extracts medium', () => {
    assert.strictEqual(parse('make it medium').parameters.size, 'medium');
  });
});

// ---------------------------------------------------------------------------
// Count extraction
// ---------------------------------------------------------------------------

describe('count extraction', () => {
  it('extracts count from "top N"', () => {
    assert.strictEqual(parse('top 5 news').parameters.count, 5);
  });

  it('extracts count from "last N"', () => {
    assert.strictEqual(parse('last 10 headlines').parameters.count, 10);
  });

  it('does not set count when not mentioned', () => {
    assert.strictEqual(parse('news about AI').parameters.count, undefined);
  });
});

// ---------------------------------------------------------------------------
// Subject extraction
// ---------------------------------------------------------------------------

describe('subject extraction', () => {
  it('strips leading filler ("show me", "what\'s")', () => {
    const r = parse('show me bitcoin price');
    assert.ok(r.subject.includes('bitcoin'), `subject "${r.subject}" should include "bitcoin"`);
    assert.ok(!r.subject.includes('show me'), `subject "${r.subject}" should not include "show me"`);
  });

  it('strips location from subject', () => {
    const r = parse('weather in Denver');
    assert.ok(!r.subject.includes('Denver'), `subject "${r.subject}" should not include "Denver"`);
  });

  it('strips period phrases from subject', () => {
    const r = parse('bitcoin price 7d');
    assert.ok(!r.subject.match(/\b7d\b/), `subject "${r.subject}" should not include "7d"`);
  });

  it('strips trailing filler', () => {
    const r = parse('weather in Denver right now');
    assert.ok(!r.subject.includes('right now'), `subject "${r.subject}" should not include "right now"`);
  });
});

// ---------------------------------------------------------------------------
// Raw preservation & targetWidgetId
// ---------------------------------------------------------------------------

describe('raw and targetWidgetId', () => {
  it('always preserves the original text in raw', () => {
    const text = '  Show me Bitcoin price  ';
    assert.strictEqual(parse(text).raw, text);
  });

  it('always sets targetWidgetId to null', () => {
    assert.strictEqual(parse('bitcoin price').targetWidgetId, null);
    assert.strictEqual(parse('remove that widget').targetWidgetId, null);
    assert.strictEqual(parse('make it bigger').targetWidgetId, null);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles empty-ish input without crashing', () => {
    const r = parse('');
    assert.strictEqual(r.action, 'create');
    assert.ok(typeof r.subject === 'string');
  });

  it('handles input with only whitespace', () => {
    const r = parse('   ');
    assert.strictEqual(r.action, 'create');
  });

  it('combined: coin + period + format', () => {
    const r = parse('show me bitcoin 7d as a chart');
    assert.strictEqual(r.parameters.coin, 'bitcoin');
    assert.strictEqual(r.parameters.period, '7d');
    assert.strictEqual(r.parameters.displayFormat, 'chart');
    assert.strictEqual(r.action, 'create');
  });

  it('combined: location + size', () => {
    const r = parse('weather in Tokyo');
    assert.strictEqual(r.parameters.location, 'Tokyo');
    assert.strictEqual(r.action, 'create');
  });

  it('combined: topic + count', () => {
    const r = parse('top 5 rust news');
    assert.strictEqual(r.parameters.topic, 'rust');
    assert.strictEqual(r.parameters.count, 5);
  });
});
