// app.js
// Bike Sensor Data Visualization

import { CONFIG } from './config.js';

console.log('🚀 Starting bike visualization...');

const map = new mapboxgl.Map({
  container: 'map',
  style: CONFIG.MAP_STYLE,
  center: CONFIG.MAP_CENTER,
  zoom: CONFIG.MAP_ZOOM
});

window.map = map;

// ─── State ────────────────────────────────────────────────────────────────────
let tripIds = [];
let speedMode = 'gradient';
let showSpeedColors = false;
let showRoadQuality = false;
let selectedTrip = null;
let currentPopup = null;
let showAveragedSegments = false;
let averagedSegmentMode = 'composite';
let activeFilter = null;
let showBraking = false;
let tripDates = {};        // trip_id -> 'YYYY-MM-DD'
let selectedSensorFilters = new Set();
let selectedDateFrom = '';
let selectedDateTo   = '';

// ─── Sensor colours ───────────────────────────────────────────────────────────
const SENSOR_COLORS = [
  '#34CCCC','#FFCC33','#5B8FFF','#CC5BAA','#33CCAA',
  '#FF7A3D','#88DDFF','#FFE066','#CC3355','#66FF99',
  '#AA88FF','#FF9966','#00CCFF','#FFB3DE','#44FFDD',
  '#FFAA00','#7BFFB3','#FF6680','#B3EEFF','#D4FF66',
];
const DEFAULT_COLOR = '#34CCCC';
const sensorColorMap = {};

function buildSensorColorMap(ids) {
  const sensors = [...new Set(ids.map(id => id.split('_')[0]))].sort();
  sensors.forEach((s, i) => { sensorColorMap[s] = SENSOR_COLORS[i % SENSOR_COLORS.length]; });
  console.log('🎨 Sensor colour map:', sensorColorMap);
}

function getSensorColor(tripId) {
  const sensor = tripId.split('_')[0];
  return sensorColorMap[sensor] || DEFAULT_COLOR;
}

function getFirstLabelLayerId() {
  const layers = map.getStyle().layers;
  for (const layer of layers) {
    if (layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

// ─── Colour expressions ───────────────────────────────────────────────────────
function getSpeedColorExpression(mode) {
  const v = ['to-number', ['coalesce', ['get', 'Speed'], ['get', 'speed'], 0]];
  if (mode === 'gradient') {
    return ['interpolate', ['linear'], v, 0,'#808080', 2,'#DC2626', 5,'#F97316', 10,'#FACC15', 15,'#22C55E', 20,'#3B82F6', 25,'#bb06d7'];
  }
  return ['step', v, '#808080', 2,'#DC2626', 5,'#F97316', 10,'#FACC15', 15,'#22C55E', 20,'#3B82F6', 25,'#bb06d7'];
}

function getRoadQualityColorExpression() {
  return ['match', ['get', 'road_quality'], 1,'#22C55E', 2,'#84CC16', 3,'#FACC15', 4,'#F97316', 5,'#DC2626', '#808080'];
}

function getSensorColorExpression() {
  const fallback = DEFAULT_COLOR;
  const pairs = tripIds.flatMap(id => [id, getSensorColor(id)]);
  if (pairs.length === 0) return fallback;
  return ['match', ['get', 'trip_id'], ...pairs, fallback];
}

function getAveragedSpeedColorExpression() {
  return ['interpolate', ['linear'], ['get', 'avg_speed'], 0,'#DC2626', 5,'#F97316', 10,'#FACC15', 15,'#22C55E', 20,'#3B82F6', 25,'#bb06d7'];
}
function getAveragedQualityColorExpression() {
  return ['interpolate', ['linear'], ['get', 'avg_quality'], 1,'#22C55E', 2,'#84CC16', 3,'#FACC15', 4,'#F97316', 5,'#DC2626'];
}
function getCompositeScoreColorExpression() {
  return ['interpolate', ['linear'], ['get', 'composite_score'], 0,'#22C55E', 25,'#84CC16', 50,'#FACC15', 75,'#F97316', 100,'#DC2626'];
}

function getQualityLabel(q) {
  if (q <= 1.5) return 'Perfect';
  if (q <= 2.5) return 'Normal';
  if (q <= 3.5) return 'Outdated';
  if (q <= 4.5) return 'Bad';
  return 'No road';
}
function getCompositeLabel(s) {
  if (s < 20) return 'Excellent';
  if (s < 40) return 'Good';
  if (s < 60) return 'Moderate';
  if (s < 80) return 'Poor';
  return 'Critical';
}

// ─── Hotspot colour (concentration only) ─────────────────────────────────────
function getHotspotColorExpression() {
  return [
    'interpolate', ['linear'],
    ['to-number', ['get', 'count']],
    1,  '#FFF176',
    3,  '#FF9800',
    8,  '#D32F2F',
    20, '#9C27B0',
  ];
}

// ─── Braking filter helpers ───────────────────────────────────────────────────
// When a trip (or sensor's set of trips) is selected while braking is active,
// filter hotspots down to just those trips AND grid them at finer resolution —
// cheap once we're only gridding a handful of trips instead of the whole
// dataset, and it gets rid of the patchy/blocky look on an isolated trip.
// When deselected, restore the full dataset at the coarser (RAM-friendly) grid.
function applyBrakingTripFilter(tripIdOrIds) {
  if (!map.getSource('braking-hotspots')) return;

  const source = map.getSource('trips');
  const allFeatures = source?._data?.features || [];

  if (tripIdOrIds) {
    const ids = new Set(Array.isArray(tripIdOrIds) ? tripIdOrIds : [tripIdOrIds]);
    const tripFeatures = allFeatures.filter(f => ids.has(f.properties.trip_id));
    const filtered = buildBrakingHotspots(tripFeatures, BRAKING_CELL_SIZE_ISOLATED);
    map.getSource('braking-hotspots').setData(filtered);
  } else {
    // Restore all hotspots at the coarser full-dataset grid
    const all = buildBrakingHotspots(allFeatures, BRAKING_CELL_SIZE_FULL);
    map.getSource('braking-hotspots').setData(all);
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadTripsGeoJSON() {
  const loadingEl = document.getElementById('loadingIndicator');
  if (loadingEl) loadingEl.style.display = 'block';
  try {
    const r = await fetch('./trips.geojson');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const geojson = await r.json();
    console.log(`✅ Loaded trips.geojson — ${geojson.features?.length ?? 0} segments`);
    return geojson;
  } catch (err) {
    console.error('❌ Could not load trips.geojson:', err);
    return { type: 'FeatureCollection', features: [] };
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

async function loadAveragedSegments() {
  const paths = ['./road_segments_averaged.json', `${CONFIG.DATA_URL}road_segments_averaged.json`];
  for (const path of paths) {
    try {
      const r = await fetch(path);
      if (r.ok) {
        const data = await r.json();
        console.log(`✅ Loaded ${data.features.length} averaged segments`);
        return data;
      }
    } catch {}
  }
  console.error('❌ Could not load averaged segments');
  return null;
}

function formatDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function hasAccordionFilter() {
  const sensors = Object.keys(sensorColorMap);
  return selectedSensorFilters.size !== sensors.length || !!selectedDateFrom || !!selectedDateTo;
}

function updateResetButtonVisibility() {
  const active = showSpeedColors || showRoadQuality || showAveragedSegments || showBraking || !!activeFilter || !!selectedTrip || hasAccordionFilter();
  document.getElementById('resetButton').style.display = active ? 'block' : 'none';
}

function currentColorExpression() {
  if (showSpeedColors) return getSpeedColorExpression(speedMode);
  if (showRoadQuality) return getRoadQualityColorExpression();
  return getSensorColorExpression();
}

function getSelectedTripIds() {
  if (!activeFilter) return null;
  return Array.isArray(activeFilter) ? activeFilter : [activeFilter];
}

function applyTripFilter(filterTripId) {
  activeFilter = filterTripId;
  if (!map.getLayer('trips-layer')) return;

  if (filterTripId) {
    let highlightColor;
    if (showSpeedColors) {
      highlightColor = getSpeedColorExpression(speedMode);
    } else if (showRoadQuality) {
      highlightColor = getRoadQualityColorExpression();
    } else {
      highlightColor = '#FF69B4';
    }
    map.setPaintProperty('trips-layer', 'line-color', [
      'case',
      ['==', ['get', 'trip_id'], filterTripId],
      highlightColor,
      'rgba(0,0,0,0)'
    ]);
    map.setPaintProperty('trips-layer', 'line-opacity', 1);
    map.setPaintProperty('trips-layer', 'line-width', [
      'case', ['==', ['get', 'trip_id'], filterTripId], 4, 0
    ]);
  } else {
    map.setPaintProperty('trips-layer', 'line-color', currentColorExpression());
    map.setPaintProperty('trips-layer', 'line-opacity', 0.7);
    map.setPaintProperty('trips-layer', 'line-width', 3);
  }

  // If braking is active, sync hotspot filter to the selected trip
  if (showBraking) applyBrakingTripFilter(filterTripId);
}

function applyGroupFilter(matchingIds) {
  activeFilter = matchingIds;
  if (!map.getLayer('trips-layer')) return;
  const set = new Set(matchingIds);

  let highlightColor;
  if (showSpeedColors) {
    highlightColor = getSpeedColorExpression(speedMode);
  } else if (showRoadQuality) {
    highlightColor = getRoadQualityColorExpression();
  } else {
    highlightColor = '#FF69B4';
  }

  map.setPaintProperty('trips-layer', 'line-color', [
    'case',
    ['in', ['get', 'trip_id'], ['literal', [...set]]],
    highlightColor,
    'rgba(0,0,0,0)'
  ]);
  map.setPaintProperty('trips-layer', 'line-opacity', 1);
  map.setPaintProperty('trips-layer', 'line-width', [
    'case', ['in', ['get', 'trip_id'], ['literal', [...set]]], 4, 0
  ]);
}

// ─── Selection ────────────────────────────────────────────────────────────────
function resetSelection() {
  selectedTrip         = null;
  activeFilter         = null;
  showSpeedColors      = false;
  showRoadQuality      = false;
  showAveragedSegments = false;
  showBraking          = false;

  if (currentPopup) { currentPopup.remove(); currentPopup = null; }
  applyTripFilter(null);

  ['speedColorsCheckbox','roadQualityCheckbox','averagedSegmentsCheckbox','brakingCheckbox'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });

  document.getElementById('speedLegend').style.display            = 'none';
  document.getElementById('speedModeGroup').style.display         = 'none';
  document.getElementById('roadQualityLegend').style.display      = 'none';
  document.getElementById('averagedSegmentsLegend').style.display = 'none';
  document.getElementById('averagedModeGroup').style.display      = 'none';
  const brakingLegend = document.getElementById('brakingLegend');
  if (brakingLegend) brakingLegend.style.display = 'none';

  if (map.getLayer('averaged-segments'))
    map.setLayoutProperty('averaged-segments', 'visibility', 'none');
  if (map.getLayer('braking-hotspots-halo'))
    map.setLayoutProperty('braking-hotspots-halo', 'visibility', 'none');
  if (map.getLayer('braking-hotspots-dot'))
    map.setLayoutProperty('braking-hotspots-dot', 'visibility', 'none');

  if (map.getLayer('trips-layer')) {
    map.setLayoutProperty('trips-layer', 'visibility', 'visible');
    map.setPaintProperty('trips-layer', 'line-color', getSensorColorExpression());
    map.setPaintProperty('trips-layer', 'line-opacity', 0.7);
    map.setPaintProperty('trips-layer', 'line-width', 3);
  }

  document.getElementById('selectedTripRow').style.display  = 'none';
  document.getElementById('statTripRow').style.display      = 'flex';
  document.getElementById('statDistanceRow').style.display  = 'flex';
  document.getElementById('statAvgSpeedRow').style.display  = 'flex';
  document.getElementById('statTotalTimeRow').style.display = 'flex';

  updateResetButtonVisibility();
  setTimeout(updateLegendPositions, 50);
  updateStatsVisibility();
}

// Deselect a trip/sensor highlight without touching the other filter
// checkboxes (speed/quality/etc stay as they were).
function clearFilter() {
  selectedTrip = null;
  activeFilter = null;
  if (currentPopup) { currentPopup.remove(); currentPopup = null; }
  applyTripFilter(null);

  // Restore all braking hotspots when deselecting
  if (showBraking) applyBrakingTripFilter(null);

  document.getElementById('selectedTripRow').style.display  = 'none';
  document.getElementById('statTripRow').style.display      = 'flex';
  document.getElementById('statDistanceRow').style.display  = 'flex';
  document.getElementById('statAvgSpeedRow').style.display  = 'flex';
  document.getElementById('statTotalTimeRow').style.display = 'flex';

  updateResetButtonVisibility();
}

function showSelection(tripId) {
  document.getElementById('statTripRow').style.display      = 'none';
  document.getElementById('statDistanceRow').style.display  = 'none';
  document.getElementById('statAvgSpeedRow').style.display  = 'none';
  document.getElementById('statTotalTimeRow').style.display = 'none';
  document.getElementById('selectedTripRow').style.display  = 'flex';
  const name = tripId.replace(/_/g, ' ').replace(/processed/gi, '').replace(/clean/gi, '').trim();
  document.getElementById('selectedTrip').textContent = name;
  updateResetButtonVisibility();
}

// Highlight every trip belonging to one sensor (triggered by clicking its
// swatch in the sensor legend).
function highlightSensor(sensor) {
  if (!sensor) { resetSelection(); return; }
  const q       = sensor.toLowerCase().trim();
  const matches = tripIds.filter(id => id.toLowerCase().includes(q));

  if (matches.length === 0) return false;

  if (matches.length === 1) {
    selectedTrip = matches[0];
    applyTripFilter(matches[0]);
    showSelection(matches[0]);
  } else {
    selectedTrip = null;
    applyGroupFilter(matches);
    if (showBraking) applyBrakingTripFilter(matches);
    document.getElementById('statTripRow').style.display      = 'none';
    document.getElementById('statDistanceRow').style.display  = 'none';
    document.getElementById('statAvgSpeedRow').style.display  = 'none';
    document.getElementById('statTotalTimeRow').style.display = 'none';
    document.getElementById('selectedTripRow').style.display  = 'flex';
    document.getElementById('selectedTrip').textContent = `${sensor.toUpperCase()} — ${matches.length} trips`;
    updateResetButtonVisibility();
  }

  try {
    const features = map.querySourceFeatures('trips', {
      filter: ['in', ['get', 'trip_id'], ['literal', matches]]
    });
    if (features.length > 0) {
      const bbox = turf.bbox({ type: 'FeatureCollection', features });
      map.fitBounds(bbox, { padding: 50, duration: 1000 });
    }
  } catch (err) {
    console.error('Zoom error:', err);
  }

  return true;
}

// ─── Averaged segments ────────────────────────────────────────────────────────
function updateAveragedSegmentColors() {
  if (!map.getLayer('averaged-segments')) return;
  const exprs = {
    speed:     getAveragedSpeedColorExpression(),
    quality:   getAveragedQualityColorExpression(),
    composite: getCompositeScoreColorExpression(),
  };
  map.setPaintProperty('averaged-segments', 'circle-color', exprs[averagedSegmentMode]);
}

async function setupAveragedSegments(labelLayerId) {
  const data = await loadAveragedSegments();
  if (!data) return;

  const pointFeatures = data.features.map(f => {
    const coords = f.geometry.coordinates;
    const midLng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const midLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [midLng, midLat] }, properties: f.properties };
  });

  map.addSource('averaged-segments', { type: 'geojson', data: { type: 'FeatureCollection', features: pointFeatures } });
  map.addLayer({
    id: 'averaged-segments', type: 'circle', source: 'averaged-segments',
    layout: { visibility: 'none' },
    paint: {
      'circle-color':           getCompositeScoreColorExpression(),
      'circle-radius':          ['interpolate', ['linear'], ['zoom'], 10, 18, 13, 28, 16, 45],
      'circle-blur':            1.2,
      'circle-opacity':         0.6,
      'circle-pitch-alignment': 'map',
    }
  }, labelLayerId);

  map.on('click', 'averaged-segments', (e) => {
    e.preventDefault();
    if (e.originalEvent) e.originalEvent.stopPropagation();
    const p = e.features[0].properties;
    const qualityText = p.avg_quality
      ? `🛣️ Avg Quality: ${p.avg_quality} (${getQualityLabel(p.avg_quality)})`
      : '🛣️ Quality: No data';
    new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(`
      <strong>📊 Averaged Road Segment</strong><br>
      🚴 Avg Speed: ${p.avg_speed} km/h<br>
      📈 Speed Range: ${p.min_speed} - ${p.max_speed} km/h<br>
      ${qualityText}<br>
      📏 Distance: ${p.distance_m}m<br>
      🎯 Composite Score: ${p.composite_score} (${getCompositeLabel(p.composite_score)})<br>
      📍 Observations: ${p.observation_count}<br>
      🚲 From ${p.trip_count} trips
    `).addTo(map);
  });
  map.on('mouseenter', 'averaged-segments', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'averaged-segments', () => { map.getCanvas().style.cursor = ''; });

  console.log('✅ Averaged segments layer added');
}

// ─── Braking hotspot accumulation ────────────────────────────────────────────
// Grid ("tile") size in degrees. Coarser = fewer cells = lighter on RAM when
// gridding the whole dataset; finer = smoother/more precise, cheap once we've
// already narrowed down to a single trip or sensor's worth of points.
const BRAKING_CELL_SIZE_FULL     = 0.0002;   // ~22m — used for all trips at once
const BRAKING_CELL_SIZE_ISOLATED = 0.00004;  // ~4.5m — used once a trip/sensor is selected

function buildBrakingHotspots(features, cellSize = BRAKING_CELL_SIZE_FULL) {
  const CELL_SIZE = cellSize;
  const grid = new Map();

  for (const f of features) {
    if (!f.properties.is_braking) continue;

    const coords = f.geometry.coordinates;
    const mid    = coords[Math.floor(coords.length / 2)] || coords[0];
    const [lng, lat] = mid;

    const cellLng = Math.round(lng / CELL_SIZE) * CELL_SIZE;
    const cellLat = Math.round(lat / CELL_SIZE) * CELL_SIZE;
    // 6 decimals keeps the dedup key finer than either grid size above so
    // adjacent cells never collide when CELL_SIZE shrinks for isolated views.
    const key     = `${cellLng.toFixed(6)},${cellLat.toFixed(6)}`;

    if (!grid.has(key)) {
      grid.set(key, {
        lng: cellLng, lat: cellLat,
        count: 0, totalIntensity: 0, maxIntensity: 0,
        trips: new Set(),
      });
    }

    const cell = grid.get(key);
    cell.count++;
    cell.totalIntensity += f.properties.braking_intensity || 0;
    cell.maxIntensity    = Math.max(cell.maxIntensity, f.properties.braking_intensity || 0);
    cell.trips.add(f.properties.trip_id);
  }

  const hotspotFeatures = [...grid.values()].map(cell => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [cell.lng, cell.lat] },
    properties: {
      count:         cell.count,
      avg_intensity: parseFloat((cell.totalIntensity / cell.count).toFixed(1)),
      max_intensity: parseFloat(cell.maxIntensity.toFixed(1)),
      trip_count:    cell.trips.size,
    },
  }));

  console.log(`🛑 Built ${hotspotFeatures.length} braking hotspot cells`);
  return { type: 'FeatureCollection', features: hotspotFeatures };
}

function setupBrakingLayer(geojson, labelLayerId) {
  const hotspotData = buildBrakingHotspots(geojson.features || []);

  map.addSource('braking-hotspots', { type: 'geojson', data: hotspotData });

  // Outer glow
  map.addLayer({
    id: 'braking-hotspots-halo',
    type: 'circle',
    source: 'braking-hotspots',
    layout: { visibility: 'none' },
    paint: {
      'circle-color': getHotspotColorExpression(),
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, ['interpolate', ['linear'], ['get', 'count'],  1, 12,  5, 20, 15, 34],
        14, ['interpolate', ['linear'], ['get', 'count'],  1, 20,  5, 32, 15, 52],
        17, ['interpolate', ['linear'], ['get', 'count'],  1, 30,  5, 50, 15, 75],
      ],
      'circle-blur':            1.2,
      'circle-opacity':         0.35,
      'circle-pitch-alignment': 'map',
    },
  }, labelLayerId);

  // Solid dot — no stroke
  map.addLayer({
    id: 'braking-hotspots-dot',
    type: 'circle',
    source: 'braking-hotspots',
    layout: { visibility: 'none' },
    paint: {
      'circle-color': getHotspotColorExpression(),
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, ['interpolate', ['linear'], ['get', 'count'],  1,  4,  5,  8, 15, 14],
        14, ['interpolate', ['linear'], ['get', 'count'],  1,  7,  5, 13, 15, 20],
        17, ['interpolate', ['linear'], ['get', 'count'],  1, 11,  5, 18, 15, 28],
      ],
      'circle-opacity':         0.85,
      'circle-pitch-alignment': 'map',
    },
  }, labelLayerId);

  map.on('click', 'braking-hotspots-dot', (e) => {
    e.preventDefault();
    if (e.originalEvent) e.originalEvent.stopPropagation();
    const p = e.features[0].properties;
    let severity = 'Low';
    if (p.avg_intensity >= 15) severity = 'Emergency';
    else if (p.avg_intensity >= 5)   severity = 'Hard';
    else if (p.avg_intensity >= 2.5) severity = 'Firm';
    new mapboxgl.Popup()
      .setLngLat(e.lngLat)
      .setHTML(`
        <strong>🔴 Braking Hotspot</strong><br>
        📍 Events here: <strong>${p.count}</strong><br>
        ⚡ Avg deceleration: ${p.avg_intensity} km/h/s<br>
        🏎️ Peak deceleration: ${p.max_intensity} km/h/s<br>
        🚲 Across ${p.trip_count} trip(s)
      `)
      .addTo(map);
  });

  map.on('mouseenter', 'braking-hotspots-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'braking-hotspots-dot', () => { map.getCanvas().style.cursor = ''; });

  console.log('✅ Braking hotspot layer added');
}

// ─── Map load ─────────────────────────────────────────────────────────────────
map.on('error', e => console.error('❌ Map error:', e));

map.on('load', async () => {
  console.log('✅ Map loaded');

  const labelLayerId = getFirstLabelLayerId();
  console.log(`📌 Inserting layers before basemap layer: "${labelLayerId}"`);

  try {
    const geojson = await loadTripsGeoJSON();

    tripIds = [...new Set((geojson.features || []).map(f => f.properties.trip_id).filter(Boolean))].sort();
    console.log(`📊 ${tripIds.length} unique trips loaded`);

    buildSensorColorMap(tripIds);
    buildTripDateMap(geojson.features || []);
    renderFilterPanel();

    map.addSource('trips', {
      type: 'geojson',
      data: geojson,
      attribution: 'Bike sensor data',
    });

    map.addLayer({
      id: 'trips-layer',
      type: 'line',
      source: 'trips',
      layout: {
        'line-cap':  'round',
        'line-join': 'round',
      },
      paint: {
        'line-color':   getSensorColorExpression(),
        'line-width':   3,
        'line-opacity': 0.7,
      }
    }, labelLayerId);

    map.on('click', 'trips-layer', async (e) => {
      e.preventDefault();
      if (e.originalEvent) e.originalEvent.stopPropagation();
      if (currentPopup) { currentPopup.remove(); }

      const props       = e.features[0].properties;
      const tripId      = props.trip_id;
      const speed       = parseFloat(props.Speed || props.speed || 0);
      const roadQuality = parseInt(props.road_quality || 0);

      selectedTrip = tripId;
      applyTripFilter(tripId); // also filters braking hotspots if showBraking
      showSelection(tripId);

      const allFeats   = map.getSource('trips')?._data?.features || [];
      const tripFeats  = allFeats.filter(f => f.properties.trip_id === tripId);
      const geoDistKm  = (tripFeats.reduce((s, f) => s + (f.properties.gps_distance_m || 0), 0) / 1000).toFixed(2);
      const geoTime    = tripFeats.reduce((s, f) => s + (f.properties.time_diff_s || 0), 0);
      const geoSpeeds  = tripFeats.map(f => f.properties.Speed || 0).filter(s => s > 0);
      const geoAvgSpd  = geoSpeeds.length ? (geoSpeeds.reduce((a, b) => a + b, 0) / geoSpeeds.length).toFixed(1) : '—';
      const geoMaxSpd  = geoSpeeds.length ? Math.max(...geoSpeeds).toFixed(1) : '—';
      const geoBraking = tripFeats.filter(f => f.properties.is_braking).length;

      const distanceKm = geoDistKm;
      const avgSpeed   = geoAvgSpd;
      const maxSpeed   = geoMaxSpd;
      const duration   = formatDuration(Math.round(geoTime));
      const rideDate   = getTripDate(tripId);

      const qualityLabels = { 0:'Unknown', 1:'Perfect', 2:'Normal', 3:'Outdated', 4:'Bad', 5:'No road' };
      const popupName  = tripId.replace(/_/g, ' ').trim();
      const brakingLine = geoBraking > 0 ? `<br>🛑 Braking events: ${geoBraking}` : '';
      const dateLine    = rideDate ? `<br>📅 Date: ${formatDateDMY(rideDate)}` : '';

      currentPopup = new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`
          <strong>${popupName}</strong><br>
          🚴 Speed at point: ${speed} km/h<br>
          🛣️ Road quality: ${roadQuality} (${qualityLabels[roadQuality] || 'Unknown'})<br>
          📊 Average speed: ${avgSpeed} km/h<br>
          🏁 Max speed: ${maxSpeed} km/h<br>
          📍 Total distance: ${distanceKm} km<br>
          ⏱️ Duration: ${duration}${brakingLine}${dateLine}
        `)
        .addTo(map);
    });

    map.on('mouseenter', 'trips-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'trips-layer', () => { map.getCanvas().style.cursor = ''; });

    map.on('click', e => {
      if (!e.defaultPrevented) {
        if (activeFilter) clearFilter();
        else if (selectedTrip) {
          // If braking is active, deselecting restores all hotspots
          if (showBraking) applyBrakingTripFilter(null);
          resetSelection();
        }
      }
    });

    setupBrakingLayer(geojson, labelLayerId);
    await setupAveragedSegments(labelLayerId);

    setupControls();
    updateStatsFromMetadata();
    renderSensorLegend();
    updateStatsVisibility();

  } catch (err) {
    console.error('❌ Error loading trips:', err);
  }
});

// ─── UI helpers ───────────────────────────────────────────────────────────────
function isFilteredMode() { return showSpeedColors || showRoadQuality || showAveragedSegments || showBraking || !!activeFilter; }

function updateStatsVisibility() {
  const statsEl = document.getElementById('stats');
  if (statsEl) statsEl.style.display = (window.innerWidth <= 768 && isFilteredMode()) ? 'none' : 'block';
  const sensorLegend = document.getElementById('sensorLegend');
  if (sensorLegend) sensorLegend.style.display = isFilteredMode() ? 'none' : 'block';
}

const sensorLegendEl = document.getElementById('sensorLegend');
sensorLegendEl.addEventListener('scroll', () => {
  sensorLegendEl.classList.toggle('is-scrolled', sensorLegendEl.scrollTop > 0);
});

window.addEventListener('resize', updateStatsVisibility);

function updateLegendPositions() {
  const order   = ['averagedSegmentsLegend','speedLegend','roadQualityLegend','brakingLegend','sensorLegend'];
  const visible = order.map(id => document.getElementById(id)).filter(el => el && el.style.display === 'block');
  const mobile  = window.matchMedia('(max-width: 768px)').matches;
  updateStatsVisibility();

  if (mobile) {
    let b = 10;
    visible.forEach(el => { el.style.right = '10px'; el.style.bottom = `${b}px`; b += (el.offsetHeight || 150) + 8; });
  } else {
    let r = 10;
    visible.forEach(el => { el.style.bottom = '10px'; el.style.right = `${r}px`; r += (el.offsetWidth || 220) + 10; });
  }
}

function setupAveragedSegmentControls() {
  const cb = document.getElementById('averagedSegmentsCheckbox');
  if (cb) {
    cb.addEventListener('change', e => {
      showAveragedSegments = e.target.checked;
      const modeGroup    = document.getElementById('averagedModeGroup');
      const legend       = document.getElementById('averagedSegmentsLegend');
      const sensorLegend = document.getElementById('sensorLegend');

      if (showAveragedSegments) {
        if (map.getLayer('averaged-segments')) map.setLayoutProperty('averaged-segments', 'visibility', 'visible');
        if (modeGroup)    modeGroup.style.display    = 'flex';
        if (legend)       legend.style.display       = 'block';
        if (sensorLegend) sensorLegend.style.display = 'none';
        if (map.getLayer('trips-layer')) map.setLayoutProperty('trips-layer', 'visibility', 'none');
        updateAveragedSegmentColors();
      } else {
        if (map.getLayer('averaged-segments')) map.setLayoutProperty('averaged-segments', 'visibility', 'none');
        if (modeGroup)    modeGroup.style.display    = 'none';
        if (legend)       legend.style.display       = 'none';
        if (sensorLegend) sensorLegend.style.display = 'block';
        if (map.getLayer('trips-layer')) map.setLayoutProperty('trips-layer', 'visibility', 'visible');
      }
      updateResetButtonVisibility();
      setTimeout(updateLegendPositions, 50);
      updateStatsVisibility();
    });
  }
  document.querySelectorAll('input[name="averagedMode"]').forEach(r => {
    r.addEventListener('change', e => {
      averagedSegmentMode = e.target.value;
      if (showAveragedSegments) updateAveragedSegmentColors();
    });
  });
}

function setupBrakingControls() {
  const cb = document.getElementById('brakingCheckbox');
  if (!cb) return;

  cb.addEventListener('change', e => {
    showBraking = e.target.checked;
    const legend     = document.getElementById('brakingLegend');
    const visibility = showBraking ? 'visible' : 'none';

    if (map.getLayer('braking-hotspots-halo')) map.setLayoutProperty('braking-hotspots-halo', 'visibility', visibility);
    if (map.getLayer('braking-hotspots-dot'))  map.setLayoutProperty('braking-hotspots-dot',  'visibility', visibility);

    if (legend) legend.style.display = showBraking ? 'block' : 'none';

    // When enabling braking, if a trip is already selected filter immediately
    if (showBraking && selectedTrip) applyBrakingTripFilter(selectedTrip);
    // When disabling, restore full hotspot data
    if (!showBraking) applyBrakingTripFilter(null);

    updateResetButtonVisibility();
    setTimeout(updateLegendPositions, 50);
    updateStatsVisibility();
  });
}

function refreshTripLayerColor() {
  if (!map.getLayer('trips-layer')) return;

  const selectedIds = getSelectedTripIds();

  if (!selectedIds) {
    map.setPaintProperty('trips-layer', 'line-color', currentColorExpression());
    map.setPaintProperty('trips-layer', 'line-opacity', 0.7);
    map.setPaintProperty('trips-layer', 'line-width', 3);
    return;
  }

  const baseExpr = currentColorExpression();
  const isSingle = selectedIds.length === 1;

  map.setPaintProperty('trips-layer', 'line-color', [
    'case',
    isSingle
      ? ['==', ['get', 'trip_id'], selectedIds[0]]
      : ['in', ['get', 'trip_id'], ['literal', selectedIds]],
    baseExpr,
    'rgba(0,0,0,0)'
  ]);
  map.setPaintProperty('trips-layer', 'line-opacity', 1);
  map.setPaintProperty('trips-layer', 'line-width', [
    'case',
    isSingle
      ? ['==', ['get', 'trip_id'], selectedIds[0]]
      : ['in', ['get', 'trip_id'], ['literal', selectedIds]],
    4,
    0
  ]);
}

function setupControls() {
  const resetBtn = document.getElementById('resetButton');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    resetSelection();
    resetAccordionFilters();
  });

  const speedCb = document.getElementById('speedColorsCheckbox');
  if (speedCb) {
    speedCb.addEventListener('change', e => {
      showSpeedColors = e.target.checked;
      if (showSpeedColors && showRoadQuality) {
        showRoadQuality = false;
        document.getElementById('roadQualityCheckbox').checked     = false;
        document.getElementById('roadQualityLegend').style.display = 'none';
      }
      const legend    = document.getElementById('speedLegend');
      const modeGroup = document.getElementById('speedModeGroup');
      if (showSpeedColors) {
        if (legend)    legend.style.display    = 'block';
        if (modeGroup) modeGroup.style.display = 'flex';
      } else {
        if (legend)    legend.style.display    = 'none';
        if (modeGroup) modeGroup.style.display = 'none';
      }
      refreshTripLayerColor();
      updateResetButtonVisibility();
      setTimeout(updateLegendPositions, 50);
      updateStatsVisibility();
    });
  }

  const qualityCb = document.getElementById('roadQualityCheckbox');
  if (qualityCb) {
    qualityCb.addEventListener('change', e => {
      showRoadQuality = e.target.checked;
      if (showRoadQuality && showSpeedColors) {
        showSpeedColors = false;
        document.getElementById('speedColorsCheckbox').checked    = false;
        document.getElementById('speedLegend').style.display      = 'none';
        document.getElementById('speedModeGroup').style.display   = 'none';
      }
      const legend = document.getElementById('roadQualityLegend');
      if (showRoadQuality) {
        if (legend) legend.style.display = 'block';
      } else {
        if (legend) legend.style.display = 'none';
      }
      refreshTripLayerColor();
      updateResetButtonVisibility();
      updateLegendPositions();
      updateStatsVisibility();
    });
  }

  document.querySelectorAll('input[name="speedMode"]').forEach(r => {
    r.addEventListener('change', e => {
      speedMode = e.target.value;
      if (showSpeedColors) refreshTripLayerColor();
    });
  });

  setupAveragedSegmentControls();
  setupBrakingControls();
}

function updateStatsFromMetadata() {
  const source      = map.getSource('trips');
  const allFeatures = source?._data?.features || [];

  const tripStats = {};
  for (const f of allFeatures) {
    const tid   = f.properties.trip_id;
    const dist  = f.properties.gps_distance_m || 0;
    const time  = f.properties.time_diff_s    || 0;
    const speed = f.properties.Speed          || 0;

    if (!tripStats[tid]) tripStats[tid] = { dist: 0, time: 0, speeds: [] };
    tripStats[tid].dist += dist;
    tripStats[tid].time += time;
    if (speed > 0) tripStats[tid].speeds.push(speed);
  }

  let totalDist = 0, totalTime = 0, allSpeeds = [];
  for (const t of Object.values(tripStats)) {
    totalDist += t.dist;
    totalTime += t.time;
    allSpeeds.push(...t.speeds);
  }

  const avgSpeed = allSpeeds.length
    ? (allSpeeds.reduce((a, b) => a + b, 0) / allSpeeds.length).toFixed(1)
    : '—';

  document.getElementById('statTrips').textContent     = tripIds.length;
  document.getElementById('statDistance').textContent  = `${(totalDist / 1000).toFixed(1)} km`;
  document.getElementById('statAvgSpeed').textContent  = `${avgSpeed} km/h`;
  document.getElementById('statTotalTime').textContent = formatDuration(Math.round(totalTime));
}

// ─── Trip dates ───────────────────────────────────────────────────────────────
// Uses each trip's first available "timestamp" property (added by
// generate_trips_geojson.py). Older trips.geojson files generated before that
// change won't have this field, so trips just won't appear in the date map/dropdown.
function buildTripDateMap(features) {
  tripDates = {};
  for (const f of features) {
    const tid = f.properties.trip_id;
    const ts  = f.properties.timestamp;
    if (!tid || !ts || tripDates[tid]) continue;
    tripDates[tid] = ts.slice(0, 10); // 'YYYY-MM-DD'
  }
}

function getTripDate(tripId) {
  return tripDates[tripId] || null;
}

// Converts an internal 'YYYY-MM-DD' date string to display format 'DD/MM/YYYY'.
function formatDateDMY(isoDate) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ─── Sensor + date filter panel ────────────────────────────────────────────────
// This panel uses map.setFilter() on trips-layer to show/hide whole trips
// while leaving the layer's paint (sensor colours, speed colours, etc.)
// completely untouched — so filtered trips keep their real colours instead
// of turning pink, and this filter is independent of the click-to-select /
// click-off-to-clear "activeFilter" system used by the bottom-right sensor
// legend and route clicks.
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function applyBaseTripSetFilter(matches) {
  if (!map.getLayer('trips-layer')) return;
  map.setFilter('trips-layer', matches === null ? null : ['in', ['get', 'trip_id'], ['literal', matches]]);
}

function updateFilterMatchCount(count) {
  const el = document.getElementById('filterMatchCount');
  if (!el) return;
  if (count === null) {
    el.textContent = '';
  } else if (count === 0) {
    el.textContent = 'No trips match these filters';
  } else {
    el.textContent = `Showing ${count} of ${tripIds.length} trips`;
  }
}

function renderFilterPanel() {
  const toggleBtn  = document.getElementById('filterAccordionToggle');
  const content    = document.getElementById('filterAccordionContent');
  const accordion  = toggleBtn ? toggleBtn.closest('.filter-accordion') : null;
  const listEl     = document.getElementById('filterSensorList');
  const allCb      = document.getElementById('filterSensorAll');
  const fromInput  = document.getElementById('dateFilterFrom');
  const toInput    = document.getElementById('dateFilterTo');
  if (!toggleBtn || !content || !listEl || !allCb || !fromInput || !toInput) return;

  // Accordion open/close
  const chevron = toggleBtn.querySelector('.filter-accordion-chevron');
  toggleBtn.onclick = () => {
    content.hidden = !content.hidden;
    if (accordion) accordion.classList.toggle('open', !content.hidden);
    if (chevron) chevron.textContent = content.hidden ? '⌄' : '⌃';
  };

  // Sensors default to "all selected" = no filtering
  const sensors = Object.keys(sensorColorMap).sort();
  selectedSensorFilters = new Set(sensors);

  listEl.innerHTML = sensors.map(s => `
    <label class="filter-sensor-item">
      <input type="checkbox" class="filterSensorCheckbox" value="${s}" checked>
      <div class="speed-color-box" style="background:${sensorColorMap[s]};"></div>
      <span>${s}</span>
    </label>`).join('');

  const sensorCbs = [...listEl.querySelectorAll('.filterSensorCheckbox')];

  function syncAllCheckbox() {
    if (selectedSensorFilters.size === sensors.length) {
      allCb.checked = true; allCb.indeterminate = false;
    } else if (selectedSensorFilters.size === 0) {
      allCb.checked = false; allCb.indeterminate = false;
    } else {
      allCb.checked = false; allCb.indeterminate = true;
    }
  }

  sensorCbs.forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedSensorFilters.add(cb.value);
      else selectedSensorFilters.delete(cb.value);
      syncAllCheckbox();
      applyDropdownFilters();
    });
  });

  allCb.addEventListener('change', () => {
    const checkAll = allCb.checked;
    sensorCbs.forEach(cb => { cb.checked = checkAll; });
    selectedSensorFilters = new Set(checkAll ? sensors : []);
    allCb.indeterminate = false;
    applyDropdownFilters();
  });

  // Dates — auto-hide the whole "Dates" section if trips.geojson has no
  // timestamps yet (needs a pipeline regeneration)
  const dates = [...new Set(Object.values(tripDates))].filter(Boolean).sort();
  const dateSection = fromInput.closest('.filter-section');
  if (dates.length) {
    fromInput.min = toInput.min = dates[0];
    fromInput.max = toInput.max = dates[dates.length - 1];
    if (dateSection) dateSection.style.display = '';
  } else if (dateSection) {
    dateSection.style.display = 'none';
  }

  fromInput.addEventListener('change', () => {
    selectedDateFrom = fromInput.value;
    setActivePresetButton(null);
    applyDropdownFilters();
  });
  toInput.addEventListener('change', () => {
    selectedDateTo = toInput.value;
    setActivePresetButton(null);
    applyDropdownFilters();
  });

  document.querySelectorAll('.filter-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyDatePreset(btn.dataset.preset));
  });
}

function setActivePresetButton(preset) {
  document.querySelectorAll('.filter-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
}

function applyDatePreset(preset) {
  const today = new Date();
  let from = '', to = '';

  if (preset === 'today') {
    from = to = isoDate(today);
  } else if (preset === 'yesterday') {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    from = to = isoDate(y);
  } else if (preset === 'last7') {
    const start = new Date(today); start.setDate(start.getDate() - 6);
    from = isoDate(start); to = isoDate(today);
  } else if (preset === 'last30') {
    const start = new Date(today); start.setDate(start.getDate() - 29);
    from = isoDate(start); to = isoDate(today);
  } // 'all' (or anything else) leaves from/to as ''

  selectedDateFrom = from;
  selectedDateTo   = to;

  const fromInput = document.getElementById('dateFilterFrom');
  const toInput   = document.getElementById('dateFilterTo');
  if (fromInput) fromInput.value = from;
  if (toInput)   toInput.value   = to;

  setActivePresetButton(preset);
  applyDropdownFilters();
}

function applyDropdownFilters() {
  const sensors = Object.keys(sensorColorMap);
  const noSensorFilter = selectedSensorFilters.size === sensors.length;
  const noDateFilter    = !selectedDateFrom && !selectedDateTo;

  if (noSensorFilter && noDateFilter) {
    applyBaseTripSetFilter(null);
    updateFilterMatchCount(null);
    updateResetButtonVisibility();
    return;
  }

  let matches = tripIds;
  if (!noSensorFilter) matches = matches.filter(id => selectedSensorFilters.has(id.split('_')[0]));
  if (!noDateFilter) {
    matches = matches.filter(id => {
      const d = tripDates[id];
      if (!d) return false;
      if (selectedDateFrom && d < selectedDateFrom) return false;
      if (selectedDateTo   && d > selectedDateTo)   return false;
      return true;
    });
  }

  applyBaseTripSetFilter(matches);
  updateFilterMatchCount(matches.length);
  updateResetButtonVisibility();
}

function resetAccordionFilters() {
  selectedSensorFilters = new Set(Object.keys(sensorColorMap));
  selectedDateFrom = '';
  selectedDateTo   = '';

  const allCb = document.getElementById('filterSensorAll');
  if (allCb) { allCb.checked = true; allCb.indeterminate = false; }
  document.querySelectorAll('.filterSensorCheckbox').forEach(cb => { cb.checked = true; });

  const fromInput = document.getElementById('dateFilterFrom');
  const toInput   = document.getElementById('dateFilterTo');
  if (fromInput) fromInput.value = '';
  if (toInput)   toInput.value   = '';
  setActivePresetButton(null);

  applyBaseTripSetFilter(null);
  updateFilterMatchCount(null);
  updateResetButtonVisibility();
}

function renderSensorLegend() {
  const legend = document.getElementById('sensorLegend');
  if (!legend) return;
  legend.innerHTML = `<h4>Sensors</h4>` + Object.entries(sensorColorMap).map(([s, c]) => `
    <div class="speed-legend-item sensor-legend-item" data-sensor="${s}" style="cursor:pointer;" title="Click to highlight ${s}">
      <div class="speed-color-box" style="background:${c};"></div>
      <span>${s}</span>
    </div>`).join('');

  legend.querySelectorAll('.sensor-legend-item').forEach(item => {
    item.addEventListener('click', () => {
      highlightSensor(item.dataset.sensor);
    });
  });

  legend.style.display = 'block';
  updateLegendPositions();
}