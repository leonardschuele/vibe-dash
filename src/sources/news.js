// sources/news.js — HackerNews (Algolia) data source
//
// DataSource interface:
//   id: "news"
//   match(intent) -> 0.0-1.0 confidence
//   resolve(intent) -> Promise<DataSourceResult>
//
// Uses HackerNews Algolia API (free, no key, CORS-friendly).
//   Front page: hn.algolia.com/api/v1/search?tags=front_page
//   Topic search: hn.algolia.com/api/v1/search?query=TOPIC&tags=story
//
// Returns render type "news-card".
// Refresh interval: 5 minutes.

const NEWS_KEYWORDS = /\b(news|headlines?|articles?|stories|hacker\s*news|hackernews|\bhn\b|tech\s+news|top\s+stories|front\s+page)\b/i;
const TRENDING_KEYWORDS = /\b(trending|latest|what's\s+new|what's\s+happening)\b/i;

export function createNewsSource() {
  return {
    id: 'news',

    /**
     * @param {import('../../contracts').Intent} intent
     * @returns {number} 0.0-1.0 confidence
     */
    match(intent) {
      const text = `${intent.subject} ${intent.raw}`.toLowerCase();

      if (NEWS_KEYWORDS.test(text)) {
        // Topic or query present = strong signal (0.95 beats crypto's 0.9)
        const hasTopic = intent.parameters.topic || intent.parameters.query;
        return hasTopic ? 0.95 : 0.75;
      }

      if (TRENDING_KEYWORDS.test(text)) {
        return 0.65;
      }

      return 0;
    },

    /**
     * @param {import('../../contracts').Intent} intent
     * @returns {Promise<import('../../contracts').DataSourceResult>}
     */
    async resolve(intent) {
      // Extract topic from parameters or parse from subject as fallback
      const topic = intent.parameters.topic
        || intent.parameters.query
        || extractTopicFallback(intent.subject);

      const count = intent.parameters.count
        ? Math.max(3, Math.min(15, intent.parameters.count))
        : 8;

      const url = topic
        ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=${count}`
        : `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`;

      let resp;
      try {
        resp = await fetch(url);
      } catch (e) {
        return {
          kind: 'error',
          message: 'Network error fetching news. Check your connection.',
          retryable: true
        };
      }

      if (resp.status === 429) {
        return {
          kind: 'error',
          message: 'HackerNews API rate limit reached. News will refresh automatically.',
          retryable: true
        };
      }

      if (!resp.ok) {
        return {
          kind: 'error',
          message: `HackerNews API returned status ${resp.status}.`,
          retryable: true
        };
      }

      let body;
      try {
        body = await resp.json();
      } catch (e) {
        return {
          kind: 'error',
          message: 'Invalid response from HackerNews API.',
          retryable: true
        };
      }

      const hits = body.hits;
      if (!hits || hits.length === 0) {
        return {
          kind: 'error',
          message: topic
            ? `No news stories found for "${topic}".`
            : 'No front page stories found.',
          retryable: true
        };
      }

      const stories = hits.map(hit => ({
        title: hit.title,
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        author: hit.author,
        points: hit.points,
        commentCount: hit.num_comments,
        commentUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        createdAt: hit.created_at,
        objectId: hit.objectID,
      }));

      const title = topic
        ? `News \u2014 ${titleCase(topic)}`
        : 'HackerNews \u2014 Front Page';

      return {
        kind: 'success',
        descriptor: {
          sourceId: 'news',
          title,
          size: 'medium',
          refreshIntervalMs: 300_000,
          data: { topic: topic || null, stories },
          render: {
            type: 'news-card',
            config: {
              type: 'news-card',
              topic: topic || null,
              source: 'hackernews',
            }
          },
          resolvedIntent: intent
        }
      };
    }
  };
}


// --- Fallback topic extraction from subject ---

function extractTopicFallback(subject) {
  const lower = subject.toLowerCase();
  const patterns = [
    /\b(?:news|headlines?|stories|articles)\s+(?:about|on|for|regarding)\s+(.+)/i,
    /\b(.+?)\s+(?:news|headlines?|stories|articles)\b/i,
  ];
  for (const re of patterns) {
    const m = lower.match(re);
    if (m) {
      const candidate = m[1].trim().replace(/^(?:the|a|an|some)\s+/i, '');
      if (candidate.length >= 2 && !/^(in|at|near|show|get|my|the)\b/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
