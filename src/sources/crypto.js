// sources/crypto.js — CoinGecko data source
//
// DataSource interface:
//   id: "crypto"
//   match(intent) → 0.0-1.0 confidence
//   resolve(intent) → Promise<DataSourceResult>
//
// Uses CoinGecko free API (no key). Rate limit: ~10-30 req/min.
// Returns render type "price-card".
// Refresh interval: 60s.

const COINS = [
  { id: 'bitcoin',       name: 'Bitcoin',       symbol: 'BTC'   },
  { id: 'ethereum',      name: 'Ethereum',      symbol: 'ETH'   },
  { id: 'solana',        name: 'Solana',         symbol: 'SOL'   },
  { id: 'cardano',       name: 'Cardano',       symbol: 'ADA'   },
  { id: 'dogecoin',      name: 'Dogecoin',      symbol: 'DOGE'  },
  { id: 'polkadot',      name: 'Polkadot',      symbol: 'DOT'   },
  { id: 'ripple',        name: 'XRP',           symbol: 'XRP'   },
  { id: 'litecoin',      name: 'Litecoin',      symbol: 'LTC'   },
  { id: 'chainlink',     name: 'Chainlink',     symbol: 'LINK'  },
  { id: 'avalanche-2',   name: 'Avalanche',     symbol: 'AVAX'  },
  { id: 'matic-network', name: 'Polygon',       symbol: 'MATIC' },
  { id: 'uniswap',       name: 'Uniswap',       symbol: 'UNI'   },
  { id: 'stellar',       name: 'Stellar',       symbol: 'XLM'   },
  { id: 'cosmos',        name: 'Cosmos',         symbol: 'ATOM'  },
  { id: 'monero',        name: 'Monero',         symbol: 'XMR'   },
  { id: 'tezos',         name: 'Tezos',          symbol: 'XTZ'   },
  { id: 'algorand',      name: 'Algorand',      symbol: 'ALGO'  },
  { id: 'near',          name: 'NEAR',           symbol: 'NEAR'  },
  { id: 'aptos',         name: 'Aptos',          symbol: 'APT'   },
  { id: 'arbitrum',      name: 'Arbitrum',       symbol: 'ARB'   },
  { id: 'optimism',      name: 'Optimism',       symbol: 'OP'    },
  { id: 'tron',          name: 'TRON',           symbol: 'TRX'   },
  { id: 'shiba-inu',     name: 'Shiba Inu',     symbol: 'SHIB'  },
  { id: 'pepe',          name: 'Pepe',           symbol: 'PEPE'  },
  { id: 'bonk',          name: 'Bonk',           symbol: 'BONK'  },
  { id: 'sui',           name: 'Sui',            symbol: 'SUI'   },
  { id: 'sei-network',   name: 'Sei',            symbol: 'SEI'   },
  { id: 'binancecoin',   name: 'BNB',            symbol: 'BNB'   },
];

// Lookup maps built once
const BY_NAME  = new Map(); // lowercase name → coin entry
const BY_SYM   = new Map(); // lowercase symbol → coin entry
const BY_ID    = new Map(); // coingecko id → coin entry

for (const coin of COINS) {
  BY_NAME.set(coin.name.toLowerCase(), coin);
  BY_SYM.set(coin.symbol.toLowerCase(), coin);
  BY_ID.set(coin.id, coin);
}

// Extra aliases
BY_NAME.set('xrp', BY_ID.get('ripple'));
BY_NAME.set('bnb', BY_ID.get('binancecoin'));


export function createCryptoSource() {
  return {
    id: 'crypto',

    /**
     * @param {import('../../contracts').Intent} intent
     * @returns {number} 0.0-1.0 confidence
     */
    match(intent) {
      // Direct parameter match — parser already identified the coin
      if (intent.parameters.coin) {
        const coin = findCoin(intent.parameters.coin, intent.parameters.symbol);
        if (coin) return 0.9;
      }
      if (intent.parameters.symbol) {
        if (BY_SYM.has(intent.parameters.symbol.toLowerCase())) return 0.9;
      }

      // Subject text scan
      const lower = intent.subject.toLowerCase();
      for (const [name] of BY_NAME) {
        if (lower.includes(name)) return 0.85;
      }
      for (const [sym] of BY_SYM) {
        // Only match symbol if it's a whole word (avoid "sol" in "solution")
        const re = new RegExp(`\\b${sym}\\b`);
        if (re.test(lower)) return 0.8;
      }

      // Generic crypto keywords
      if (/\bcrypto(?:currency|currencies)?\b/i.test(lower)) return 0.6;
      if (/\bcoin(?:s)?\b/i.test(lower) && !/\bcoin\s+flip\b/i.test(lower)) return 0.5;

      return 0;
    },

    /**
     * @param {import('../../contracts').Intent} intent
     * @returns {Promise<import('../../contracts').DataSourceResult>}
     */
    async resolve(intent) {
      const coin = findCoinFromIntent(intent);

      if (!coin) {
        return {
          kind: 'clarification',
          request: {
            question: 'Which cryptocurrency would you like to track?',
            options: [
              { label: 'Bitcoin (BTC)',  value: 'bitcoin' },
              { label: 'Ethereum (ETH)', value: 'ethereum' },
              { label: 'Solana (SOL)',   value: 'solana' },
              { label: 'More...',        value: 'crypto' },
            ],
            source: 'crypto',
            context: { originalIntent: intent, parameterKey: 'coin' }
          }
        };
      }

      const url =
        `https://api.coingecko.com/api/v3/simple/price` +
        `?ids=${coin.id}` +
        `&vs_currencies=usd` +
        `&include_24hr_change=true` +
        `&include_24hr_vol=true` +
        `&include_market_cap=true`;

      let resp;
      try {
        resp = await fetch(url);
      } catch (e) {
        return {
          kind: 'error',
          message: `Network error fetching ${coin.name} price. Check your connection.`,
          retryable: true
        };
      }

      if (resp.status === 429) {
        return {
          kind: 'error',
          message: 'CoinGecko rate limit reached. Data will refresh automatically in a minute.',
          retryable: true
        };
      }

      if (!resp.ok) {
        return {
          kind: 'error',
          message: `CoinGecko returned status ${resp.status} for ${coin.name}.`,
          retryable: true
        };
      }

      let body;
      try {
        body = await resp.json();
      } catch (e) {
        return {
          kind: 'error',
          message: `Invalid response from CoinGecko for ${coin.name}.`,
          retryable: true
        };
      }

      const coinData = body[coin.id];
      if (!coinData) {
        return {
          kind: 'error',
          message: `No price data returned for ${coin.name}.`,
          retryable: true
        };
      }

      return {
        kind: 'success',
        descriptor: {
          sourceId: 'crypto',
          title: `${coin.name} (${coin.symbol})`,
          size: 'small',
          refreshIntervalMs: 60_000,
          data: {
            coin: coin.name,
            symbol: coin.symbol,
            coingeckoId: coin.id,
            price: coinData.usd,
            change24h: coinData.usd_24h_change ?? null,
            marketCap: coinData.usd_market_cap ?? null,
            volume24h: coinData.usd_24h_vol ?? null,
          },
          render: {
            type: 'price-card',
            config: {
              type: 'price-card',
              coin: coin.name,
              symbol: coin.symbol,
            }
          },
          resolvedIntent: intent
        }
      };
    }
  };
}


// --- Coin lookup ---

function findCoinFromIntent(intent) {
  const { coin, symbol } = intent.parameters;

  // Try parameters first
  if (coin) {
    const found = findCoin(coin, symbol);
    if (found) return found;
  }
  if (symbol) {
    const found = BY_SYM.get(symbol.toLowerCase());
    if (found) return found;
  }

  // Scan subject
  const lower = intent.subject.toLowerCase();
  for (const [name, entry] of BY_NAME) {
    if (lower.includes(name)) return entry;
  }
  for (const [sym, entry] of BY_SYM) {
    const re = new RegExp(`\\b${sym}\\b`);
    if (re.test(lower)) return entry;
  }

  return null;
}

function findCoin(name, symbol) {
  const lower = name.toLowerCase();
  if (BY_NAME.has(lower)) return BY_NAME.get(lower);
  if (BY_ID.has(lower)) return BY_ID.get(lower);
  if (symbol && BY_SYM.has(symbol.toLowerCase())) return BY_SYM.get(symbol.toLowerCase());
  if (BY_SYM.has(lower)) return BY_SYM.get(lower);
  return null;
}
