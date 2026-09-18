/* ==========================================================================
   Skylark Weather — app.js
   Data sources (no API key required):
     - Weather + hourly + daily: https://api.open-meteo.com/v1/forecast
     - Air quality:              https://air-quality-api.open-meteo.com/v1/air-quality
     - City search:              https://geocoding-api.open-meteo.com/v1/search
     - GPS -> place name:        https://api.bigdatacloud.net/data/reverse-geocode-client
   ========================================================================== */

const state = {
  unit: 'C',
  lat: null, lon: null, placeName: '',
  rawWeather: null, rawAqi: null,
  chartData: null, activeMetric: 'temp',
  chartConfig: null,
  lastResults: [],
  lastRefresh: 0,
};

let dom = {};
let toastTimer = null;
let searchDebounceTimer = null;
let deferredInstallPrompt = null;
const AUTO_REFRESH_MS = 10 * 60 * 1000;

/* ---------------------------------------------------------------------- */
/* Lookup tables                                                          */
/* ---------------------------------------------------------------------- */

const WMO_CODES = {
  0: ['Clear sky', 'clear'], 1: ['Mainly clear', 'clear'],
  2: ['Partly cloudy', 'clouds'], 3: ['Overcast', 'clouds'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Dense drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'drizzle'], 57: ['Freezing drizzle', 'drizzle'],
  61: ['Slight rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Slight snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Rain showers', 'rain'], 81: ['Rain showers', 'rain'], 82: ['Violent rain showers', 'rain'],
  85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm with hail', 'storm'], 99: ['Severe thunderstorm', 'storm'],
};

function weatherCodeInfo(code) {
  const e = WMO_CODES[code] || ['Unsettled', 'clouds'];
  return { label: e[0], category: e[1] };
}

function aqiCategory(v) {
  if (v == null || Number.isNaN(v)) return { label: '—', color: '#9aa4b2' };
  if (v <= 50) return { label: 'Good', color: '#4cb782' };
  if (v <= 100) return { label: 'Moderate', color: '#f0a93c' };
  if (v <= 150) return { label: 'Unhealthy (sensitive)', color: '#ff8a5b' };
  if (v <= 200) return { label: 'Unhealthy', color: '#e8615c' };
  if (v <= 300) return { label: 'Very unhealthy', color: '#b25bd0' };
  return { label: 'Hazardous', color: '#7a2048' };
}

function uvCategory(v) {
  if (v == null) return '—';
  if (v <= 2) return 'Low';
  if (v <= 5) return 'Moderate';
  if (v <= 7) return 'High';
  if (v <= 10) return 'Very high';
  return 'Extreme';
}

const EMOJI = {
  clear: ['🌙', '☀️'], clouds: ['☁️', '⛅'], fog: ['🌫️', '🌫️'],
  drizzle: ['🌦️', '🌦️'], rain: ['🌧️', '🌧️'], snow: ['❄️', '❄️'], storm: ['⛈️', '⛈️'],
};
function emojiFor(category, isDay) {
  const pair = EMOJI[category] || EMOJI.clouds;
  return pair[isDay ? 1 : 0];
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function degToCompass(deg) { return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }

/* ---------------------------------------------------------------------- */
/* Unit + formatting helpers                                              */
/* ---------------------------------------------------------------------- */

function cToF(c) { return c * 9 / 5 + 32; }
function kmhToMph(k) { return k / 1.60934; }

function formatTemp(c) { return Math.round(state.unit === 'F' ? cToF(c) : c); }
function windUnitLabel() { return state.unit === 'F' ? 'mph' : 'km/h'; }
function formatWind(kmh) { return Math.round(state.unit === 'F' ? kmhToMph(kmh) : kmh); }
function formatPrecip(mm) { return state.unit === 'F' ? (mm / 25.4).toFixed(2) + ' in' : mm.toFixed(1) + ' mm'; }
function formatPressure(hpa) { return state.unit === 'F' ? (hpa * 0.02953).toFixed(2) + ' inHg' : Math.round(hpa) + ' hPa'; }
function formatVisibility(m) {
  if (m == null) return '—';
  if (state.unit === 'F') { const mi = m / 1609.34; return mi >= 10 ? '10+ mi' : mi.toFixed(1) + ' mi'; }
  const km = m / 1000; return km >= 10 ? '10+ km' : km.toFixed(1) + ' km';
}
function visibilityNote(m) {
  if (m == null) return '';
  if (m >= 10000) return 'clear';
  if (m >= 4000) return 'slight haze';
  if (m >= 1000) return 'reduced';
  return 'very low';
}

function parseLocal(str) { return new Date(str); }
function hourLabel(d) { return d.toLocaleTimeString([], { hour: 'numeric' }); }

function findNowIndex(times, currentTimeStr) {
  const cur = parseLocal(currentTimeStr).getTime();
  let idx = 0;
  for (let i = 0; i < times.length; i++) {
    if (parseLocal(times[i]).getTime() <= cur) idx = i; else break;
  }
  return idx;
}

/* ---------------------------------------------------------------------- */
/* Networking                                                             */
/* ---------------------------------------------------------------------- */

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    current: ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day', 'precipitation',
      'weather_code', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'].join(','),
    hourly: ['temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'weather_code',
      'relative_humidity_2m', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index', 'visibility', 'is_day'].join(','),
    daily: ['temperature_2m_max', 'temperature_2m_min', 'uv_index_max', 'precipitation_probability_max', 'precipitation_sum', 'sunrise', 'sunset'].join(','),
    timezone: 'auto', forecast_days: '3', wind_speed_unit: 'kmh',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!res.ok) throw new Error('weather_fetch_failed');
  return res.json();
}

async function fetchAQI(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    current: 'us_aqi,european_aqi,pm2_5,pm10',
    hourly: 'us_aqi',
    timezone: 'auto', forecast_days: '3',
  });
  const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params.toString()}`);
  if (!res.ok) throw new Error('aqi_fetch_failed');
  return res.json();
}

const DEMO_WEATHER_PRESETS = [
  { id: 'warm-clear', label: 'Warm + clear', weatherCode: 1, category: 'clear', temp: 28, feelsLike: 29, windKph: 12, humidity: 38, precip: 0, uv: 7, visibility: 14000, aqi: 36 },
  { id: 'rainy-mild', label: 'Rainy + mild', weatherCode: 61, category: 'rain', temp: 14, feelsLike: 13, windKph: 23, humidity: 76, precip: 3.2, uv: 2, visibility: 7000, aqi: 82 },
  { id: 'snow-cold', label: 'Snow + below freezing', weatherCode: 71, category: 'snow', temp: -4, feelsLike: -9, windKph: 18, humidity: 81, precip: 2.6, uv: 0, visibility: 4200, aqi: 58 },
  { id: 'storm-windy', label: 'Storm + windy', weatherCode: 95, category: 'storm', temp: 18, feelsLike: 15, windKph: 42, humidity: 70, precip: 8.5, uv: 3, visibility: 3200, aqi: 92 },
  { id: 'fog-cool', label: 'Fog + cool', weatherCode: 45, category: 'fog', temp: 6, feelsLike: 4, windKph: 9, humidity: 88, precip: 0, uv: 1, visibility: 1800, aqi: 44 },
  { id: 'hot-clear', label: 'Hot + clear', weatherCode: 0, category: 'clear', temp: 33, feelsLike: 35, windKph: 10, humidity: 30, precip: 0, uv: 10, visibility: 16000, aqi: 48 },
  { id: 'cold-clear', label: 'Cold + clear', weatherCode: 1, category: 'clear', temp: -8, feelsLike: -14, windKph: 16, humidity: 62, precip: 0, uv: 1, visibility: 9000, aqi: 62 },
];

function makeDemoWeatherPayload(preset) {
  const now = new Date();
  const toIso = (offsetHours) => new Date(now.getTime() + offsetHours * 60 * 60 * 1000).toISOString();
  const times = Array.from({ length: 24 }, (_, i) => toIso(i));
  const hourlyTemperatures = Array.from({ length: 24 }, (_, i) => preset.temp + Math.sin(i / 3.3) * 4.5);
  const hourlyFeels = Array.from({ length: 24 }, (_, i) => preset.feelsLike + Math.sin((i + 1) / 3.7) * 3.2);
  const hourlyPop = Array.from({ length: 24 }, (_, i) => Math.max(0, Math.min(100, preset.category === 'rain' ? 60 + Math.sin(i / 2.6) * 25 : preset.category === 'storm' ? 75 + Math.sin(i / 2.1) * 18 : preset.category === 'snow' ? 45 + Math.sin(i / 2.8) * 25 : 10 + i * 0.8)));
  const hourlyPrecip = Array.from({ length: 24 }, (_, i) => preset.precip > 0 ? Math.max(0, preset.precip * (0.45 + (Math.cos(i / 2.6) + 1) / 4)) : 0);
  const hourlyWind = Array.from({ length: 24 }, (_, i) => Math.max(0, preset.windKph + Math.sin(i / 2.2) * 6));
  const hourlyGust = Array.from({ length: 24 }, (_, i) => Math.max(0, preset.windKph * 1.4 + Math.sin(i / 1.7) * 10));
  const hourlyHumidity = Array.from({ length: 24 }, (_, i) => preset.humidity + Math.sin((i + 3) / 2.4) * 18);
  const hourlyUv = Array.from({ length: 24 }, (_, i) => Math.max(0, preset.uv + Math.sin(i / 2.1) * 2));
  const hourlyVisibility = Array.from({ length: 24 }, (_, i) => Math.max(200, preset.visibility + Math.sin(i / 2.8) * 2500));
  const weatherCodes = Array.from({ length: 24 }, () => preset.weatherCode);

  const dailyMax = Math.max(...hourlyTemperatures);
  const dailyMin = Math.min(...hourlyTemperatures);
  const sunrise = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  const sunset = new Date(now.getTime() + 18 * 60 * 60 * 1000).toISOString();

  return {
    latitude: 0,
    longitude: 0,
    current: {
      time: now.toISOString(),
      temperature_2m: preset.temp,
      apparent_temperature: preset.feelsLike,
      relative_humidity_2m: preset.humidity,
      precipitation: preset.precip,
      weather_code: preset.weatherCode,
      cloud_cover: 45,
      pressure_msl: 1016,
      wind_speed_10m: preset.windKph,
      wind_direction_10m: 180,
      wind_gusts_10m: preset.windKph * 1.5,
      is_day: 1,
    },
    hourly: {
      time: times,
      temperature_2m: hourlyTemperatures,
      apparent_temperature: hourlyFeels,
      precipitation_probability: hourlyPop,
      precipitation: hourlyPrecip,
      weather_code: weatherCodes,
      relative_humidity_2m: hourlyHumidity,
      wind_speed_10m: hourlyWind,
      wind_gusts_10m: hourlyGust,
      uv_index: hourlyUv,
      visibility: hourlyVisibility,
      is_day: Array.from({ length: 24 }, () => 1),
    },
    daily: {
      temperature_2m_max: [dailyMax],
      temperature_2m_min: [dailyMin],
      uv_index_max: [Math.max(...hourlyUv)],
      precipitation_probability_max: [Math.max(...hourlyPop)],
      precipitation_sum: [hourlyPrecip.reduce((sum, value) => sum + value, 0)],
      sunrise: [sunrise],
      sunset: [sunset],
    },
  };
}

async function geocodeSearch(name) {
  const trimmed = name.trim();
  const slug = trimmed.toLowerCase();
  if (slug.includes('weather lab') || slug.includes('skylark test') || slug.includes('test weather') || slug.includes('demo weather')) {
    return DEMO_WEATHER_PRESETS.map((preset, index) => ({
      name: `Skylark Weather Lab — ${preset.label}`,
      admin1: 'Demo mode',
      country: 'Test',
      latitude: 0,
      longitude: 0,
      isDemo: true,
      demoMode: preset.id,
      demoIndex: index,
    }));
  }

  const params = new URLSearchParams({ name, count: '8', language: 'en', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`);
  if (!res.ok) throw new Error('geocode_failed');
  const data = await res.json();
  return data.results || [];
}

async function reverseGeocodeLabel(lat, lon) {
  const res = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
  if (!res.ok) throw new Error('reverse_failed');
  const data = await res.json();
  const city = data.city || data.locality || data.principalSubdivision;
  const country = data.countryName;
  if (city && country) return `${city}, ${country}`;
  return city || country || 'Your location';
}

function formatPlaceLabel(r) {
  const bits = [r.name];
  if (r.country) bits.push(r.country);
  else if (r.admin1) bits.push(r.admin1);
  return bits.join(', ');
}

function loadDemoWeatherPreset(modeId, label) {
  const preset = DEMO_WEATHER_PRESETS.find((item) => item.id === modeId) || DEMO_WEATHER_PRESETS[0];
  const payload = makeDemoWeatherPayload(preset);
  state.lat = 0;
  state.lon = 0;
  state.placeName = label || `Skylark Weather Lab — ${preset.label}`;
  state.rawWeather = payload;
  state.rawAqi = {
    current: { us_aqi: preset.aqi },
    hourly: { time: payload.hourly.time, us_aqi: Array.from({ length: 24 }, (_, i) => Math.max(10, preset.aqi + Math.sin(i / 2.7) * 18)) },
  };
  state.lastRefresh = Date.now();
  render();
  showState('content');
  scheduleAutoRefresh();
}

/* ---------------------------------------------------------------------- */
/* Persistence                                                            */
/* ---------------------------------------------------------------------- */

function saveLastLocation(loc) { try { localStorage.setItem('skylark:last', JSON.stringify(loc)); } catch (_) {} }
function loadLastLocation() { try { const raw = localStorage.getItem('skylark:last'); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }

/* ---------------------------------------------------------------------- */
/* UI state panels + toast                                                */
/* ---------------------------------------------------------------------- */

function showState(name) {
  if (dom.stateLoading) dom.stateLoading.style.display = name === 'loading' ? 'flex' : 'none';
  if (dom.stateError) dom.stateError.style.display = name === 'error' ? 'flex' : 'none';
  const contentDisplay = name === 'content' ? '' : 'none';
  if (dom.hero) dom.hero.style.display = contentDisplay;
  if (dom.hourlySection) dom.hourlySection.style.display = contentDisplay;
  if (dom.guidanceSection) dom.guidanceSection.style.display = contentDisplay;
  if (dom.appFooter) dom.appFooter.style.display = contentDisplay;
}

function showNotice({ title, body, actionLabel, action }) {
  dom.errorTitle.textContent = title;
  dom.errorBody.textContent = body;
  if (actionLabel) {
    dom.errorRetry.textContent = actionLabel;
    dom.errorRetry.style.display = '';
    dom.errorRetry.onclick = action;
  } else {
    dom.errorRetry.style.display = 'none';
    dom.errorRetry.onclick = null;
  }
  showState('error');
}

function toast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 3600);
}

function setLocateBusy(busy) { dom.locateBtn.classList.toggle('is-busy', busy); }

/* ---------------------------------------------------------------------- */
/* Location flow                                                          */
/* ---------------------------------------------------------------------- */

async function loadLocation(lat, lon, label, options = {}) {
  const { silent = false, refreshOnly = false } = options;
  if (!silent) {
    showState('loading');
    dom.loadingTitle.textContent = 'Finding your sky…';
  }
  try {
    const weatherPromise = fetchWeather(lat, lon);
    const aqiPromise = fetchAQI(lat, lon).catch(() => null);
    const [weatherData, aqiData] = await Promise.all([weatherPromise, aqiPromise]);
    state.lat = lat; state.lon = lon; state.placeName = label;
    state.rawWeather = weatherData; state.rawAqi = aqiData;
    state.lastRefresh = Date.now();
    render();
    if (!silent && !refreshOnly) showState('content');
    if (!state.rawWeather || !state.rawWeather.current) return;
    scheduleAutoRefresh();
  } catch (err) {
    if (silent) {
      toast('Weather refresh failed — trying again soon.');
      return;
    }
    showNotice({
      title: "Couldn't load the forecast",
      body: 'Check your connection and try again.',
      actionLabel: 'Try again',
      action: () => loadLocation(lat, lon, label),
    });
  }
}

async function refreshWeatherData() {
  if (state.lat == null || state.lon == null) return;
  await loadLocation(state.lat, state.lon, state.placeName, { silent: true, refreshOnly: true });
}

function scheduleAutoRefresh() {
  clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (state.lat == null || state.lon == null) return;
    if (Date.now() - state.lastRefresh >= AUTO_REFRESH_MS) refreshWeatherData();
  }, 60000);
}

function useMyLocation() {
  if (!('geolocation' in navigator)) { toast('Location access is not available in this browser.'); return; }
  setLocateBusy(true);
  showState('loading');
  dom.loadingTitle.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      let label = 'Your location';
      try { label = await reverseGeocodeLabel(lat, lon); } catch (_) {}
      setLocateBusy(false);
      saveLastLocation({ lat, lon, label });
      loadLocation(lat, lon, label);
    },
    (err) => {
      setLocateBusy(false);
      const messages = {
        1: 'Location access was denied.',
        2: "Couldn't determine your location.",
        3: 'The location request timed out.',
      };
      showNotice({
        title: messages[err.code] || 'Location unavailable',
        body: 'Search for a city above instead.',
        actionLabel: 'Try location again',
        action: useMyLocation,
      });
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

function selectResult(r) {
  if (r.isDemo) {
    const presetId = r.demoMode || 'warm-clear';
    const label = r.name || `Skylark Weather Lab — ${presetId}`;
    loadDemoWeatherPreset(presetId, label);
    return;
  }

  const label = formatPlaceLabel(r);
  saveLastLocation({ lat: r.latitude, lon: r.longitude, label });
  loadLocation(r.latitude, r.longitude, label);
}

/* ---------------------------------------------------------------------- */
/* Guidance rules                                                         */
/* ---------------------------------------------------------------------- */

function clothingGuidance(feelsLike, windKph) {
  let body, tone = 'good';
  if (feelsLike >= 28) body = 'Light clothing — a t-shirt and shorts will feel right. Stay hydrated in the heat.';
  else if (feelsLike >= 22) body = 'T-shirt weather. Pack a light layer in case the evening cools down.';
  else if (feelsLike >= 16) body = 'A long-sleeve shirt or a light jacket is comfortable today.';
  else if (feelsLike >= 10) { body = 'Jacket weather — add a sweater underneath for comfort.'; tone = 'caution'; }
  else if (feelsLike >= 4) { body = 'A warm coat, plus a hat and gloves for longer stretches outside.'; tone = 'caution'; }
  else if (feelsLike >= -5) { body = "Heavy winter coat, thermal layers, gloves and a hat — it's properly cold."; tone = 'alert'; }
  else { body = 'Extreme cold. Bundle up in full winter gear and keep time outside short.'; tone = 'alert'; }
  if (windKph >= 25 && feelsLike < 18) body += ' The wind will cut through, so add a windproof outer layer.';
  return { icon: 'ic-shirt', title: 'What to wear', body, tone };
}

function umbrellaGuidance(popNext6, precipNow) {
  if (precipNow > 0) return { icon: 'ic-umbrella', title: 'Umbrella', body: "It's coming down now — bring an umbrella or a hooded jacket.", tone: 'alert' };
  if (popNext6 >= 60) return { icon: 'ic-umbrella', title: 'Umbrella', body: `Rain is likely soon (${Math.round(popNext6)}% chance) — bring an umbrella.`, tone: 'alert' };
  if (popNext6 >= 30) return { icon: 'ic-umbrella', title: 'Umbrella', body: `A chance of rain later (${Math.round(popNext6)}%) — worth keeping one handy.`, tone: 'caution' };
  return { icon: 'ic-umbrella', title: 'Umbrella', body: 'No rain expected soon — leave the umbrella at home.', tone: 'good' };
}

function activityGuidance(feelsLike, windKph, aqiUS, popNext6, isDay) {
  const reasons = [];
  if (feelsLike < 2 || feelsLike > 32) reasons.push('the temperature is extreme');
  if (windKph >= 35) reasons.push('winds are strong');
  if (aqiUS != null && aqiUS > 100) reasons.push('air quality is poor');
  if (popNext6 >= 60) reasons.push('rain is likely');
  if (!isDay) reasons.push("it's dark — stick to lit routes");
  if (!reasons.length) return { icon: 'ic-walk', title: 'Walk or run', body: 'Conditions look pleasant — a good time for a walk or run outside.', tone: 'good' };
  return { icon: 'ic-walk', title: 'Walk or run', body: `Take it easy outside today — ${reasons.join(' and ')}.`, tone: reasons.length > 1 ? 'alert' : 'caution' };
}

function trekGuidance(feelsLike, uvMax, visibilityM, windKph, popNext6) {
  const notes = [];
  let tone = 'good';
  if (visibilityM != null && visibilityM < 2000) { notes.push('visibility is low — stick to familiar trails'); tone = 'caution'; }
  if (uvMax >= 8) { notes.push('UV is very high — sunscreen and a hat are a must'); tone = 'caution'; }
  if (windKph >= 40) { notes.push('winds are strong on higher ground'); tone = 'alert'; }
  if (popNext6 >= 60) { notes.push('rain is likely — pack a waterproof layer'); tone = 'caution'; }
  if (feelsLike < -5 || feelsLike > 34) { notes.push('temperatures are extreme for a long hike'); tone = 'alert'; }
  if (!notes.length) return { icon: 'ic-tree', title: 'Trekking & hikes', body: 'Good conditions for a longer hike — pack water and enjoy the trail.', tone: 'good' };
  return { icon: 'ic-tree', title: 'Trekking & hikes', body: `Doable, but plan around it: ${notes.join('; ')}.`, tone };
}

function carWashGuidance(popMax24, precipSum24) {
  if (precipSum24 > 0.5 || popMax24 >= 50) return { icon: 'ic-car', title: 'Car wash', body: 'Skip it for now — rain is likely within the next 24 hours.', tone: 'caution' };
  return { icon: 'ic-car', title: 'Car wash', body: 'Good day for it — no rain expected in the next 24 hours.', tone: 'good' };
}

function uvGuidance(uvMax) {
  if (uvMax >= 11) return { icon: 'ic-sun', title: 'Sun & UV', body: 'Extreme UV — avoid the sun between 10am–4pm and cover up fully.', tone: 'alert' };
  if (uvMax >= 8) return { icon: 'ic-sun', title: 'Sun & UV', body: 'Very high UV — sunscreen, sunglasses and shade during midday.', tone: 'alert' };
  if (uvMax >= 6) return { icon: 'ic-sun', title: 'Sun & UV', body: "High UV — wear sunscreen if you'll be outside for a while.", tone: 'caution' };
  if (uvMax >= 3) return { icon: 'ic-sun', title: 'Sun & UV', body: 'Moderate UV — sunscreen is a good idea around midday.', tone: 'caution' };
  return { icon: 'ic-sun', title: 'Sun & UV', body: 'Low UV today — minimal sun protection needed.', tone: 'good' };
}

function aqiGuidance(aqiUS) {
  const cat = aqiCategory(aqiUS);
  if (aqiUS == null) return { icon: 'ic-lungs', title: 'Air quality', body: 'Air quality data is unavailable for this location right now.', tone: 'good' };
  let body, tone;
  if (aqiUS <= 50) { body = 'Air quality is good — a great day to be outside.'; tone = 'good'; }
  else if (aqiUS <= 100) { body = 'Air quality is acceptable, though unusually sensitive people should take it easy.'; tone = 'good'; }
  else if (aqiUS <= 150) { body = 'Sensitive groups (asthma, heart or lung conditions) should limit prolonged outdoor exertion.'; tone = 'caution'; }
  else if (aqiUS <= 200) { body = 'Air quality is unhealthy — consider limiting time outdoors, especially strenuous activity.'; tone = 'alert'; }
  else { body = 'Air quality is very poor — stay indoors where possible and keep windows closed.'; tone = 'alert'; }
  return { icon: 'ic-lungs', title: `Air quality — ${cat.label}`, body, tone };
}

function renderGuidance(ctx) {
  const cards = [
    clothingGuidance(ctx.feelsLike, ctx.windKph),
    umbrellaGuidance(ctx.popNext6, ctx.precipNow),
    activityGuidance(ctx.feelsLike, ctx.windKph, ctx.aqiUS, ctx.popNext6, ctx.isDay),
    trekGuidance(ctx.feelsLike, ctx.uvMax, ctx.visibilityNow, ctx.windKph, ctx.popNext6),
    carWashGuidance(ctx.popMax24, ctx.precipSum24),
    uvGuidance(ctx.uvMax),
    aqiGuidance(ctx.aqiUS),
  ];
  dom.guidanceGrid.innerHTML = cards.map((c) => `
    <div class="g-card panel tone-${c.tone}">
      <div class="g-card-icon"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><use href="#${c.icon}"/></svg></div>
      <div class="g-card-title">${c.title}</div>
      <div class="g-card-body">${c.body}</div>
    </div>`).join('');
}

/* ---------------------------------------------------------------------- */
/* Hourly strip + charts                                                  */
/* ---------------------------------------------------------------------- */

function renderHourStrip(hourly, nowIndex) {
  const items = [];
  const end = Math.min(hourly.time.length, nowIndex + 24);
  for (let i = nowIndex; i < end; i++) {
    const d = parseLocal(hourly.time[i]);
    const label = i === nowIndex ? 'Now' : hourLabel(d);
    const cat = weatherCodeInfo(hourly.weather_code[i]).category;
    const emoji = emojiFor(cat, hourly.is_day[i] === 1);
    const t = formatTemp(hourly.temperature_2m[i]);
    const pop = hourly.precipitation_probability ? hourly.precipitation_probability[i] : null;
    items.push(`<div class="hour-card ${i === nowIndex ? 'is-now' : ''}">
      <div class="hour-time">${label}</div>
      <div class="hour-icon" aria-hidden="true" style="font-size:22px;line-height:1">${emoji}</div>
      <div class="hour-temp">${t}°</div>
      ${pop != null && pop >= 20 ? `<div class="hour-pop">${Math.round(pop)}%</div>` : '<div class="hour-pop">&nbsp;</div>'}
    </div>`);
  }
  dom.hourStrip.innerHTML = items.join('');
}

function buildChartDatasets(hourly, nowIndex, aqiHourly, nowIndexAqi) {
  const n = Math.min(24, hourly.time.length - nowIndex);
  const labels = [], temp = [], feels = [], pop = [], precipMm = [], wind = [], gust = [], hum = [], uv = [], aqi = [];
  for (let k = 0; k < n; k++) {
    const i = nowIndex + k;
    const d = parseLocal(hourly.time[i]);
    labels.push(k === 0 ? 'Now' : hourLabel(d));
    temp.push(state.unit === 'F' ? cToF(hourly.temperature_2m[i]) : hourly.temperature_2m[i]);
    feels.push(state.unit === 'F' ? cToF(hourly.apparent_temperature[i]) : hourly.apparent_temperature[i]);
    pop.push(hourly.precipitation_probability ? hourly.precipitation_probability[i] : 0);
    precipMm.push(hourly.precipitation ? hourly.precipitation[i] : 0);
    wind.push(state.unit === 'F' ? kmhToMph(hourly.wind_speed_10m[i]) : hourly.wind_speed_10m[i]);
    gust.push(state.unit === 'F' ? kmhToMph(hourly.wind_gusts_10m[i]) : hourly.wind_gusts_10m[i]);
    hum.push(hourly.relative_humidity_2m[i]);
    uv.push(hourly.uv_index ? hourly.uv_index[i] : 0);
    const ai = nowIndexAqi + k;
    aqi.push(aqiHourly && aqiHourly.us_aqi && ai < aqiHourly.us_aqi.length ? aqiHourly.us_aqi[ai] : null);
  }
  return { labels, temp, feels, pop, precipMm, wind, gust, hum, uv, aqi };
}

function syncChartSelection(metric) {
  const activeMetric = metric || 'temp';
  state.activeMetric = activeMetric;
  document.querySelectorAll('.chart-tab').forEach((button) => {
    const isSelected = button.dataset.metric === activeMetric;
    button.setAttribute('aria-selected', String(isSelected));
  });
}

function renderChart(metric) {
  const allowed = ['temp', 'precip', 'wind', 'humidity', 'uv', 'aqi'];
  const activeMetric = allowed.includes(metric) ? metric : 'temp';
  state.activeMetric = activeMetric;
  syncChartSelection(activeMetric);
  const cd = state.chartData;
  if (!cd) return;
  const windUnit = windUnitLabel();
  let config;
  if (metric === 'temp') {
    config = {
      type: 'line', labels: cd.labels, nowIndex: 0, yFormat: (v) => Math.round(v) + '°',
      series: [{ name: 'Temperature', color: '#ff8a5b', data: cd.temp }, { name: 'Feels like', color: '#5bc8ff', data: cd.feels }],
      gridColor: 'rgba(255,255,255,0.5)', textColor: '#ffffff',
    };
    dom.chartLegend.innerHTML = legendDot('#ff8a5b', 'Temperature') + legendDot('#5bc8ff', 'Feels like');
  } else if (metric === 'precip') {
    config = {
      type: 'bar', labels: cd.labels, nowIndex: 0, yFormat: (v) => Math.round(v) + '%',
      series: [{ name: 'Chance of rain', color: '#5bc8ff', data: cd.pop }],
      gridColor: 'rgba(255,255,255,0.5)', textColor: '#ffffff',
    };
    dom.chartLegend.innerHTML = legendDot('#5bc8ff', 'Chance of precipitation');
  } else if (metric === 'wind') {
    config = {
      type: 'line', labels: cd.labels, nowIndex: 0, yFormat: (v) => Math.round(v),
      series: [{ name: 'Wind', color: '#4cb782', data: cd.wind }, { name: 'Gusts', color: '#e8615c', data: cd.gust }],
      gridColor: 'rgba(255,255,255,0.5)', textColor: '#ffffff',
    };
    dom.chartLegend.innerHTML = legendDot('#4cb782', `Wind (${windUnit})`) + legendDot('#e8615c', 'Gusts');
  } else if (metric === 'humidity') {
    config = {
      type: 'line', labels: cd.labels, nowIndex: 0, yFormat: (v) => Math.round(v) + '%',
      series: [{ name: 'Humidity', color: '#5bc8ff', data: cd.hum }],
      gridColor: 'rgba(255,255,255,0.5)', textColor: '#ffffff',
    };
    dom.chartLegend.innerHTML = legendDot('#5bc8ff', 'Relative humidity');
  } else if (metric === 'uv') {
    config = {
      type: 'bar', labels: cd.labels, nowIndex: 0, yFormat: (v) => Math.round(v),
      series: [{ name: 'UV index', color: '#f0a93c', data: cd.uv }],
      gridColor: 'rgba(255,255,255,0.5)', textColor: '#ffffff',
    };
    dom.chartLegend.innerHTML = legendDot('#f0a93c', 'UV index');
  } else if (metric === 'aqi') {
    const barColors = cd.aqi.map((v) => aqiCategory(v).color);
    config = {
      type: 'bar', labels: cd.labels, nowIndex: 0, yFormat: (v) => Math.round(v),
      series: [{ name: 'US AQI', color: '#9aa4b2', data: cd.aqi.map((v) => (v == null ? 0 : v)), barColors }],
      gridColor: 'rgba(255,255,255,0.5)', textColor: '#ffffff',
    };
    dom.chartLegend.innerHTML = legendDot('#4cb782', 'Good') + legendDot('#f0a93c', 'Moderate') + legendDot('#e8615c', 'Unhealthy');
  }
  state.chartConfig = config;
  Charts.render(dom.chartCanvas, config);
}
function legendDot(color, label) { return `<span><i class="legend-dot" style="background:${color}"></i>${label}</span>`; }

/* ---------------------------------------------------------------------- */
/* Main render                                                            */
/* ---------------------------------------------------------------------- */

function render() {
  const weatherData = state.rawWeather;
  const aqiData = state.rawAqi;
  const cur = weatherData.current;
  const hourly = weatherData.hourly;
  const daily = weatherData.daily;

  const nowIndex = findNowIndex(hourly.time, cur.time);
  const info = weatherCodeInfo(cur.weather_code);
  const isDay = cur.is_day === 1;

  const nowIndexAqi = aqiData && aqiData.hourly ? findNowIndex(aqiData.hourly.time, aqiData.current.time) : 0;
  const sunrise = daily.sunrise && daily.sunrise[0] ? parseLocal(daily.sunrise[0]) : null;
  const sunset = daily.sunset && daily.sunset[0] ? parseLocal(daily.sunset[0]) : null;

  // --- header / location ---
  dom.heroLocation.textContent = state.placeName;
  dom.heroUpdated.textContent = 'Updated ' + parseLocal(cur.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  dom.sunTimes.textContent = `${sunrise ? 'Sunrise ' + sunrise.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Sunrise —'} · ${sunset ? 'Sunset ' + sunset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Sunset —'}`;

  // --- hero temperature ---
  dom.tempValue.textContent = formatTemp(cur.temperature_2m);
  dom.tempUnitLabel.textContent = state.unit === 'F' ? '°F' : '°C';
  dom.conditionLabel.textContent = info.label;
  dom.feelsLike.textContent = `Feels like ${formatTemp(cur.apparent_temperature)}°`;
  dom.hiTemp.textContent = `H: ${formatTemp(daily.temperature_2m_max[0])}°`;
  dom.loTemp.textContent = `L: ${formatTemp(daily.temperature_2m_min[0])}°`;

  // --- chips ---
  const popSlice = hourly.precipitation_probability.slice(nowIndex, Math.min(hourly.time.length, nowIndex + 24));
  const precipSlice = hourly.precipitation.slice(nowIndex, Math.min(hourly.time.length, nowIndex + 24));
  const popNext6 = Math.max(0, ...popSlice.slice(0, Math.min(6, popSlice.length)));
  const popMax24 = Math.max(0, ...popSlice);
  const precipSum24 = precipSlice.reduce((a, b) => a + b, 0);
  const uvNow = hourly.uv_index ? hourly.uv_index[nowIndex] : 0;
  const uvMax = daily.uv_index_max ? daily.uv_index_max[0] : uvNow;
  const visibilityNow = hourly.visibility ? hourly.visibility[nowIndex] : null;
  const aqiUS = aqiData && aqiData.current ? aqiData.current.us_aqi : null;

  dom.chipPrecip.textContent = formatPrecip(cur.precipitation);
  dom.chipPrecipSub.textContent = cur.precipitation > 0 ? 'falling now' : (popNext6 >= 10 ? `${Math.round(popNext6)}% chance later` : 'none expected');

  dom.chipWind.textContent = `${formatWind(cur.wind_speed_10m)} ${windUnitLabel()}`;
  dom.chipWindSub.textContent = degToCompass(cur.wind_direction_10m);
  dom.chipGust.textContent = `${formatWind(cur.wind_gusts_10m)} ${windUnitLabel()}`;
  dom.chipHumidity.textContent = `${Math.round(cur.relative_humidity_2m)}%`;

  const aqiCat = aqiCategory(aqiUS);
  dom.chipAqi.textContent = aqiUS != null ? Math.round(aqiUS) : '—';
  dom.chipAqiSub.textContent = aqiCat.label;
  dom.aqiDot.style.background = aqiCat.color;

  dom.chipUv.textContent = uvNow != null ? Math.round(uvNow) : '—';
  dom.chipUvSub.textContent = uvCategory(uvNow);
  dom.chipPressure.textContent = formatPressure(cur.pressure_msl);
  dom.chipVisibility.textContent = formatVisibility(visibilityNow);
  dom.chipVisibilitySub.textContent = visibilityNote(visibilityNow);

  // --- scene + mascot ---
  document.body.className = `is-${isDay ? 'day' : 'night'} weather-${info.category}`;
  WeatherScene.setScene({
    category: info.category, code: cur.weather_code, isDay,
    windKph: cur.wind_speed_10m, precipMm: cur.precipitation, feelsLike: cur.apparent_temperature,
  });

  // --- hourly strip + charts ---
  renderHourStrip(hourly, nowIndex);
  state.chartData = buildChartDatasets(hourly, nowIndex, aqiData ? aqiData.hourly : null, nowIndexAqi);
  state.activeMetric = 'temp';
  syncChartSelection(state.activeMetric);
  renderChart(state.activeMetric);

  // --- guidance ---
  renderGuidance({
    feelsLike: cur.apparent_temperature, windKph: cur.wind_speed_10m,
    popNext6, popMax24, precipNow: cur.precipitation, precipSum24,
    uvMax, visibilityNow, aqiUS, isDay,
  });

  document.title = `${formatTemp(cur.temperature_2m)}° · ${state.placeName} — Skylark`;
}

/* ---------------------------------------------------------------------- */
/* Search UI                                                              */
/* ---------------------------------------------------------------------- */

function closeResults() { dom.resultsPanel.classList.remove('is-open'); dom.resultsPanel.innerHTML = ''; }

function renderResultsPanel(results, q) {
  if (!results.length) {
    dom.resultsPanel.innerHTML = `<div class="r-empty">No matches for "${q}"</div>`;
    dom.resultsPanel.classList.add('is-open');
    return;
  }
  state.lastResults = results;
  dom.resultsPanel.innerHTML = results.map((r, idx) => `
    <button type="button" data-idx="${idx}" role="option">
      <div class="r-place">${r.name}</div>
      <div class="r-region">${[r.admin1, r.country].filter(Boolean).join(', ')}</div>
    </button>`).join('');
  dom.resultsPanel.classList.add('is-open');
  dom.resultsPanel.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = state.lastResults[Number(btn.dataset.idx)];
      closeResults();
      dom.searchInput.value = '';
      selectResult(r);
    });
  });
}

async function doSuggest(q) {
  try { renderResultsPanel(await geocodeSearch(q), q); } catch (_) { /* silent — suggestions are best-effort */ }
}

/* ---------------------------------------------------------------------- */
/* Install prompt                                                         */
/* ---------------------------------------------------------------------- */

function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function installDismissedRecently() {
  const raw = localStorage.getItem('skylark:installDismissedAt');
  if (!raw) return false;
  return (Date.now() - Number(raw)) < 14 * 24 * 60 * 60 * 1000;
}

function showInstallBanner(mode) {
  if (isStandaloneDisplay() || installDismissedRecently()) return;
  dom.installBanner.classList.add('is-visible');
  if (mode === 'ios') {
    dom.installCopy.textContent = 'Install Skylark: tap Share, then "Add to Home Screen".';
    dom.installBtn.style.display = 'none';
  } else {
    dom.installCopy.textContent = 'Install Skylark for one-tap weather from your home screen.';
    dom.installBtn.style.display = '';
  }
}

function wireInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    showInstallBanner('android');
  });
  dom.installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    dom.installBanner.classList.remove('is-visible');
  });
  dom.installDismiss.addEventListener('click', () => {
    dom.installBanner.classList.remove('is-visible');
    localStorage.setItem('skylark:installDismissedAt', String(Date.now()));
  });
  window.addEventListener('appinstalled', () => { dom.installBanner.classList.remove('is-visible'); });

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (isIOS && !isStandaloneDisplay()) {
    setTimeout(() => showInstallBanner('ios'), 4000);
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Wiring + bootstrap                                                     */
/* ---------------------------------------------------------------------- */

function cacheDom() {
  const byId = (id) => document.getElementById(id);
  dom = {
    stateLoading: byId('state-loading'), stateError: byId('state-error'),
    loadingTitle: byId('loading-title'), errorTitle: byId('error-title'), errorBody: byId('error-body'), errorRetry: byId('error-retry'),
    hero: byId('hero'), hourlySection: byId('hourly-section'), guidanceSection: byId('guidance-section'), appFooter: byId('app-footer'),
    heroLocation: byId('hero-location'), heroUpdated: byId('hero-updated'),
    tempValue: byId('temp-value'), tempUnitLabel: byId('temp-unit-label'), conditionLabel: byId('condition-label'),
    feelsLike: byId('feels-like'), hiTemp: byId('hi-temp'), loTemp: byId('lo-temp'), appVersion: byId('app-version'),
    chipPrecip: byId('chip-precip'), chipPrecipSub: byId('chip-precip-sub'),
    chipWind: byId('chip-wind'), chipWindSub: byId('chip-wind-sub'), chipGust: byId('chip-gust'),
    chipHumidity: byId('chip-humidity'), chipAqi: byId('chip-aqi'), chipAqiSub: byId('chip-aqi-sub'), aqiDot: byId('aqi-dot'),
    chipUv: byId('chip-uv'), chipUvSub: byId('chip-uv-sub'), chipPressure: byId('chip-pressure'),
    chipVisibility: byId('chip-visibility'), chipVisibilitySub: byId('chip-visibility-sub'),
    hourStrip: byId('hour-strip'), chartCanvas: byId('chart-canvas'), chartLegend: byId('chart-legend'), chartTooltip: byId('chart-tooltip'),
    guidanceGrid: byId('guidance-grid'), sunTimes: byId('sun-times'),
    searchForm: byId('search-form'), searchInput: byId('search-input'), resultsPanel: byId('results-panel'),
    locateBtn: byId('locate-btn'), unitC: byId('unit-c'), unitF: byId('unit-f'), scrollCue: byId('scroll-cue'),
    installBanner: byId('install-banner'), installBtn: byId('install-btn'), installDismiss: byId('install-dismiss'), installCopy: byId('install-copy'),
    toast: byId('toast'),
  };
}

function setUnit(u) {
  if (state.unit === u) return;
  state.unit = u;
  try { localStorage.setItem('skylark:unit', u); } catch (_) {}
  dom.unitC.setAttribute('aria-pressed', String(u === 'C'));
  dom.unitF.setAttribute('aria-pressed', String(u === 'F'));
  if (state.rawWeather) render();
}

function wireEvents() {
  dom.searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = dom.searchInput.value.trim();
    if (q.length < 2) return;
    closeResults();
    try {
      const results = await geocodeSearch(q);
      if (!results.length) { toast(`No matches for "${q}"`); return; }
      selectResult(results[0]);
    } catch (_) { toast('Search failed — check your connection.'); }
  });

  dom.searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const q = dom.searchInput.value.trim();
    if (q.length < 2) { closeResults(); return; }
    searchDebounceTimer = setTimeout(() => doSuggest(q), 320);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closeResults();
  });

  dom.locateBtn.addEventListener('click', useMyLocation);
  dom.unitC.addEventListener('click', () => setUnit('C'));
  dom.unitF.addEventListener('click', () => setUnit('F'));

  dom.scrollCue.addEventListener('click', () => {
    dom.hourlySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('.chart-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const metric = btn.dataset.metric;
      syncChartSelection(metric);
      renderChart(metric);
    });
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.chartData) renderChart(state.activeMetric); }, 200);
  });

  dom.chartCanvas.addEventListener('pointermove', showChartTooltip);
  dom.chartCanvas.addEventListener('pointerleave', hideChartTooltip);
  dom.chartCanvas.addEventListener('click', showChartTooltip);
}

function chartValueLabel(metric, value) {
  if (value == null || Number.isNaN(value)) return '—';
  if (metric === 'temp') return `${Math.round(value)}°`;
  if (metric === 'precip') return `${Math.round(value)}%`;
  if (metric === 'wind') return `${Math.round(value)} ${windUnitLabel()}`;
  if (metric === 'humidity') return `${Math.round(value)}%`;
  if (metric === 'uv') return `${Math.round(value)}`;
  if (metric === 'aqi') return `${Math.round(value)}`;
  return `${Math.round(value)}`;
}

function showChartTooltip(event) {
  if (!state.chartData || !state.chartConfig) return;
  const canvas = dom.chartCanvas;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const W = rect.width;
  const padL = 30, padR = 8;
  const innerW = W - padL - padR;
  const n = state.chartData.labels.length;
  const index = Math.max(0, Math.min(n - 1, Math.round(((x - padL) / Math.max(innerW, 1)) * (n - 1))));
  const metric = state.activeMetric || 'temp';
  const value = state.chartConfig.series[0].data[index];
  const time = state.chartData.labels[index];
  const valueText = chartValueLabel(metric, value);

  dom.chartTooltip.innerHTML = `<strong>${valueText}</strong><span>${time}</span>`;
  const left = Math.min(Math.max(x, 28), W - 28);
  dom.chartTooltip.style.left = `${left}px`;
  dom.chartTooltip.style.top = `${Math.max(18, rect.height * 0.38)}px`;
  dom.chartTooltip.classList.add('visible');
}

function hideChartTooltip() {
  dom.chartTooltip.classList.remove('visible');
}

function bootstrapLocation() {
  const params = new URLSearchParams(window.location.search);
  const demoMode = params.get('demo');
  if (demoMode) {
    const preset = DEMO_WEATHER_PRESETS.find((item) => item.id === demoMode) || DEMO_WEATHER_PRESETS[0];
    loadDemoWeatherPreset(preset.id, `Skylark Weather Lab — ${preset.label}`);
    return;
  }

  const saved = loadLastLocation();
  if (saved && typeof saved.lat === 'number' && typeof saved.lon === 'number') {
    loadLocation(saved.lat, saved.lon, saved.label || 'Your location');
    return;
  }
  showNotice({
    title: 'Welcome to Skylark',
    body: 'Search a city above, or allow location access to see your local sky.',
    actionLabel: 'Use my location',
    action: useMyLocation,
  });
}

document.addEventListener('DOMContentLoaded', () => {
  cacheDom();

  const versionMeta = document.querySelector('meta[name="app-version"]');
  if (dom.appVersion) dom.appVersion.textContent = versionMeta ? versionMeta.content : 'dev';

  const savedUnit = (() => { try { return localStorage.getItem('skylark:unit'); } catch (_) { return null; } })();
  if (savedUnit === 'F' || savedUnit === 'C') {
    state.unit = savedUnit;
    dom.unitC.setAttribute('aria-pressed', String(savedUnit === 'C'));
    dom.unitF.setAttribute('aria-pressed', String(savedUnit === 'F'));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.lat != null && state.lon != null && Date.now() - state.lastRefresh >= AUTO_REFRESH_MS) {
      refreshWeatherData();
    }
  });

  wireEvents();
  WeatherScene.init(document.getElementById('scene-canvas'), document.getElementById('sky-a'), document.getElementById('sky-b'));
  registerServiceWorker();
  wireInstallPrompt();
  bootstrapLocation();
});
