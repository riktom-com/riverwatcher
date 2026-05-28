'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  defaultLat:      30.8327,   // Valdosta, GA
  defaultLon:     -83.2785,
  radiusMiles:     25,
  radiusMeters:    40234,
  tideThresholdMi: 100,       // Show tides if NOAA station is within this many miles
  usgsIvUrl:      '/proxy/usgs/iv/',
  noaaStationsUrl: '/proxy/noaa/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english',
  noaaTidesUrl:   '/proxy/noaa/api/prod/datagetter',
  // 00060=discharge(CFS), 00065=gage height(ft), 00010=water temp(°C), 63680=turbidity(FNU)
  paramCodes:     '00060,00065,00010,63680'
};

// ── State ─────────────────────────────────────────────────────────────────────
let map, userMarker, radiusCircle;
let userLat = null, userLon = null;
let stationMarkers = {};
let stationsData   = {};
let sidebarOpen    = true;
let noaaStations   = [];      // NOAA tide stations within range
let noaaMarkers    = [];      // Leaflet markers for NOAA stations
let tideCache      = {};      // noaaStationId -> tide predictions array
let weatherCache   = {};      // "lat,lon" -> NWS forecast periods
let boatRamps      = [];      // Boat ramp features from Overpass
let boatRampMarkers = [];     // Leaflet markers for boat ramps
let showBoatRamps  = true;    // Toggle visibility

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initMap);

function initMap() {
  map = L.map('map', {
    center: [CFG.defaultLat, CFG.defaultLon],
    zoom: 8,
    zoomControl: false
  });

  L.control.zoom({ position: 'topright' }).addTo(map);

  // OpenStreetMap tiles — reliable, no API key needed
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  locateUser();
}

// ── ZIP code search ───────────────────────────────────────────────────────────
async function searchByZip() {
  const input = document.getElementById('zip-input');
  const zip   = input.value.trim();

  if (!/^\d{5}$/.test(zip)) {
    input.classList.add('zip-error');
    setTimeout(() => input.classList.remove('zip-error'), 800);
    return;
  }

  const btn = document.getElementById('zip-btn');
  btn.textContent = '…';
  btn.disabled    = true;

  try {
    const res  = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!res.ok) throw new Error('ZIP not found');
    const data = await res.json();
    const place = data.places[0];
    const lat   = parseFloat(place.latitude);
    const lon   = parseFloat(place.longitude);
    const label = `${place['place name']}, ${place['state abbreviation']}`;

    setStatus(`Showing results for ${label} (${zip})`);
    onLocationFound(lat, lon);
    input.blur();
  } catch (err) {
    input.classList.add('zip-error');
    setTimeout(() => input.classList.remove('zip-error'), 800);
    setStatus('⚠️ ZIP code not found. Please try again.');
  } finally {
    btn.textContent = 'Go';
    btn.disabled    = false;
  }
}

// ── Geolocation ───────────────────────────────────────────────────────────────
function locateUser() {
  setStatus('Finding your location…');
  document.getElementById('locate-btn').textContent = '⏳ Locating…';

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => onLocationFound(pos.coords.latitude, pos.coords.longitude),
      ()  => onLocationFound(CFG.defaultLat, CFG.defaultLon),
      { timeout: 10000, enableHighAccuracy: true }
    );
  } else {
    onLocationFound(CFG.defaultLat, CFG.defaultLon);
  }
}

function onLocationFound(lat, lon) {
  userLat = lat;
  userLon = lon;
  document.getElementById('locate-btn').textContent = '📍 My Location';

  map.setView([lat, lon], 8);

  // Pulsing user marker
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([lat, lon], {
    icon: L.divIcon({
      className: '',
      html: '<div class="user-pulse"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    }),
    zIndexOffset: 1000
  }).addTo(map).bindPopup('<strong>📍 Your Location</strong>');

  // 100-mile dashed radius circle
  if (radiusCircle) map.removeLayer(radiusCircle);
  radiusCircle = L.circle([lat, lon], {
    radius:      CFG.radiusMeters,
    color:       '#4a9eff',
    fillColor:   '#4a9eff',
    fillOpacity: 0.04,
    weight:      1.5,
    dashArray:   '6, 5'
  }).addTo(map);

  map.fitBounds(radiusCircle.getBounds(), { padding: [30, 30] });

  // Fetch USGS river data, NOAA tide stations, and boat ramps in parallel
  fetchUSGSData(lat, lon);
  fetchNOAAStations(lat, lon);
  fetchBoatRamps(lat, lon);
}

// ── Bounding box helper ───────────────────────────────────────────────────────
function getBBox(lat, lon, miles) {
  const latDeg = miles / 69.0;
  const lonDeg = miles / (69.0 * Math.cos(lat * Math.PI / 180));
  return {
    west:  (lon - lonDeg).toFixed(5),
    south: (lat - latDeg).toFixed(5),
    east:  (lon + lonDeg).toFixed(5),
    north: (lat + latDeg).toFixed(5)
  };
}

// ── USGS fetch ────────────────────────────────────────────────────────────────
async function fetchUSGSData(lat, lon) {
  clearMarkers();
  setStatus('⏳ Fetching live river data from USGS…');

  const bb  = getBBox(lat, lon, CFG.radiusMiles);
  const url = `${CFG.usgsIvUrl}?format=json` +
              `&bBox=${bb.west},${bb.south},${bb.east},${bb.north}` +
              `&parameterCd=${CFG.paramCodes}` +
              `&siteStatus=active&siteType=ST`;

  try {
    const res  = await fetch(url);
    if (!res.ok) throw new Error('USGS returned ' + res.status);
    const data = await res.json();
    processData(data, lat, lon);
  } catch (err) {
    console.error('USGS fetch error:', err);
    setStatus('⚠️ Could not load river data. Please try again.');
  }
}

// ── NOAA tide stations fetch ───────────────────────────────────────────────────
async function fetchNOAAStations(userLat, userLon) {
  try {
    const res  = await fetch(CFG.noaaStationsUrl);
    const data = await res.json();

    // Keep only stations within 150 miles (wider net to catch coastal stations
    // that serve nearby rivers even if the gauge is further inland)
    noaaStations = (data.stations || []).filter(s => {
      const dist = haversine(userLat, userLon, parseFloat(s.lat), parseFloat(s.lng));
      return dist <= 150;
    });

    console.log(`NOAA: ${noaaStations.length} tide station(s) within 150 miles`);
    addNOAAMarkers();
  } catch (err) {
    console.warn('Could not load NOAA tide stations:', err);
    noaaStations = [];
  }
}

// ── Plot NOAA tide station markers on the map ──────────────────────────────────
function addNOAAMarkers() {
  // Remove old markers
  noaaMarkers.forEach(m => map.removeLayer(m));
  noaaMarkers = [];

  noaaStations
    .filter(s => haversine(userLat, userLon, parseFloat(s.lat), parseFloat(s.lng)) <= CFG.radiusMiles)
    .forEach(s => {
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lng);

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="noaa-marker">🌊</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      }),
      zIndexOffset: 500
    }).addTo(map);

    marker.bindTooltip(`<strong>🌊 ${s.name}</strong><br>NOAA Tide Station`, {
      sticky: true, direction: 'top', offset: [0, -10]
    });

    marker.on('click', () => showNOAADetail(s));
    noaaMarkers.push(marker);
  });
}

// ── Show tide detail for a NOAA station ───────────────────────────────────────
function showNOAADetail(s) {
  const noaaInfo = { station: s, distMiles: 0 };

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-station-name">🌊 ${s.name}</div>
    <div class="detail-meta">
      <span>NOAA Tide Station #${s.id}</span>
    </div>
    <div id="tide-placeholder" class="tide-section tide-loading">⏳ Loading tide data…</div>
    <div class="detail-actions">
      <a href="https://tidesandcurrents.noaa.gov/stationhome.html/${s.id}"
         target="_blank" rel="noopener" class="btn-usgs">
        📊 Full Tide Charts on NOAA ↗
      </a>
    </div>
  `;

  document.getElementById('detail-panel').classList.add('open');

  fetchTides(s.id).then(predictions => {
    const placeholder = document.getElementById('tide-placeholder');
    if (placeholder) {
      placeholder.outerHTML = renderTidesHTML(predictions, noaaInfo);
    }
  });
}

// ── Find nearest NOAA station to a USGS gauge ─────────────────────────────────
function findNearestNOAAStation(lat, lon) {
  let nearest = null;
  let minDist = Infinity;

  noaaStations.forEach(s => {
    const dist = haversine(lat, lon, parseFloat(s.lat), parseFloat(s.lng));
    if (dist < minDist) {
      minDist = dist;
      nearest = s;
    }
  });

  if (nearest && minDist <= CFG.tideThresholdMi) {
    return { station: nearest, distMiles: minDist };
  }
  return null;
}

// ── Fetch today's high/low tides from NOAA ────────────────────────────────────
async function fetchTides(stationId) {
  if (tideCache[stationId]) return tideCache[stationId];

  const today    = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

  const url = `${CFG.noaaTidesUrl}?product=predictions&application=RiverWatch` +
              `&begin_date=${fmt(today)}&end_date=${fmt(tomorrow)}` +
              `&datum=MLLW&station=${stationId}&time_zone=lst_ldt` +
              `&interval=hilo&units=english&format=json`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    const predictions = data.predictions || [];
    tideCache[stationId] = predictions;
    return predictions;
  } catch (err) {
    console.warn('Tide fetch error:', err);
    return [];
  }
}

// ── Render tide HTML ──────────────────────────────────────────────────────────
function renderTidesHTML(predictions, noaaInfo) {
  if (!predictions.length) {
    return `<div class="tide-section"><p class="tide-unavailable">Tide data unavailable for this station.</p></div>`;
  }

  const now     = new Date();
  // Find the next upcoming tide and the current tide state
  const upcoming = predictions.find(p => new Date(p.t) > now);
  const previous = [...predictions].reverse().find(p => new Date(p.t) <= now);

  let tideState = '';
  if (previous && upcoming) {
    tideState = (upcoming.type === 'H')
      ? '🌊 Tide is coming IN (flood) — baitfish moving shallow, prime feeding time'
      : '⬇️ Tide is going OUT (ebb) — fish concentrate at cuts & channel edges';
  }

  // Show today's remaining tides + next few from tomorrow
  const todayStr  = now.toLocaleDateString([], { month: 'short', day: 'numeric' });

  const rows = predictions.slice(0, 8).map(p => {
    const t        = new Date(p.t);
    const isNext   = upcoming && p.t === upcoming.t;
    const isPast   = t <= now;
    const typeLabel = p.type === 'H' ? '▲ High' : '▼ Low';
    const typeColor = p.type === 'H' ? '#4a9eff' : '#7a98be';
    const timeStr   = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr   = t.toLocaleDateString([], { month: 'short', day: 'numeric' });

    return `
      <div class="tide-row ${isNext ? 'tide-next' : ''} ${isPast ? 'tide-past' : ''}">
        <span class="tide-type" style="color:${typeColor}">${typeLabel}</span>
        <span class="tide-time">${dateStr !== todayStr ? dateStr + ' ' : ''}${timeStr}</span>
        <span class="tide-height">${parseFloat(p.v).toFixed(1)} ft</span>
        ${isNext ? '<span class="tide-next-badge">NEXT</span>' : ''}
      </div>`;
  }).join('');

  return `
    <div class="tide-section">
      <h3>🌊 Tides — ${noaaInfo.station.name} <span class="tide-dist">(${noaaInfo.distMiles.toFixed(0)} mi away)</span></h3>
      ${tideState ? `<div class="tide-state">${tideState}</div>` : ''}
      <div class="tide-table">${rows}</div>
      <a href="https://tidesandcurrents.noaa.gov/stationhome.html/${noaaInfo.station.id}"
         target="_blank" rel="noopener" class="tide-link">View full tide chart on NOAA ↗</a>
    </div>`;
}

// ── Data processing ───────────────────────────────────────────────────────────
function processData(data, userLat, userLon) {
  stationsData = {};
  const timeSeries = data?.value?.timeSeries || [];

  timeSeries.forEach(ts => {
    const siteNo   = ts.sourceInfo.siteCode[0].value;
    const siteName = ts.sourceInfo.siteName.replace(/\s+/g, ' ').trim();
    const lat      = parseFloat(ts.sourceInfo.geoLocation.geogLocation.latitude);
    const lon      = parseFloat(ts.sourceInfo.geoLocation.geogLocation.longitude);
    const varCode  = ts.variable.variableCode[0].value;
    const unit     = ts.variable.unit.unitCode;

    // Latest non-null value
    const allVals  = ts.values[0]?.value || [];
    const latest   = allVals.find(v => v.value !== null && v.value !== '' && v.value !== '-999999' && !isNaN(parseFloat(v.value)));
    const value    = latest ? parseFloat(latest.value) : null;
    const dateTime = latest?.dateTime || null;

    if (!stationsData[siteNo]) {
      stationsData[siteNo] = {
        siteNo, siteName, lat, lon,
        distance: haversine(userLat, userLon, lat, lon),
        parameters: {}
      };
    }
    stationsData[siteNo].parameters[varCode] = { value, unit, dateTime };
  });

  const list = Object.values(stationsData)
    .filter(s => s.distance <= CFG.radiusMiles)
    .sort((a, b) => a.distance - b.distance);

  list.forEach(addStationMarker);
  renderSidebarList(list);

  const n = list.length;
  setStatus(`${n} active gauging station${n !== 1 ? 's' : ''} within ${CFG.radiusMiles} miles`);
  document.getElementById('station-count').textContent = `${n} stations`;
}

// ── Distance (Haversine) ──────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Fishing conditions assessment ─────────────────────────────────────────────
function assessConditions(station) {
  const p     = station.parameters;
  const cfs   = p['00060']?.value;
  const tempC = p['00010']?.value;
  const turb  = p['63680']?.value;

  let score = 0, maxScore = 0;
  const tips = [];

  // Water temperature (°C → °F)
  if (tempC !== null && tempC !== undefined) {
    maxScore += 2;
    const tempF = tempC * 9 / 5 + 32;
    if (tempF >= 58 && tempF <= 75) {
      score += 2;
      tips.push(`✅ Water temp ${tempF.toFixed(0)}°F — ideal for bass, bream & catfish`);
    } else if (tempF >= 45 && tempF <= 85) {
      score += 1;
      tips.push(`⚠️ Water temp ${tempF.toFixed(0)}°F — acceptable but not peak`);
    } else {
      tips.push(`❌ Water temp ${tempF.toFixed(0)}°F — too ${tempF < 45 ? 'cold' : 'warm'} for most species`);
    }
  }

  // Flow rate (CFS)
  if (cfs !== null && cfs !== undefined) {
    maxScore += 2;
    if (cfs < 300) {
      score += 2;
      tips.push('✅ Low flow — great for wading & bank fishing');
    } else if (cfs < 2000) {
      score += 1;
      tips.push('⚠️ Moderate flow — boat or kayak recommended');
    } else {
      tips.push('❌ High flow — river is up, use extreme caution');
    }
  }

  // Turbidity
  if (turb !== null && turb !== undefined) {
    maxScore += 1;
    if (turb < 12) {
      score += 1;
      tips.push('✅ Clear water — good light penetration for visual feeders');
    } else if (turb < 50) {
      tips.push('⚠️ Slightly stained — try bright or scented lures');
    } else {
      tips.push('❌ Muddy / turbid — very low visibility, target structure tightly');
    }
  }

  if (!tips.length) {
    tips.push('ℹ️ Insufficient sensor data to fully assess conditions');
  }

  const ratio = maxScore > 0 ? score / maxScore : -1;

  if (ratio < 0)    return { rating: 'unknown', label: 'Unknown',    color: '#6b7280', tips };
  if (ratio >= 0.7) return { rating: 'good',    label: 'Good',       color: '#22c55e', tips };
  if (ratio >= 0.4) return { rating: 'fair',    label: 'Fair',       color: '#f59e0b', tips };
  return                   { rating: 'poor',    label: 'High Water', color: '#ef4444', tips };
}

// ── Map markers ───────────────────────────────────────────────────────────────
function addStationMarker(station) {
  const cond = assessConditions(station);
  const p    = station.parameters;
  const gage = p['00065']?.value;
  const cfs  = p['00060']?.value;

  const marker = L.circleMarker([station.lat, station.lon], {
    radius:      9,
    fillColor:   cond.color,
    color:       'rgba(255,255,255,0.7)',
    weight:      2,
    opacity:     1,
    fillOpacity: 0.88
  }).addTo(map);

  const tipLines = [];
  if (gage !== null && gage !== undefined) tipLines.push(`📏 ${gage} ft`);
  if (cfs  !== null && cfs  !== undefined) tipLines.push(`💧 ${Number(cfs).toLocaleString()} CFS`);

  marker.bindTooltip(
    `<strong>${station.siteName}</strong>` +
    (tipLines.length ? `<br>${tipLines.join('  ')}` : ''),
    { sticky: true, direction: 'top', offset: [0, -10] }
  );

  marker.on('click', () => {
    map.setView([station.lat, station.lon], 12, { animate: true });
    showDetail(station);
  });

  stationMarkers[station.siteNo] = marker;
}

// ── NWS Weather fetch ─────────────────────────────────────────────────────────
async function fetchWeather(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (weatherCache[key]) return weatherCache[key];

  try {
    // Step 1: resolve lat/lon to NWS grid
    const ptRes  = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
                               { headers: { 'User-Agent': 'RiverWatch/1.0 ricky@browningpc.com' } });
    if (!ptRes.ok) throw new Error('NWS points error');
    const ptData = await ptRes.json();

    // Step 2: fetch the weekly forecast
    const fcRes  = await fetch(ptData.properties.forecast,
                               { headers: { 'User-Agent': 'RiverWatch/1.0 ricky@browningpc.com' } });
    if (!fcRes.ok) throw new Error('NWS forecast error');
    const fcData = await fcRes.json();

    const periods = fcData.properties.periods || [];
    weatherCache[key] = periods;
    return periods;
  } catch (err) {
    console.warn('Weather fetch error:', err);
    return null;
  }
}

function getWeatherEmoji(forecast) {
  const f = (forecast || '').toLowerCase();
  if (f.includes('thunder'))                          return '⛈️';
  if (f.includes('snow') || f.includes('blizzard'))  return '❄️';
  if (f.includes('sleet') || f.includes('ice'))      return '🌨️';
  if (f.includes('rain') || f.includes('shower'))    return '🌧️';
  if (f.includes('drizzle'))                         return '🌦️';
  if (f.includes('fog') || f.includes('haze'))       return '🌫️';
  if (f.includes('mostly sunny') || f.includes('mostly clear')) return '🌤️';
  if (f.includes('partly'))                          return '⛅';
  if (f.includes('sunny') || f.includes('clear'))   return '☀️';
  if (f.includes('cloud') || f.includes('overcast')) return '☁️';
  if (f.includes('wind'))                            return '🌬️';
  return '🌡️';
}

function getFishingWeatherTip(day, night) {
  const rain  = day.probabilityOfPrecipitation?.value ?? 0;
  const tempF = day.temperature;
  const wind  = parseInt(day.windSpeed) || 0;
  const tips  = [];

  if (rain >= 70)       tips.push('Heavy rain likely — rivers may rise & muddy');
  else if (rain >= 40)  tips.push('Rain possible — good pre-front fishing');
  else if (rain < 20)   tips.push('Dry conditions — stable water');

  if (tempF >= 85)      tips.push('Hot day — fish deeper or fish early/late');
  else if (tempF <= 45) tips.push('Cold front — fish sluggish, slow your retrieve');
  else                  tips.push('Comfortable temps for fish activity');

  if (wind >= 20)       tips.push('Strong winds — tough surface fishing');
  else if (wind <= 8)   tips.push('Calm winds — great topwater conditions');

  return tips;
}

function renderWeatherHTML(periods, stationName) {
  if (!periods || !periods.length) {
    return `<div class="weather-section">
      <h3>📅 7-Day Weather Forecast</h3>
      <p class="weather-unavailable">Weather data unavailable for this location.</p>
    </div>`;
  }

  // Pair daytime + nighttime periods into days
  const days = [];
  let i = 0;
  // If first period is nighttime, skip it
  if (!periods[0].isDaytime) i = 1;
  while (i < periods.length && days.length < 7) {
    const day   = periods[i];
    const night = periods[i + 1] || null;
    days.push({ day, night });
    i += 2;
  }

  const rows = days.map(({ day, night }) => {
    const emoji    = getWeatherEmoji(day.shortForecast);
    const rain     = day.probabilityOfPrecipitation?.value ?? null;
    const nightRain = night?.probabilityOfPrecipitation?.value ?? null;
    const maxRain  = Math.max(rain ?? 0, nightRain ?? 0);
    const windNum  = parseInt(day.windSpeed) || 0;
    const tips     = getFishingWeatherTip(day, night);

    // Short day name
    const dayName  = day.name.replace('This ', '').replace('day', 'day');

    return `
      <div class="weather-row">
        <div class="weather-day-col">
          <div class="weather-dayname">${dayName}</div>
        </div>
        <div class="weather-icon-col">${emoji}</div>
        <div class="weather-temp-col">
          <span class="weather-high">${day.temperature}°F</span>
          ${night ? `<span class="weather-low">/ ${night.temperature}°F</span>` : ''}
        </div>
        <div class="weather-detail-col">
          <div class="weather-desc">${day.shortForecast}</div>
          <div class="weather-sub">
            💨 ${day.windSpeed} ${day.windDirection}
            ${maxRain !== null ? `&nbsp;·&nbsp; 🌧️ ${maxRain}%` : ''}
          </div>
        </div>
        <div class="weather-tips-col">
          ${tips.map(t => `<div class="weather-tip">${t}</div>`).join('')}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="weather-section">
      <h3>📅 7-Day Weather Forecast</h3>
      <div class="weather-table">${rows}</div>
      <a href="https://forecast.weather.gov" target="_blank" rel="noopener" class="tide-link">National Weather Service ↗</a>
    </div>`;
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function showDetail(station) {
  const p    = station.parameters;
  const cond = assessConditions(station);
  const gage = p['00065'];
  const cfs  = p['00060'];
  const temp = p['00010'];
  const turb = p['63680'];

  const tempF       = (temp?.value !== null && temp?.value !== undefined)
    ? (temp.value * 9 / 5 + 32).toFixed(1) : null;
  const lastUpdated = gage?.dateTime || cfs?.dateTime || temp?.dateTime;
  const emoji       = cond.rating === 'good' ? '🟢' : cond.rating === 'fair' ? '🟡' : cond.rating === 'poor' ? '🔴' : '⚫';

  // Check for nearby NOAA tide station
  const noaaInfo = findNearestNOAAStation(station.lat, station.lon);

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-station-name">${station.siteName}</div>
    <div class="detail-meta">
      <span>📍 ${station.distance.toFixed(1)} miles away</span>
      ${lastUpdated ? `<span>🕐 Updated ${formatTime(lastUpdated)}</span>` : ''}
    </div>

    <div class="conditions-badge" style="background:${cond.color}22; border-color:${cond.color}; color:${cond.color}">
      ${emoji} ${cond.label} Fishing Conditions
    </div>

    <div class="detail-stats">
      ${(gage?.value !== null && gage?.value !== undefined) ? `
      <div class="stat-card">
        <div class="stat-icon">📏</div>
        <div class="stat-label">Gage Height</div>
        <div class="stat-value">${gage.value}<span class="stat-unit"> ft</span></div>
      </div>` : ''}

      ${(cfs?.value !== null && cfs?.value !== undefined) ? `
      <div class="stat-card">
        <div class="stat-icon">💧</div>
        <div class="stat-label">Flow Rate</div>
        <div class="stat-value">${Number(cfs.value).toLocaleString()}<span class="stat-unit"> CFS</span></div>
      </div>` : ''}

      ${tempF ? `
      <div class="stat-card">
        <div class="stat-icon">🌡️</div>
        <div class="stat-label">Water Temp</div>
        <div class="stat-value">${tempF}<span class="stat-unit">°F</span></div>
      </div>` : ''}

      ${(turb?.value !== null && turb?.value !== undefined) ? `
      <div class="stat-card">
        <div class="stat-icon">🌊</div>
        <div class="stat-label">Turbidity</div>
        <div class="stat-value">${turb.value}<span class="stat-unit"> FNU</span></div>
      </div>` : ''}
    </div>

    <div class="fishing-assessment">
      <h3>🎣 Fishing Assessment</h3>
      <ul>${cond.tips.map(t => `<li>${t}</li>`).join('')}</ul>
    </div>

    ${noaaInfo ? `<div id="tide-placeholder" class="tide-section tide-loading">⏳ Loading tide data…</div>` : ''}

    <div id="weather-placeholder" class="weather-section weather-loading">⏳ Loading weather forecast…</div>

    <div class="detail-actions">
      <a href="https://waterdata.usgs.gov/monitoring-location/${station.siteNo}/"
         target="_blank" rel="noopener" class="btn-usgs">
        📊 Full Charts &amp; History on USGS ↗
      </a>
    </div>
  `;

  document.getElementById('detail-panel').classList.add('open');

  // Async load tide data if a nearby NOAA station exists
  if (noaaInfo) {
    fetchTides(noaaInfo.station.id).then(predictions => {
      const placeholder = document.getElementById('tide-placeholder');
      if (placeholder) placeholder.outerHTML = renderTidesHTML(predictions, noaaInfo);
    });
  }

  // Async load 7-day weather forecast
  fetchWeather(station.lat, station.lon).then(periods => {
    const placeholder = document.getElementById('weather-placeholder');
    if (placeholder) placeholder.outerHTML = renderWeatherHTML(periods, station.siteName);
  });
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
}

// ── Sidebar list ──────────────────────────────────────────────────────────────
function renderSidebarList(stations) {
  const el = document.getElementById('station-list');

  if (!stations.length) {
    el.innerHTML = `<p class="no-stations">No active stream gauges found within ${CFG.radiusMiles} miles of your location.</p>`;
    return;
  }

  el.innerHTML = stations.map(s => {
    const cond     = assessConditions(s);
    const gage     = s.parameters['00065']?.value;
    const cfs      = s.parameters['00060']?.value;
    const readings = [];
    if (gage !== null && gage !== undefined) readings.push(`📏 ${gage} ft`);
    if (cfs  !== null && cfs  !== undefined) readings.push(`💧 ${Number(cfs).toLocaleString()} CFS`);

    return `
      <div class="station-item" onclick="focusStation('${s.siteNo}')">
        <div class="station-dot" style="background:${cond.color}"></div>
        <div class="station-info">
          <div class="station-name">${s.siteName}</div>
          <div class="station-readings">
            ${readings.join('  ')}
            <span class="station-dist">${s.distance.toFixed(1)} mi</span>
          </div>
        </div>
        <div class="station-cond" style="color:${cond.color}">${cond.label}</div>
      </div>`;
  }).join('');
}

function focusStation(siteNo) {
  const s = stationsData[siteNo];
  if (!s) return;
  map.setView([s.lat, s.lon], 13, { animate: true });
  showDetail(s);
  if (window.innerWidth < 768) closeSidebar();
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  document.getElementById('sidebar').classList.toggle('closed', !sidebarOpen);
  document.getElementById('sidebar-open-btn').style.display = sidebarOpen ? 'none' : 'flex';
  setTimeout(() => map.invalidateSize(), 320);
}

function closeSidebar() {
  sidebarOpen = false;
  document.getElementById('sidebar').classList.add('closed');
  document.getElementById('sidebar-open-btn').style.display = 'flex';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clearMarkers() {
  Object.values(stationMarkers).forEach(m => map.removeLayer(m));
  stationMarkers = {};
}

function setStatus(msg) {
  document.getElementById('status-text').textContent = msg;
}

function formatTime(dt) {
  try {
    return new Date(dt).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return ''; }
}

// ── Boat Ramps (OpenStreetMap Overpass API) ───────────────────────────────────
async function fetchBoatRamps(lat, lon) {
  // Clear old markers
  boatRampMarkers.forEach(m => map.removeLayer(m));
  boatRampMarkers = [];
  boatRamps = [];
  renderBoatRampSidebar([]);

  const bb = getBBox(lat, lon, CFG.radiusMiles);
  const query = `
    [out:json][timeout:15];
    (
      node["leisure"="slipway"](${bb.south},${bb.west},${bb.north},${bb.east});
      node["amenity"="boat_ramp"](${bb.south},${bb.west},${bb.north},${bb.east});
      way["leisure"="slipway"](${bb.south},${bb.west},${bb.north},${bb.east});
      way["amenity"="boat_ramp"](${bb.south},${bb.west},${bb.north},${bb.east});
    );
    out center tags;
  `;

  try {
    const res  = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: query
    });
    if (!res.ok) throw new Error('Overpass error ' + res.status);
    const data = await res.json();

    boatRamps = (data.elements || []).map(el => {
      const rampLat = el.lat ?? el.center?.lat;
      const rampLon = el.lon ?? el.center?.lon;
      if (!rampLat || !rampLon) return null;
      const tags = el.tags || {};
      const name = tags.name || tags['name:en'] || 'Unnamed Boat Ramp';
      const dist = haversine(lat, lon, rampLat, rampLon);
      return { name, lat: rampLat, lon: rampLon, dist, tags };
    }).filter(Boolean).sort((a, b) => a.dist - b.dist);

    if (showBoatRamps) addBoatRampMarkers();
    renderBoatRampSidebar(boatRamps);
  } catch (err) {
    console.warn('Boat ramp fetch error:', err);
    renderBoatRampSidebar([]);
  }
}

function assessRampAccess(rampLat, rampLon) {
  // Find nearest USGS station within 15 miles
  let nearest = null, minDist = Infinity;
  Object.values(stationsData).forEach(s => {
    const d = haversine(rampLat, rampLon, s.lat, s.lon);
    if (d < minDist) { minDist = d; nearest = s; }
  });

  if (!nearest || minDist > 15) {
    return { color: '#6b7280', icon: 'ℹ️', label: 'No gauge nearby', tip: 'Verify conditions before launching' };
  }

  const cfs  = nearest.parameters['00060']?.value;
  const gage = nearest.parameters['00065']?.value;

  if (cfs === null || cfs === undefined) {
    return { color: '#6b7280', icon: 'ℹ️', label: 'No flow data', tip: `Nearest gauge: ${nearest.siteName.split(' AT ')[0]}` };
  }

  const gageNote = gage !== null && gage !== undefined ? ` · ${gage} ft gage` : '';
  if (cfs > 3000) {
    return { color: '#ef4444', icon: '🚫', label: 'Likely Flooded', tip: `${Number(cfs).toLocaleString()} CFS${gageNote} — ramp may be under water` };
  }
  if (cfs > 1000) {
    return { color: '#f59e0b', icon: '⚠️', label: 'Use Caution', tip: `${Number(cfs).toLocaleString()} CFS${gageNote} — swift current, use caution` };
  }
  return { color: '#22c55e', icon: '✅', label: 'Good Access', tip: `${Number(cfs).toLocaleString()} CFS${gageNote} — conditions look good` };
}

function addBoatRampMarkers() {
  boatRampMarkers.forEach(m => map.removeLayer(m));
  boatRampMarkers = [];

  boatRamps.forEach(ramp => {
    const access = assessRampAccess(ramp.lat, ramp.lon);
    const el = document.createElement('div');
    el.className = 'boat-ramp-marker';
    el.innerHTML = '⚓';
    el.style.cssText = `
      font-size:18px; line-height:1; cursor:pointer;
      text-shadow: 0 1px 3px rgba(0,0,0,0.6);
      filter: drop-shadow(0 0 3px ${access.color});
    `;

    const marker = L.marker([ramp.lat, ramp.lon], {
      icon: L.divIcon({
        className: '',
        html: el.outerHTML,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      }),
      zIndexOffset: 600
    }).addTo(map);

    marker.bindTooltip(
      `<strong>⚓ ${ramp.name}</strong><br>${access.icon} ${access.label}<br><small>${ramp.dist.toFixed(1)} mi away</small>`,
      { sticky: true, direction: 'top', offset: [0, -10] }
    );

    marker.on('click', () => showRampDetail(ramp));
    boatRampMarkers.push(marker);
  });
}

function showRampDetail(ramp) {
  const access = assessRampAccess(ramp.lat, ramp.lon);
  const tags   = ramp.tags || {};
  const surface   = tags.surface   ? `<div class="ramp-tag">🛣️ Surface: ${tags.surface}</div>` : '';
  const fee       = tags.fee       ? `<div class="ramp-tag">💰 Fee: ${tags.fee}</div>` : '';
  const access_tag = tags.access   ? `<div class="ramp-tag">🔒 Access: ${tags.access}</div>` : '';
  const operator  = tags.operator  ? `<div class="ramp-tag">🏛️ Operator: ${tags.operator}</div>` : '';
  const mapsUrl   = `https://www.google.com/maps/dir/?api=1&destination=${ramp.lat},${ramp.lon}`;

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-station-name">⚓ ${ramp.name}</div>
    <div class="detail-meta">
      <span>📍 ${ramp.dist.toFixed(1)} miles away</span>
    </div>

    <div class="conditions-badge" style="background:${access.color}22; border-color:${access.color}; color:${access.color}">
      ${access.icon} ${access.label}
    </div>
    <p style="margin:8px 0 12px; font-size:13px; color:var(--text-secondary, #9ca3af);">${access.tip}</p>

    <div class="ramp-tags">
      ${surface}${fee}${access_tag}${operator}
    </div>

    <div class="detail-actions" style="margin-top:12px">
      <a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-usgs">
        🗺️ Get Directions ↗
      </a>
    </div>
  `;

  document.getElementById('detail-panel').classList.add('open');
}

function renderBoatRampSidebar(ramps) {
  const el = document.getElementById('ramp-list');
  if (!el) return;

  const count = document.getElementById('ramp-count');
  if (count) count.textContent = ramps.length ? `${ramps.length} found` : '';

  if (!ramps.length) {
    el.innerHTML = `<p class="no-stations" style="padding:8px 12px;font-size:12px;">No boat ramps found within ${CFG.radiusMiles} miles.</p>`;
    return;
  }

  el.innerHTML = ramps.map(ramp => {
    const access = assessRampAccess(ramp.lat, ramp.lon);
    return `
      <div class="station-item" onclick="focusRamp(${ramp.lat}, ${ramp.lon})">
        <div class="station-dot" style="background:${access.color}">⚓</div>
        <div class="station-info">
          <div class="station-name">${ramp.name}</div>
          <div class="station-readings">
            <span class="station-dist">${ramp.dist.toFixed(1)} mi</span>
            &nbsp;·&nbsp; ${access.icon} ${access.label}
          </div>
        </div>
      </div>`;
  }).join('');
}

function focusRamp(lat, lon) {
  const ramp = boatRamps.find(r => r.lat === lat && r.lon === lon);
  if (!ramp) return;
  map.setView([lat, lon], 14, { animate: true });
  showRampDetail(ramp);
  if (window.innerWidth < 768) closeSidebar();
}

function toggleRampSection() {
  const section  = document.getElementById('ramp-section');
  const chevron  = document.getElementById('ramp-chevron');
  const isHidden = section.classList.toggle('collapsed');
  if (chevron) chevron.textContent = isHidden ? '▶' : '▼';
}

function toggleBoatRamps() {
  showBoatRamps = !showBoatRamps;
  const btn = document.getElementById('ramp-toggle-btn');
  if (showBoatRamps) {
    addBoatRampMarkers();
    if (btn) { btn.textContent = '⚓ Hide Ramps'; btn.classList.add('active'); }
  } else {
    boatRampMarkers.forEach(m => map.removeLayer(m));
    boatRampMarkers = [];
    if (btn) { btn.textContent = '⚓ Show Ramps'; btn.classList.remove('active'); }
  }
}

// ── Radius selector ──────────────────────────────────────────────────────────
function onRadiusChange() {
  const miles = parseInt(document.getElementById('radius-input').value, 10);
  CFG.radiusMiles  = miles;
  CFG.radiusMeters = Math.round(miles * 1609.34);
  if (userLat !== null) {
    if (radiusCircle) map.removeLayer(radiusCircle);
    radiusCircle = L.circle([userLat, userLon], {
      radius:      CFG.radiusMeters,
      color:       '#4a9eff',
      fillColor:   '#4a9eff',
      fillOpacity: 0.04,
      weight:      1.5,
      dashArray:   '6, 5'
    }).addTo(map);
    map.fitBounds(radiusCircle.getBounds(), { padding: [30, 30] });
    fetchUSGSData(userLat, userLon);
    fetchNOAAStations(userLat, userLon);
    fetchBoatRamps(userLat, userLon);
  }
}
