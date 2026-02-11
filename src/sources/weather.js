// sources/weather.js — Open-Meteo weather data source
//
// DataSource interface:
//   id: "weather"
//   match(intent) → 0.0-1.0 confidence
//   resolve(intent) → Promise<DataSourceResult>
//
// Uses Open-Meteo free API (no key required).
//   Geocoding: geocoding-api.open-meteo.com
//   Weather:   api.open-meteo.com
//
// Returns render type "weather-card".
// Refresh interval: 5 minutes.

const WEATHER_WORDS = [
  'weather', 'temperature', 'temp', 'forecast', 'rain', 'raining',
  'snow', 'snowing', 'sunny', 'cloudy', 'humid', 'humidity',
  'wind', 'windy', 'storm', 'thunderstorm', 'hail', 'fog',
  'outside', 'hot', 'cold', 'warm', 'freezing'
];

const WEATHER_REGEX = new RegExp(`\\b(${WEATHER_WORDS.join('|')})\\b`, 'i');

// WMO Weather interpretation codes
// https://open-meteo.com/en/docs#weathervariables
const WMO_CODES = {
  0:  { condition: 'Clear sky',           icon: '\u2600\uFE0F' },
  1:  { condition: 'Mainly clear',        icon: '\uD83C\uDF24\uFE0F' },
  2:  { condition: 'Partly cloudy',       icon: '\u26C5' },
  3:  { condition: 'Overcast',            icon: '\u2601\uFE0F' },
  45: { condition: 'Fog',                 icon: '\uD83C\uDF2B\uFE0F' },
  48: { condition: 'Depositing rime fog', icon: '\uD83C\uDF2B\uFE0F' },
  51: { condition: 'Light drizzle',       icon: '\uD83C\uDF26\uFE0F' },
  53: { condition: 'Moderate drizzle',    icon: '\uD83C\uDF26\uFE0F' },
  55: { condition: 'Dense drizzle',       icon: '\uD83C\uDF26\uFE0F' },
  56: { condition: 'Light freezing drizzle', icon: '\uD83C\uDF28\uFE0F' },
  57: { condition: 'Dense freezing drizzle', icon: '\uD83C\uDF28\uFE0F' },
  61: { condition: 'Slight rain',         icon: '\uD83C\uDF27\uFE0F' },
  63: { condition: 'Moderate rain',       icon: '\uD83C\uDF27\uFE0F' },
  65: { condition: 'Heavy rain',          icon: '\uD83C\uDF27\uFE0F' },
  66: { condition: 'Light freezing rain', icon: '\uD83C\uDF28\uFE0F' },
  67: { condition: 'Heavy freezing rain', icon: '\uD83C\uDF28\uFE0F' },
  71: { condition: 'Slight snow',         icon: '\uD83C\uDF28\uFE0F' },
  73: { condition: 'Moderate snow',       icon: '\uD83C\uDF28\uFE0F' },
  75: { condition: 'Heavy snow',          icon: '\u2744\uFE0F' },
  77: { condition: 'Snow grains',         icon: '\u2744\uFE0F' },
  80: { condition: 'Slight rain showers', icon: '\uD83C\uDF26\uFE0F' },
  81: { condition: 'Moderate rain showers', icon: '\uD83C\uDF27\uFE0F' },
  82: { condition: 'Violent rain showers',  icon: '\uD83C\uDF27\uFE0F' },
  85: { condition: 'Slight snow showers', icon: '\uD83C\uDF28\uFE0F' },
  86: { condition: 'Heavy snow showers',  icon: '\u2744\uFE0F' },
  95: { condition: 'Thunderstorm',        icon: '\u26C8\uFE0F' },
  96: { condition: 'Thunderstorm with slight hail', icon: '\u26C8\uFE0F' },
  99: { condition: 'Thunderstorm with heavy hail',  icon: '\u26C8\uFE0F' },
};


export function createWeatherSource() {
  return {
    id: 'weather',

    /**
     * @param {import('../../contracts').Intent} intent
     * @returns {number}
     */
    match(intent) {
      const text = `${intent.subject} ${intent.raw}`.toLowerCase();

      if (WEATHER_REGEX.test(text)) {
        // Stronger match if location is present
        return intent.parameters.location ? 0.9 : 0.7;
      }

      // "what's it like in Denver" — no weather keyword but has location + vague query
      if (intent.parameters.location && /\blike\b/i.test(text)) return 0.6;

      return 0;
    },

    /**
     * @param {import('../../contracts').Intent} intent
     * @returns {Promise<import('../../contracts').DataSourceResult>}
     */
    async resolve(intent) {
      const location = intent.parameters.location || extractLocationFallback(intent.subject);

      if (!location) {
        return {
          kind: 'clarification',
          request: {
            question: 'What location do you want weather for?',
            options: [
              { label: 'Colorado Springs', value: 'Colorado Springs' },
              { label: 'New York',         value: 'New York' },
              { label: 'Los Angeles',      value: 'Los Angeles' },
              { label: 'London',           value: 'London' },
            ],
            source: 'weather',
            context: { originalIntent: intent, parameterKey: 'location' }
          }
        };
      }

      // Step 1: Geocode the location name
      const geo = await geocode(location);
      if (geo.error) return geo.error;

      const { latitude, longitude, displayName } = geo;

      // Step 2: Fetch current weather + 7-day forecast
      const weatherUrl =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${latitude}` +
        `&longitude=${longitude}` +
        `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max` +
        `&temperature_unit=fahrenheit` +
        `&wind_speed_unit=mph` +
        `&timezone=auto` +
        `&forecast_days=7`;

      let weatherResp;
      try {
        weatherResp = await fetch(weatherUrl);
      } catch (e) {
        return {
          kind: 'error',
          message: `Network error fetching weather for ${displayName}.`,
          retryable: true
        };
      }

      if (!weatherResp.ok) {
        return {
          kind: 'error',
          message: `Weather API returned status ${weatherResp.status}.`,
          retryable: true
        };
      }

      let weather;
      try {
        weather = await weatherResp.json();
      } catch (e) {
        return {
          kind: 'error',
          message: `Invalid weather data for ${displayName}.`,
          retryable: true
        };
      }

      const current = weather.current;
      const daily = weather.daily;

      const forecast = daily.time.map((date, i) => ({
        date,
        high: daily.temperature_2m_max[i],
        low: daily.temperature_2m_min[i],
        code: daily.weather_code[i],
        condition: codeToCondition(daily.weather_code[i]),
        icon: codeToIcon(daily.weather_code[i]),
        precipChance: daily.precipitation_probability_max?.[i] ?? null,
      }));

      return {
        kind: 'success',
        descriptor: {
          sourceId: 'weather',
          title: `Weather \u2014 ${displayName}`,
          size: 'medium',
          refreshIntervalMs: 300_000,
          data: {
            location: displayName,
            tempF: current.temperature_2m,
            tempC: fToC(current.temperature_2m),
            feelsLikeF: current.apparent_temperature,
            condition: codeToCondition(current.weather_code),
            icon: codeToIcon(current.weather_code),
            humidity: current.relative_humidity_2m,
            windSpeed: current.wind_speed_10m,
            forecast,
          },
          render: {
            type: 'weather-card',
            config: {
              type: 'weather-card',
              location: displayName,
              units: 'imperial',
            }
          },
          resolvedIntent: intent
        }
      };
    }
  };
}


// --- Geocoding ---

async function geocode(locationName) {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search` +
    `?name=${encodeURIComponent(locationName)}` +
    `&count=1` +
    `&language=en` +
    `&format=json`;

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    return {
      error: {
        kind: 'error',
        message: `Network error looking up "${locationName}".`,
        retryable: true
      }
    };
  }

  if (!resp.ok) {
    return {
      error: {
        kind: 'error',
        message: `Geocoding API returned status ${resp.status}.`,
        retryable: true
      }
    };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return {
      error: {
        kind: 'error',
        message: `Invalid geocoding response for "${locationName}".`,
        retryable: false
      }
    };
  }

  if (!data.results || data.results.length === 0) {
    return {
      error: {
        kind: 'error',
        message: `Couldn't find a location called "${locationName}". Try being more specific.`,
        retryable: false
      }
    };
  }

  const place = data.results[0];
  const parts = [place.name, place.admin1, place.country].filter(Boolean);
  // Deduplicate (e.g. "New York, New York, United States" → "New York, United States")
  const unique = [];
  for (const p of parts) {
    if (!unique.includes(p)) unique.push(p);
  }

  return {
    latitude: place.latitude,
    longitude: place.longitude,
    displayName: unique.join(', '),
  };
}


// --- Location fallback ---
// If the parser didn't extract a location, try a naive scan of the subject

function extractLocationFallback(subject) {
  // Look for "in <words>" pattern
  const m = subject.match(/\bin\s+([a-z][a-z\s,.']+)/i);
  if (m) return m[1].trim();
  return null;
}


// --- Weather code helpers ---

function codeToCondition(code) {
  return WMO_CODES[code]?.condition ?? 'Unknown';
}

function codeToIcon(code) {
  return WMO_CODES[code]?.icon ?? '\u2753';
}

function fToC(f) {
  return Math.round(((f - 32) * 5) / 9);
}
