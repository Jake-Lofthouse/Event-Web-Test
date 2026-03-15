const fs = require('fs');
const path = require('path');
const https = require('https');
const puppeteer = require('puppeteer');

// ============================================================
// CONFIG
// ============================================================
const EVENTS_URL     = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL = process.env.COURSE_MAPS_URL;
const OUTPUT_DIR     = './images';
const IMAGE_WIDTH    = 1200;
const IMAGE_HEIGHT   = 630;
const MAX_EVENTS     = 9999999;
const CONCURRENCY    = 3; // how many pages rendered in parallel
const IMAGE_LIMIT    = parseInt(process.env.IMAGE_LIMIT || '0', 10);

if (!COURSE_MAPS_URL) {
  throw new Error('COURSE_MAPS_URL secret not set');
}

// ============================================================
// HELPERS
// ============================================================
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function slugify(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function getSubfolder(slug) {
  const firstChar = slug.charAt(0).toLowerCase();
  if (firstChar >= 'a' && firstChar <= 'z') return firstChar.toUpperCase();
  return '0-9';
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ============================================================
// BUILD HTML FOR PUPPETEER TO RENDER
// Each page is a self-contained Leaflet map with route + labels.
// ============================================================
function buildMapHtml(longName, isJunior, route, start, finish) {
  const accentColor = isJunior ? '#40e0d0' : '#4caf50';
  const darkColor   = isJunior ? '#008080' : '#2e7d32';

  const routeJson  = JSON.stringify(route);
  const startJson  = JSON.stringify(start);
  const finishJson = JSON.stringify(finish);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${IMAGE_WIDTH}px; height: ${IMAGE_HEIGHT}px; overflow: hidden; }
#map { width: ${IMAGE_WIDTH}px; height: ${IMAGE_HEIGHT}px; }

/* Event name overlay */
#title-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  z-index: 1000;
  background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0) 100%);
  padding: 2.5rem 2rem 1.5rem 2rem;
  pointer-events: none;
}
#title-text {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 2.6rem;
  font-weight: 800;
  color: #fff;
  text-shadow: 0 2px 12px rgba(0,0,0,0.5);
  letter-spacing: -0.5px;
  line-height: 1.15;
}
#subtitle-text {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 1.1rem;
  font-weight: 500;
  color: rgba(255,255,255,0.82);
  margin-top: 0.3rem;
  text-shadow: 0 1px 6px rgba(0,0,0,0.4);
}

/* Logo badge top-right */
#logo-badge {
  position: absolute;
  top: 1.25rem; right: 1.5rem;
  z-index: 1000;
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(8px);
  border-radius: 999px;
  padding: 0.45rem 1rem;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 0.85rem;
  font-weight: 700;
  color: ${darkColor};
  pointer-events: none;
  box-shadow: 0 2px 12px rgba(0,0,0,0.18);
}

.leaflet-control-attribution { display: none !important; }
.leaflet-control-zoom { display: none !important; }
</style>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
</head>
<body>
<div id="map"></div>
<div id="title-bar">
  <div id="title-text">${longName}</div>
  <div id="subtitle-text">parkrunner tourist &nbsp;·&nbsp; Course Map</div>
</div>
<div id="logo-badge">parkrunner tourist</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const route  = ${routeJson};
const start  = ${startJson};
const finish = ${finishJson};

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false,
  touchZoom: false
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 19
}).addTo(map);

const routeLatLngs = route.map(p => [p[1], p[0]]);

// Route polyline
L.polyline(routeLatLngs, {
  color: '${accentColor}',
  weight: 5,
  opacity: 1,
  lineJoin: 'round',
  lineCap: 'round'
}).addTo(map);

// Start marker (green circle)
const startPt = start || route[0];
L.circleMarker([startPt[1], startPt[0]], {
  radius: 10,
  fillColor: '#28a745',
  color: '#fff',
  weight: 3,
  fillOpacity: 1
}).addTo(map).bindTooltip('Start', { permanent: true, direction: 'top', offset: [0, -10],
  className: 'leaflet-tooltip' });

// Finish marker (red circle)
const finishPt = finish || route[route.length - 1];
L.circleMarker([finishPt[1], finishPt[0]], {
  radius: 10,
  fillColor: '#dc3545',
  color: '#fff',
  weight: 3,
  fillOpacity: 1
}).addTo(map).bindTooltip('Finish', { permanent: true, direction: 'top', offset: [0, -10],
  className: 'leaflet-tooltip' });

map.fitBounds(L.latLngBounds(routeLatLngs), { padding: [60, 60], animate: false });

// Signal ready for screenshot
window._mapReady = true;
</script>
</body>
</html>`;
}

// ============================================================
// RENDER ONE IMAGE
// ============================================================
async function renderImage(browser, event, courseMaps, folderMapping) {
  const name      = event.properties.eventname || '';
  const longName  = event.properties.EventLongName || name;
  const isJunior  = longName.toLowerCase().includes('junior');
  const slug      = slugify(name);

  const sub = folderMapping[slug] || getSubfolder(slug);
  const outDir  = path.join(OUTPUT_DIR, sub);
  const outFile = path.join(outDir, `${slug}.jpg`);

  // Skip if already exists (incremental builds)
  if (fs.existsSync(outFile)) {
    console.log(`Skipped (exists): ${sub}/${slug}.jpg`);
    return;
  }

  // Find course data
  const courseKey = Object.keys(courseMaps).find(k =>
    k === name ||
    k === name.toLowerCase() ||
    k === slug ||
    k.replace(/-/g, '').toLowerCase() === name.replace(/\s+/g, '').toLowerCase()
  );
  const courseData = courseKey ? courseMaps[courseKey] : null;
  const hasRoute   = courseData && Array.isArray(courseData.route) && courseData.route.length > 1;

  if (!hasRoute) {
    console.log(`No route — skipping: ${slug}`);
    return;
  }

  const route  = courseData.route;
  const start  = Array.isArray(courseData.start)  && courseData.start.length  === 2 ? courseData.start  : null;
  const finish = Array.isArray(courseData.finish) && courseData.finish.length === 2 ? courseData.finish : null;

  const html = buildMapHtml(longName, isJunior, route, start, finish);

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for Leaflet tiles and map to be ready
    await page.waitForFunction(() => window._mapReady === true, { timeout: 15000 });
    // Extra settle time for tiles to paint
    await new Promise(r => setTimeout(r, 1500));

    ensureDir(outDir);
    await page.screenshot({
      path: outFile,
      type: 'jpeg',
      quality: 88,
      clip: { x: 0, y: 0, width: IMAGE_WIDTH, height: IMAGE_HEIGHT }
    });

    console.log(`Generated: ${sub}/${slug}.jpg`);
  } catch (err) {
    console.warn(`Failed: ${slug} — ${err.message}`);
  } finally {
    await page.close();
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('Fetching events JSON...');
  const data = await fetchJson(EVENTS_URL);
  let events;
  if (Array.isArray(data)) events = data;
  else if (Array.isArray(data.features)) events = data.features;
  else if (data.events && Array.isArray(data.events.features)) events = data.events.features;
  else throw new Error('Unexpected JSON structure');

  console.log('Fetching course maps...');
  let courseMaps = {};
  try {
    courseMaps = await fetchJson(COURSE_MAPS_URL);
    console.log(`Loaded ${Object.keys(courseMaps).length} course map entries.`);
  } catch (e) {
    console.warn('Could not load course maps:', e.message);
  }

  let folderMapping = {};
  try { folderMapping = JSON.parse(fs.readFileSync('./folder-mapping.json', 'utf-8')); }
  catch (e) { console.warn('No folder mapping, using dynamic.'); }

  const selectedEvents = events.slice(0, MAX_EVENTS);
  selectedEvents.sort((a, b) =>
    (a.properties.eventname || '').toLowerCase().localeCompare((b.properties.eventname || '').toLowerCase())
  );

  const limitedEvents = IMAGE_LIMIT > 0 ? selectedEvents.slice(0, IMAGE_LIMIT) : selectedEvents;
  if (IMAGE_LIMIT > 0) console.log(`Limit set — generating up to ${IMAGE_LIMIT} images.`);
  console.log(`Processing ${limitedEvents.length} events...`);

  ensureDir(OUTPUT_DIR);

  console.log(`Launching browser...`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  let generated = 0, skipped = 0, failed = 0;

  // Process in batches to control concurrency
  const batches = chunk(limitedEvents, CONCURRENCY);
  for (const batch of batches) {
    await Promise.all(batch.map(async event => {
      try {
        const before = generated;
        await renderImage(browser, event, courseMaps, folderMapping);
        const slug = slugify(event.properties.eventname || '');
        const sub  = folderMapping[slug] || getSubfolder(slug);
        if (fs.existsSync(path.join(OUTPUT_DIR, sub, `${slug}.jpg`))) {
          generated++;
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
        console.warn('Batch error:', e.message);
      }
    }));
  }

  await browser.close();
  console.log(`\nDone! ${generated} generated, ${skipped} skipped, ${failed} failed.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
