/**
 * generate-locations.js
 *
 * Generates a three-tier set of static HTML pages:
 *   /locations/                                    — world index (all countries)
 *   /locations/[country-slug]/                     — country page (all regions)
 *   /locations/[country-slug]/[region-slug]/       — region page (cities + all event cards)
 *   /locations/[country-slug]/[region-slug]/[city-slug]/  — city page (event cards)
 *
 * All URLs use trailing slashes (index.html files in folders) — no .html in URLs.
 *
 * Region and city resolved via Nominatim (OpenStreetMap) reverse geocoding.
 * Results cached in ./geo-cache.json — repeat runs skip the API entirely.
 * Nominatim policy: max 1 req/s, descriptive User-Agent — both enforced.
 *
 * Header, footer, fonts, colours all match the main generate-events.js exactly.
 * Event cards use the same course preview mini-map (Leaflet + encrypted coords).
 * Pages with 8+ events get a client-side search filter.
 * Every region/city page has a Stay22 "book accommodation" CTA.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EVENTS_URL      = 'https://www.parkrunnertourist.com/events1.json';
const COURSE_MAPS_URL = process.env.COURSE_MAPS_URL;
if (!COURSE_MAPS_URL) throw new Error('COURSE_MAPS_URL secret not set');

const BASE_EXPLORE_URL   = 'https://www.parkrunnertourist.com/explore';
const BASE_LOCATIONS_URL = 'https://www.https://jake-lofthouse.github.io/Event-Web-Test/locations';
const SITE_NAME          = 'parkrunner tourist';
const OUTPUT_DIR         = path.join(__dirname, '../locations');
const GEO_CACHE_FILE     = path.join(__dirname, '../geo-cache.json');
const EVENT_LIMIT        = parseInt(process.env.EVENT_LIMIT || '0', 10);
const SEARCH_THRESHOLD   = 8;

// Nominatim: 1 req/s, descriptive UA required by their policy
const NOMINATIM_DELAY_MS = 1100;
const NOMINATIM_UA       = 'parkrunnertourist.com location-page-builder (@parkrunnertourist.com)';

// Exact colours from generate-events.js
const ACCENT    = '#4caf50';
const DARK      = '#2e7d32';
const ACCENT_JR = '#40e0d0';
const DARK_JR   = '#008080';

// ---------------------------------------------------------------------------
// Country code → display name + parkrun domain
// ---------------------------------------------------------------------------
const COUNTRY_META = {
  '0':  { name: 'Unknown',        url: null                  },
  '3':  { name: 'Australia',      url: 'www.parkrun.com.au'  },
  '4':  { name: 'Austria',        url: 'www.parkrun.co.at'   },
  '14': { name: 'Canada',         url: 'www.parkrun.ca'      },
  '23': { name: 'Denmark',        url: 'www.parkrun.dk'      },
  '30': { name: 'Finland',        url: 'www.parkrun.fi'      },
  '32': { name: 'Germany',        url: 'www.parkrun.com.de'  },
  '42': { name: 'Ireland',        url: 'www.parkrun.ie'      },
  '44': { name: 'Italy',          url: 'www.parkrun.it'      },
  '46': { name: 'Japan',          url: 'www.parkrun.jp'      },
  '54': { name: 'Lithuania',      url: 'www.parkrun.lt'      },
  '57': { name: 'Malaysia',       url: 'www.parkrun.my'      },
  '64': { name: 'Netherlands',    url: 'www.parkrun.co.nl'   },
  '65': { name: 'New Zealand',    url: 'www.parkrun.co.nz'   },
  '67': { name: 'Norway',         url: 'www.parkrun.no'      },
  '74': { name: 'Poland',         url: 'www.parkrun.pl'      },
  '82': { name: 'Singapore',      url: 'www.parkrun.sg'      },
  '85': { name: 'South Africa',   url: 'www.parkrun.co.za'   },
  '88': { name: 'Sweden',         url: 'www.parkrun.se'      },
  '97': { name: 'United Kingdom', url: 'www.parkrun.org.uk'  },
  '98': { name: 'United States',  url: 'www.parkrun.us'      },
};

// ---------------------------------------------------------------------------
// Nominatim address field priority per country code
// ---------------------------------------------------------------------------
const ADDRESS_FIELDS = {
  '97': { regionFields: ['county', 'state_district', 'state'],       cityFields: ['city', 'town', 'village', 'suburb'] },
  '3':  { regionFields: ['state'],                                    cityFields: ['city', 'suburb', 'town', 'village'] },
  '98': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village', 'county'] },
  '14': { regionFields: ['state', 'province'],                        cityFields: ['city', 'town', 'village', 'municipality'] },
  '32': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village', 'suburb'] },
  '42': { regionFields: ['county', 'state'],                          cityFields: ['city', 'town', 'village', 'suburb'] },
  '65': { regionFields: ['state', 'region'],                          cityFields: ['city', 'town', 'suburb', 'village'] },
  '85': { regionFields: ['state', 'province'],                        cityFields: ['city', 'town', 'suburb', 'village'] },
  '74': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village'] },
  '88': { regionFields: ['county', 'state'],                          cityFields: ['city', 'town', 'village', 'suburb'] },
  '23': { regionFields: ['state', 'county', 'region'],                cityFields: ['city', 'town', 'village'] },
  '30': { regionFields: ['state', 'region'],                          cityFields: ['city', 'town', 'village', 'municipality'] },
  '67': { regionFields: ['state', 'county'],                          cityFields: ['city', 'town', 'village', 'municipality'] },
  '64': { regionFields: ['state', 'province'],                        cityFields: ['city', 'town', 'village', 'suburb', 'municipality'] },
  '44': { regionFields: ['state', 'county'],                          cityFields: ['city', 'town', 'village', 'suburb'] },
  '4':  { regionFields: ['state'],                                    cityFields: ['city', 'town', 'village', 'suburb'] },
  '46': { regionFields: ['state', 'province', 'county'],              cityFields: ['city', 'town', 'village', 'suburb'] },
  '54': { regionFields: ['state', 'county'],                          cityFields: ['city', 'town', 'village', 'municipality'] },
  '57': { regionFields: ['state'],                                    cityFields: ['city', 'town', 'suburb', 'village'] },
  '82': { regionFields: ['country'],                                  cityFields: ['suburb', 'quarter', 'neighbourhood'] },
};
const DEFAULT_ADDRESS_FIELDS = {
  regionFields: ['state', 'county', 'state_district', 'region', 'province'],
  cityFields:   ['city', 'town', 'village', 'suburb', 'municipality'],
};

function getAddressFields(countryCode) {
  return ADDRESS_FIELDS[String(countryCode)] || DEFAULT_ADDRESS_FIELDS;
}

// ---------------------------------------------------------------------------
// HTTP / Nominatim helpers
// ---------------------------------------------------------------------------
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function nominatimReverse(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`;
  try {
    const data = await fetchJson(url, { 'User-Agent': NOMINATIM_UA });
    return (data && data.address) ? data.address : null;
  } catch (e) {
    console.warn(`  Nominatim error (${lat},${lon}): ${e.message}`);
    return null;
  }
}

function extractFromAddress(address, countryCode) {
  if (!address) return { city: null, region: null };
  const { regionFields, cityFields } = getAddressFields(countryCode);
  const region = regionFields.reduce((f, k) => f || address[k] || null, null);
  const city   = cityFields.reduce((f, k) => f || address[k] || null, null);
  return { city: city || null, region: region || null };
}

// ---------------------------------------------------------------------------
// Geo cache
// ---------------------------------------------------------------------------
function cacheKey(lat, lon) {
  return `${Math.round(lat * 1e4) / 1e4},${Math.round(lon * 1e4) / 1e4}`;
}

function loadCache() {
  try {
    if (fs.existsSync(GEO_CACHE_FILE))
      return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf-8'));
  } catch (e) { console.warn('Could not load geo cache, starting fresh:', e.message); }
  return {};
}

function saveCache(cache) {
  try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8'); }
  catch (e) { console.warn('Could not save geo cache:', e.message); }
}

async function geocodeAllEvents(events, cache) {
  const seen = new Set();
  const missing = [];
  for (const ev of events) {
    if (ev.lat === 0 && ev.lon === 0) continue;
    const k = cacheKey(ev.lat, ev.lon);
    if (!cache[k] && !seen.has(k)) { seen.add(k); missing.push({ lat: ev.lat, lon: ev.lon, k }); }
  }
  if (!missing.length) { console.log('Geo cache: all coordinates resolved, skipping Nominatim.'); return; }
  const secs = Math.ceil(missing.length * NOMINATIM_DELAY_MS / 1000);
  console.log(`Geo cache: ${missing.length} new coordinates to resolve (~${secs}s at 1 req/s)...`);
  for (let i = 0; i < missing.length; i++) {
    const { lat, lon, k } = missing[i];
    cache[k] = await nominatimReverse(lat, lon) || {};
    if ((i + 1) % 50 === 0 || i === missing.length - 1) {
      console.log(`  Geocoded ${i + 1}/${missing.length}...`);
      saveCache(cache);
    }
    if (i < missing.length - 1) await sleep(NOMINATIM_DELAY_MS);
  }
  saveCache(cache);
  console.log('Geo cache: saved.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function slugify(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function ensure(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function centroid(events) {
  if (!events.length) return { lat: 51.5, lon: -0.1 };
  return {
    lat: events.reduce((s, e) => s + e.lat, 0) / events.length,
    lon: events.reduce((s, e) => s + e.lon, 0) / events.length,
  };
}

function getExploreSubfolder(slug) {
  const c = slug.charAt(0).toLowerCase();
  return (c >= 'a' && c <= 'z') ? c.toUpperCase() : '0-9';
}

// ---------------------------------------------------------------------------
// Coordinate encryption — identical to generate-events.js
// ---------------------------------------------------------------------------
function eventSeed(name) {
  let h = 0x12345678;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x9e3779b9);
    h ^= h >>> 16;
  }
  return Math.abs(h) % 0xFFFFFF;
}

function encryptCoords(coords, seed) {
  const flat = [];
  let s = seed & 0xFFFFFFFF;
  for (const [lng, lat] of coords) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    flat.push(Math.round(lng * 1e6) ^ (s & 0xFFFFFF));
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    flat.push(Math.round(lat * 1e6) ^ (s & 0xFFFFFF));
  }
  return Buffer.from(JSON.stringify(flat)).toString('base64');
}

// Inlined decrypt function — same as in generate-events.js
function decryptFnJs() {
  return `function _d(b,s){const f=JSON.parse(atob(b));const r=[];let v=s>>>0;for(let i=0;i<f.length;i+=2){v=(Math.imul(v,1664525)+1013904223)>>>0;const lng=(f[i]^(v&0xFFFFFF))/1e6;v=(Math.imul(v,1664525)+1013904223)>>>0;const lat=(f[i+1]^(v&0xFFFFFF))/1e6;r.push([lng,lat]);}return r;}`;
}

// ---------------------------------------------------------------------------
// Shared page structure — identical to generate-events.js
// ---------------------------------------------------------------------------

// Exact <head> block matching the original site
function htmlHead({ title, description, canonicalUrl, lat, lon, locationName, breadcrumbItems = [] }) {
  const plainTitle = title.replace(/&amp;/g, '&');
  const plainDesc  = description.replace(/&amp;/g, '&');

  // BreadcrumbList schema — always include site root + any passed items
  const allCrumbs = [
    { name: 'parkrunner tourist', url: 'https://jake-lofthouse.github.io/Event-Web-Test/' },
    { name: 'Locations',          url: `${BASE_LOCATIONS_URL}/` },
    ...breadcrumbItems,
  ];
  const breadcrumbSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: allCrumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  });

  // WebPage schema
  const webPageSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: plainTitle,
    description: plainDesc,
    url: canonicalUrl,
    ...(lat != null ? { spatialCoverage: { '@type': 'Place', name: locationName, geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lon } } } : {}),
    publisher: { '@type': 'Organization', name: 'parkrunner tourist', url: 'https://www.parkrunnertourist.com' },
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta name="author" content="Jake Lofthouse" />
${lat != null ? `<meta name="geo.placename" content="${locationName}" />
<meta name="geo.position" content="${lat};${lon}" />` : ''}
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${canonicalUrl}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="parkrunner tourist" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="robots" content="index, follow" />
<meta name="language" content="en" />
<link rel="canonical" href="${canonicalUrl}" />
<link rel="sitemap" type="application/xml" href="${BASE_LOCATIONS_URL}/sitemap.xml" />
<script type="application/ld+json">${breadcrumbSchema}</script>
<script type="application/ld+json">${webPageSchema}</script>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.2.1/css/all.min.css">
<meta name="apple-itunes-app" content="app-id=6743163993, app-argument=https://www.parkrunnertourist.com">
<link rel="icon" type="image/x-icon" href="https://parkrunnertourist.com/favicon.ico">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-REFFZSK4XK"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-REFFZSK4XK');
</script>
</head>`;
}

// Exact header from generate-events.js (non-junior variant — location pages are always non-junior)
function htmlHeader() {
  return `<header>
  <a href="https://www.parkrunnertourist.com" target="_self">${SITE_NAME}</a>
  <a href="https://www.parkrunnertourist.com/webapp" target="_blank" class="header-map-btn">Show Full Map</a>
</header>`;
}

// Exact footer from generate-events.js
function htmlFooter() {
  return `<div class="download-footer">
  Download The App
  <div class="app-badges">
    <a href="https://apps.apple.com/gb/app/parkrunner-tourist/id6743163993" target="_blank" rel="noopener noreferrer">
      <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="Download on the App Store" />
    </a>
    <a href="https://play.google.com/store/apps/details?id=appinventor.ai_jlofty8.parkrunner_tourist" target="_blank" rel="noopener noreferrer">
      <img src="https://upload.wikimedia.org/wikipedia/commons/7/78/Google_Play_Store_badge_EN.svg" alt="Get it on Google Play" />
    </a>
  </div>
</div>
<footer>
  <p style="max-width:900px;margin:0 auto 1rem auto;font-size:0.85rem;line-height:1.5;color:#64748b;">
    parkrun is a registered trademark of parkrun Limited.
    This website is independent and is not affiliated with or endorsed by parkrun.
  </p>
  &copy; ${new Date().getFullYear()} ${SITE_NAME}
</footer>
<script data-name="BMC-Widget" data-cfasync="false" src="https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js"
  data-id="jlofthouse" data-description="Support me on Buy me a coffee!"
  data-message="Support The App" data-color="#40DCA5" data-position="Right"
  data-x_margin="18" data-y_margin="18"></script>`;
}

// Exact CSS from generate-events.js (non-junior palette)
function sharedStyles() {
  return `<style>
* { box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  margin: 0; padding: 0;
  background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
  line-height: 1.6;
}
header {
  background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%);
  color: white; padding: 1.5rem 2rem; font-weight: 600; font-size: 1.75rem;
  display: flex; justify-content: space-between; align-items: center;
  box-shadow: 0 4px 20px rgba(46,125,50,0.3);
  position: relative; overflow: hidden;
}
header::before {
  content: ''; position: absolute; top:0;left:0;right:0;bottom:0;
  background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="80" cy="40" r="1.5" fill="rgba(255,255,255,0.1)"/><circle cx="40" cy="80" r="1" fill="rgba(255,255,255,0.1)"/></svg>');
  pointer-events: none;
}
header a { color:white;text-decoration:none;cursor:pointer;position:relative;z-index:1;transition:transform 0.3s ease; }
header a:hover { transform: translateY(-2px); }
.header-map-btn {
  padding: 0.5rem 1.25rem; background: rgba(255,255,255,0.2);
  border: 2px solid white; border-radius: 0.5rem; color: white;
  font-weight: 600; font-size: 1rem; cursor: pointer; transition: all 0.3s ease;
  position: relative; z-index: 1; text-decoration: none; display: inline-block;
}
.header-map-btn:hover { background: white; color: #2e7d32; transform: translateY(-2px); }
main { padding: 3rem 2rem; max-width: 1400px; margin: 0 auto; }
.page-title {
  font-size: 3.5rem; font-weight: 800; margin-bottom: 0.5rem;
  background: linear-gradient(135deg, #2e7d32, #4caf50);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  text-align: center; padding: 2rem 0 0.5rem; line-height: 1.2;
}
.page-subtitle { text-align: center; color: #64748b; font-size: 1.05rem; margin-bottom: 2.5rem; }
.section-title {
  font-size: 1.4rem; font-weight: 600; margin-bottom: 1rem;
  color: #1f2937; display: flex; align-items: center; gap: 0.5rem;
}
.section-title::before {
  content: ''; width: 4px; height: 1.5rem;
  background: linear-gradient(135deg, #4caf50, #2e7d32); border-radius: 2px;
}
/* Breadcrumb */
.breadcrumb {
  font-size: 0.875rem; color: #64748b; padding: 0.75rem 2rem;
  background: white; border-bottom: 1px solid #e2e8f0;
  display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;
}
.breadcrumb a { color: #4caf50; text-decoration: none; font-weight: 500; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb-sep { opacity: 0.4; }
/* Stat bar */
.stats-bar {
  display: flex; gap: 2rem; margin-bottom: 2.5rem; flex-wrap: wrap;
  background: white; border-radius: 1rem; padding: 1.25rem 1.75rem;
  box-shadow: 0 4px 20px rgba(0,0,0,0.07); border: 1px solid rgba(76,175,80,0.15);
}
.stat { display: flex; flex-direction: column; }
.stat-value { font-size: 1.75rem; font-weight: 800; color: #2e7d32; line-height: 1; }
.stat-label { font-size: 0.775rem; color: #64748b; margin-top: 0.2rem; font-weight: 500; }
/* Region / city tile grid */
.tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1rem; margin-bottom: 3rem; }
.tile {
  background: white; border: 1px solid rgba(76,175,80,0.2); border-radius: 0.875rem;
  padding: 1.1rem 1.3rem; display: flex; align-items: center; justify-content: space-between;
  transition: box-shadow 0.2s, transform 0.2s; text-decoration: none; color: inherit;
}
.tile:hover { box-shadow: 0 6px 24px rgba(46,125,50,0.15); transform: translateY(-2px); }
.tile-name { font-weight: 600; font-size: 0.975rem; color: #1f2937; }
.tile-count {
  background: #e8f5e9; color: #2e7d32;
  font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 99px; flex-shrink: 0;
}
/* Search */
.search-wrap { position: relative; margin-bottom: 1.75rem; }
.search-icon { position: absolute; left: 0.9rem; top: 50%; transform: translateY(-50%); color: #94a3b8; font-size: 0.9rem; pointer-events: none; }
.search-input {
  width: 100%; padding: 0.75rem 1rem 0.75rem 2.6rem;
  border: 1.5px solid #e2e8f0; border-radius: 0.75rem;
  font-family: 'Inter', sans-serif; font-size: 1rem; background: white; outline: none; transition: border 0.2s;
}
.search-input:focus { border-color: #4caf50; }
/* Event cards */
.event-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem; }
.event-card {
  background: white; border-radius: 1rem; overflow: hidden;
  box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 1px solid rgba(76,175,80,0.15);
  display: flex; flex-direction: column; transition: box-shadow 0.25s, transform 0.25s;
}
.event-card:hover { box-shadow: 0 8px 32px rgba(46,125,50,0.18); transform: translateY(-3px); }
.card-map-wrap {
  height: 200px; position: relative; background: #e8f5e9; flex-shrink: 0; overflow: hidden;
}
.card-map-inner { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.card-map-badges {
  position: absolute; bottom: 8px; left: 8px; z-index: 10; display: flex; gap: 5px;
}
.card-map-badge {
  border-radius: 7px; padding: 2px 8px; font-size: 11px; font-weight: 700; color: #fff;
}
.card-map-badge.start { background: #28a745; }
.card-map-badge.finish { background: #dc3545; }
.card-body { padding: 1rem 1.1rem; flex: 1; display: flex; flex-direction: column; gap: 0.35rem; }
.card-name { font-weight: 700; font-size: 1rem; color: #1f2937; line-height: 1.3; }
.card-location { font-size: 0.825rem; color: #64748b; display: flex; align-items: center; gap: 0.35rem; }
.card-badges { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: auto; padding-top: 0.5rem; }
.card-badge {
  font-size: 0.72rem; font-weight: 600; padding: 0.2rem 0.55rem;
  border-radius: 99px; background: #e8f5e9; color: #2e7d32;
}
.card-badge.junior { background: #e0f7fa; color: #006064; }
.card-cta {
  display: block; margin: 0.75rem 1.1rem 1rem;
  padding: 0.6rem 1rem; text-align: center;
  background: linear-gradient(135deg, #4caf50, #2e7d32);
  color: white; border-radius: 0.75rem; font-weight: 600; font-size: 0.875rem;
  text-decoration: none; transition: opacity 0.2s, transform 0.2s;
}
.card-cta:hover { opacity: 0.88; transform: translateY(-1px); }
/* Hotel CTA banner */
.hotel-cta {
  background: linear-gradient(135deg, #2e7d32, #1b5e20);
  border-radius: 1rem; padding: 1.75rem 2rem;
  display: flex; align-items: center; justify-content: space-between;
  gap: 1.5rem; margin-bottom: 2.5rem; flex-wrap: wrap;
  box-shadow: 0 4px 20px rgba(46,125,50,0.25);
}
.hotel-cta-text h2 { font-size: 1.35rem; font-weight: 700; color: white; margin-bottom: 0.25rem; }
.hotel-cta-text p { font-size: 0.9rem; color: rgba(255,255,255,0.78); }
.hotel-cta-btn {
  background: white; color: #2e7d32; font-weight: 700; font-size: 0.95rem;
  padding: 0.75rem 1.75rem; border-radius: 0.75rem; white-space: nowrap;
  border: none; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; flex-shrink: 0;
  font-family: 'Inter', sans-serif;
}
.hotel-cta-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
/* Country cards */
.country-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 1.25rem; }
.country-card {
  background: white; border: 1px solid rgba(76,175,80,0.2); border-radius: 1rem;
  padding: 1.4rem 1.5rem; text-decoration: none; color: inherit;
  transition: box-shadow 0.2s, transform 0.2s; display: block;
}
.country-card:hover { box-shadow: 0 6px 24px rgba(46,125,50,0.15); transform: translateY(-2px); }
.country-card h3 { font-weight: 700; font-size: 1.05rem; color: #1f2937; margin-bottom: 0.25rem; }
.country-card p { font-size: 0.85rem; color: #64748b; }
/* Download footer */
.download-footer {
  background: linear-gradient(135deg, #4caf50 0%, #2e7d32 100%);
  padding: 3rem 2rem; display: flex; flex-direction: column; align-items: center; gap: 1.5rem;
  color: white; font-weight: 700; font-size: 1.3rem; text-transform: uppercase; letter-spacing: 1px;
}
.app-badges { display: flex; gap: 2rem; }
.download-footer img { height: 70px; width: auto; transition: transform 0.3s ease; cursor: pointer; border-radius: 0.5rem; }
.download-footer img:hover { transform: scale(1.1) translateY(-4px); }
footer { text-align: center; padding: 2rem; background: #f8fafc; color: #64748b; font-weight: 500; }
.leaflet-control-attribution { display: none !important; }
@media (max-width: 768px) {
  main { padding: 2rem 1rem; }
  .page-title { font-size: 2.25rem; }
  header { padding: 1rem; font-size: 1.3rem; }
  .hotel-cta { flex-direction: column; text-align: center; }
  .hotel-cta-btn { width: 100%; }
  .app-badges { flex-direction: column; gap: 1rem; align-items: center; }
}
</style>`;
}

function breadcrumb(crumbs) {
  // crumbs: [{label, href?}] — last item is current page (no href)
  const home = `<a href="${BASE_LOCATIONS_URL}/">All Locations</a><span class="breadcrumb-sep">/</span>`;
  const parts = crumbs.map((c, i) =>
    i < crumbs.length - 1
      ? `<a href="${c.href}">${c.label}</a><span class="breadcrumb-sep">/</span>`
      : `<span>${c.label}</span>`
  ).join('');
  return `<div class="breadcrumb">${home}${parts}</div>`;
}

// ---------------------------------------------------------------------------
// Stay22 — opens in a new tab (no iframe modal)
// The next-Friday check-in date is computed client-side at click time.
// ---------------------------------------------------------------------------
function stay22Script() {
  return `<script>
function openStay22(lat, lon, name) {
  var d = new Date(), day = d.getDay(), diff = (5 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  var checkin = d.toISOString().slice(0, 10);
  var url = 'https://www.stay22.com/embed/gm?aid=parkrunnertourist'
    + '&lat=' + lat + '&lng=' + lon + '&maincolor=4caf50'
    + '&venue=' + encodeURIComponent(name) + '&checkin=' + checkin
    + '&viewmode=listview&listviewexpand=true';
  window.open(url, '_blank', 'noopener');
}
</script>`;
}

// ---------------------------------------------------------------------------
// Search script
// ---------------------------------------------------------------------------
function searchScript(inputId, itemClass) {
  return `<script>
(function() {
  var inp = document.getElementById('${inputId}');
  if (!inp) return;
  inp.addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    document.querySelectorAll('.${itemClass}').forEach(function(el) {
      el.style.display = (!q || (el.dataset.search || el.textContent).toLowerCase().includes(q)) ? '' : 'none';
    });
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Event card with course preview mini-map
// Exactly mirrors the initCoursePreview logic from generate-events.js
// ---------------------------------------------------------------------------
function eventCardHtml(ev) {
  const { slug, longName, lat, lon, city, isJunior } = ev;
  const subfolder  = getExploreSubfolder(slug);
  const eventUrl   = `${BASE_EXPLORE_URL}/${subfolder}/${slug}`;
  const seed       = eventSeed(ev.eventName);
  const hasRoute   = ev.route && ev.route.length > 1;
  const encRoute   = hasRoute ? encryptCoords(ev.route, seed) : null;
  const mapId      = `cmap-${slug.replace(/[^a-z0-9]/g, '')}`;
  const accent     = isJunior ? ACCENT_JR : ACCENT;
  const cityLabel  = city ? `<span class="card-location"><i class="fas fa-map-marker-alt"></i> ${city}</span>` : '';
  const typeBadge  = isJunior ? `<span class="card-badge junior">Junior parkrun</span>` : '';

  // Build the Leaflet init script — same pattern as initCoursePreview in generate-events.js
  const mapScript = `
(function() {
  ${decryptFnJs()}
  var el = document.getElementById('${mapId}');
  if (!el) return;
  var map = L.map('${mapId}', {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false,
    tap: false, touchZoom: false, attributionControl: false
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(map);
  ${hasRoute ? `
  var route = _d("${encRoute}", ${seed});
  var lls = route.map(function(p) { return [p[1], p[0]]; });
  L.polyline(lls, { color: '${accent}', weight: 3.5, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(map);
  L.circleMarker(lls[0], { radius: 7, fillColor: '${accent}', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
  L.circleMarker(lls[lls.length - 1], { radius: 7, fillColor: '#dc3545', color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
  map.fitBounds(L.latLngBounds(lls), { padding: [20, 20], animate: false });
  ` : `
  map.setView([${lat}, ${lon}], 14);
  L.circleMarker([${lat}, ${lon}], { radius: 8, fillColor: '${accent}', color: '#fff', weight: 2.5, fillOpacity: 1 }).addTo(map);
  `}
})();`;

  return `<div class="event-card" data-search="${longName.toLowerCase()} ${(city || '').toLowerCase()}">
  <div class="card-map-wrap">
    <div id="${mapId}" class="card-map-inner"></div>
    ${hasRoute ? `<div class="card-map-badges">
      <span class="card-map-badge start">&#9679; Start</span>
      <span class="card-map-badge finish">&#9679; Finish</span>
    </div>` : ''}
  </div>
  <div class="card-body">
    <div class="card-name">${longName}</div>
    ${cityLabel}
    <div class="card-badges">${typeBadge}</div>
  </div>
  <a href="${eventUrl}" class="card-cta" target="_blank">View Guide &amp; Hotels</a>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>${mapScript}</script>`;
}

// ---------------------------------------------------------------------------
// Page generators
// ---------------------------------------------------------------------------

function generateWorldIndex(countries) {
  const sorted = Object.entries(countries).sort((a, b) => a[0].localeCompare(b[0]));
  const totalEvents = sorted.reduce((s, [, d]) => s + d.totalEvents, 0);

  const cards = sorted.map(([cSlug, d]) => `
<a href="${BASE_LOCATIONS_URL}/${cSlug}/" class="country-card">
  <h3>${d.name}</h3>
  <p>${d.totalEvents.toLocaleString()} event${d.totalEvents !== 1 ? 's' : ''} &middot; ${d.regions.length} region${d.regions.length !== 1 ? 's' : ''}</p>
</a>`).join('');

  return `${htmlHead({
    title: 'parkrun Events by Location — Find Hotels &amp; Plan Your Visit | parkrunner tourist',
    description: 'Browse parkrun events by country, region and city. Find hotels near every parkrun, view course maps, check weather and plan your perfect parkrun weekend.',
    canonicalUrl: `${BASE_LOCATIONS_URL}/`,
    breadcrumbItems: [],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
<main>
  <h1 class="page-title">Browse by Location</h1>
  <p class="page-subtitle">Find parkrun events near you — browse by country, region and city, then plan your visit with hotels, course maps and weather.</p>
  <div class="stats-bar">
    <div class="stat"><span class="stat-value">${totalEvents.toLocaleString()}</span><span class="stat-label">Events worldwide</span></div>
    <div class="stat"><span class="stat-value">${sorted.length}</span><span class="stat-label">Countries</span></div>
  </div>
  <div class="section-title">Select a country</div>
  <div class="country-grid">${cards}</div>
</main>
${htmlFooter()}
</body></html>`;
}

function generateCountryPage(countrySlug, countryData) {
  const { name, regions, totalEvents } = countryData;
  const c = centroid(regions.flatMap(r => r.events));
  const showSearch = regions.length >= SEARCH_THRESHOLD;

  const tiles = regions
    .sort((a, b) => b.events.length - a.events.length)
    .map(r => `
<a href="${BASE_LOCATIONS_URL}/${countrySlug}/${r.slug}/" class="tile" data-search="${r.name.toLowerCase()}">
  <span class="tile-name">${r.name}</span>
  <span class="tile-count">${r.events.length}</span>
</a>`).join('');

  return `${htmlHead({
    title: `parkrun Events in ${name} — Hotels, Course Maps &amp; Visitor Guides`,
    description: `Find all ${totalEvents} parkrun events across ${name}. Browse by region, view course maps, find hotels near each event and plan your parkrun trip.`,
    canonicalUrl: `${BASE_LOCATIONS_URL}/${countrySlug}/`,
    lat: c.lat, lon: c.lon, locationName: name,
    breadcrumbItems: [{ name, url: `${BASE_LOCATIONS_URL}/${countrySlug}/` }],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([{ label: name }])}
<main>
  <h1 class="page-title">parkrun Events in ${name}</h1>
  <p class="page-subtitle">${totalEvents} parkrun event${totalEvents !== 1 ? 's' : ''} across ${regions.length} region${regions.length !== 1 ? 's' : ''} — find hotels, course maps and visitor guides</p>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Need accommodation in ${name}?</h2>
      <p>Compare hotels and rentals near any parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${c.lat},${c.lon},'${name.replace(/'/g, "\\'")} parkrun')">Find Hotels</button>
  </div>
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="loc-search" class="search-input" type="text" placeholder="Search regions in ${name}..." /></div>` : ''}
  <div class="section-title">Regions</div>
  <div class="tile-grid">${tiles}</div>
</main>
${htmlFooter()}
${stay22Script()}
${showSearch ? searchScript('loc-search', 'tile') : ''}
</body></html>`;
}

function generateRegionPage(countrySlug, countryName, regionSlug, regionData) {
  const { name, cities, events } = regionData;
  const c = centroid(events);
  const showSearch = events.length >= SEARCH_THRESHOLD;
  const hasCities = Object.keys(cities).length > 1;

  const cityTiles = Object.entries(cities)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cSlug, evs]) => {
      const cityName = evs[0].city || cSlug;
      return `<a href="${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/${cSlug}/" class="tile" data-search="${cityName.toLowerCase()}">
  <span class="tile-name">${cityName}</span>
  <span class="tile-count">${evs.length}</span>
</a>`;
    }).join('');

  const cards = events
    .sort((a, b) => a.longName.localeCompare(b.longName))
    .map(ev => eventCardHtml(ev)).join('\n');

  return `${htmlHead({
    title: `parkrun Events in ${name}, ${countryName} — Hotels, Course Maps &amp; Visitor Guides`,
    description: `All ${events.length} parkrun events in ${name}. View course maps, compare hotels near each event, check the weather and plan your perfect parkrun weekend in ${name}.`,
    canonicalUrl: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/`,
    lat: c.lat, lon: c.lon, locationName: `${name}, ${countryName}`,
    breadcrumbItems: [
      { name: countryName, url: `${BASE_LOCATIONS_URL}/${countrySlug}/` },
      { name,              url: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/` },
    ],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([
    { label: countryName, href: `${BASE_LOCATIONS_URL}/${countrySlug}/` },
    { label: name },
  ])}
<main>
  <h1 class="page-title">parkrun Events in ${name}</h1>
  <p class="page-subtitle">${events.length} parkrun event${events.length !== 1 ? 's' : ''} in ${name} — course maps, hotels and visitor guides</p>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Need accommodation in ${name}?</h2>
      <p>Compare hotels and rentals near any ${name} parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${c.lat},${c.lon},'${name.replace(/'/g, "\\'")} parkrun')">Find Hotels</button>
  </div>
  ${hasCities ? `<div class="section-title">Browse by city</div><div class="tile-grid">${cityTiles}</div>` : ''}
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="evt-search" class="search-input" type="text" placeholder="Search events in ${name}..." /></div>` : ''}
  <div class="section-title">All events in ${name}</div>
  <div class="event-grid">${cards}</div>
</main>
${htmlFooter()}
${stay22Script()}
${showSearch ? searchScript('evt-search', 'event-card') : ''}
</body></html>`;
}

function generateCityPage(countrySlug, countryName, regionSlug, regionName, citySlug, cityEvents) {
  const cityName = cityEvents[0].city || citySlug;
  const c = centroid(cityEvents);
  const showSearch = cityEvents.length >= SEARCH_THRESHOLD;

  const cards = cityEvents
    .sort((a, b) => a.longName.localeCompare(b.longName))
    .map(ev => eventCardHtml(ev)).join('\n');

  return `${htmlHead({
    title: `parkrun Events in ${cityName} — Hotels Near Each Event &amp; Course Maps`,
    description: `${cityEvents.length} parkrun event${cityEvents.length !== 1 ? 's' : ''} in ${cityName}, ${regionName}. View course maps for every event, find hotels nearby and plan your parkrun visit to ${cityName}.`,
    canonicalUrl: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/${citySlug}/`,
    lat: c.lat, lon: c.lon, locationName: `${cityName}, ${regionName}`,
    breadcrumbItems: [
      { name: countryName, url: `${BASE_LOCATIONS_URL}/${countrySlug}/` },
      { name: regionName,  url: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/` },
      { name: cityName,    url: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/${citySlug}/` },
    ],
  })}
<body>
${sharedStyles()}
${htmlHeader()}
${breadcrumb([
    { label: countryName, href: `${BASE_LOCATIONS_URL}/${countrySlug}/` },
    { label: regionName,  href: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/` },
    { label: cityName },
  ])}
<main>
  <h1 class="page-title">parkrun Events in ${cityName}</h1>
  <p class="page-subtitle">${cityEvents.length} parkrun event${cityEvents.length !== 1 ? 's' : ''} in ${cityName} — course maps, hotels and visitor guides</p>
  <div class="hotel-cta">
    <div class="hotel-cta-text">
      <h2>Staying in ${cityName}?</h2>
      <p>Find hotels and rentals near your parkrun event.</p>
    </div>
    <button class="hotel-cta-btn" onclick="openStay22(${c.lat},${c.lon},'${cityName.replace(/'/g, "\\'")} parkrun')">Find Hotels</button>
  </div>
  ${showSearch ? `<div class="search-wrap"><i class="fas fa-search search-icon"></i><input id="evt-search" class="search-input" type="text" placeholder="Search events in ${cityName}..." /></div>` : ''}
  <div class="section-title">Events in ${cityName}</div>
  <div class="event-grid">${cards}</div>
</main>
${htmlFooter()}
${stay22Script()}
${showSearch ? searchScript('evt-search', 'event-card') : ''}
</body></html>`;
}

// ---------------------------------------------------------------------------
// Sitemap generator
// Writes /locations/sitemap.xml listing every location page.
// Priority: world index 1.0, country 0.9, region 0.8, city 0.7
// changefreq: weekly (event count can change as new events open)
// ---------------------------------------------------------------------------
function generateSitemap(hierarchy) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [];

  // World index
  urls.push({ loc: `${BASE_LOCATIONS_URL}/`, priority: '1.0' });

  for (const [countrySlug, countryData] of Object.entries(hierarchy)) {
    urls.push({ loc: `${BASE_LOCATIONS_URL}/${countrySlug}/`, priority: '0.9' });

    for (const [regionSlug, regionData] of Object.entries(countryData.regions)) {
      urls.push({ loc: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/`, priority: '0.8' });

      for (const [citySlug] of Object.entries(regionData.cities)) {
        if (citySlug === regionSlug) continue;
        urls.push({ loc: `${BASE_LOCATIONS_URL}/${countrySlug}/${regionSlug}/${citySlug}/`, priority: '0.7' });
      }
    }
  }

  const entries = urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
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
  } catch (e) { console.warn('Could not load course maps:', e.message); }

  const limited = EVENT_LIMIT > 0 ? events.slice(0, EVENT_LIMIT) : events;
  console.log(`Processing ${limited.length} events...`);

  // Build minimal list for geocoding pass
  const rawEvents = limited.map(ev => {
    const props  = ev.properties || {};
    const coords = (ev.geometry && ev.geometry.coordinates) || [0, 0];
    return {
      eventName:   props.eventname || '',
      longName:    props.EventLongName || props.eventname || '',
      slug:        slugify(props.eventname || ''),
      countryCode: String(props.countrycode || '0'),
      lat:         coords[1] || 0,
      lon:         coords[0] || 0,
    };
  });

  // Resolve coordinates via Nominatim (cache-first)
  const cache = loadCache();
  await geocodeAllEvents(rawEvents, cache);

  // Enrich with geocoded admin data + course routes
  const enriched = rawEvents.map(ev => {
    const address = cache[cacheKey(ev.lat, ev.lon)] || null;
    const { city, region } = extractFromAddress(address, ev.countryCode);
    const isJunior = ev.longName.toLowerCase().includes('junior');

    const courseKey = Object.keys(courseMaps).find(k =>
      k === ev.eventName ||
      k === ev.eventName.toLowerCase() ||
      k === ev.slug ||
      k.replace(/-/g, '').toLowerCase() === ev.eventName.replace(/\s+/g, '').toLowerCase()
    );
    const courseData = courseKey ? courseMaps[courseKey] : null;
    const route = (courseData && Array.isArray(courseData.route) && courseData.route.length > 1)
      ? courseData.route : null;

    return { ...ev, isJunior, city, region, route };
  });

  // Build 3-tier hierarchy
  const hierarchy = {};
  for (const ev of enriched) {
    const meta        = COUNTRY_META[ev.countryCode] || { name: 'Unknown' };
    const countrySlug = slugify(meta.name);
    const regionName  = ev.region || meta.name;
    const regionSlug  = slugify(regionName);
    const cityName    = ev.city || regionName;
    const citySlug    = slugify(cityName);

    if (!hierarchy[countrySlug]) hierarchy[countrySlug] = { name: meta.name, regions: {}, totalEvents: 0 };
    hierarchy[countrySlug].totalEvents++;

    const regions = hierarchy[countrySlug].regions;
    if (!regions[regionSlug]) regions[regionSlug] = { name: regionName, slug: regionSlug, cities: {}, events: [] };
    regions[regionSlug].events.push(ev);

    const cities = regions[regionSlug].cities;
    if (!cities[citySlug]) cities[citySlug] = [];
    cities[citySlug].push(ev);
  }

  // Write all HTML files (each page is index.html inside a slug-named folder)
  ensure(OUTPUT_DIR);

  const countryList = Object.fromEntries(
    Object.entries(hierarchy).map(([cs, cd]) => [cs, {
      name: cd.name, totalEvents: cd.totalEvents, regions: Object.values(cd.regions),
    }])
  );

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), generateWorldIndex(countryList), 'utf-8');
  console.log('Generated: locations/index.html');
  let pageCount = 1;

  for (const [countrySlug, countryData] of Object.entries(hierarchy)) {
    const countryDir = path.join(OUTPUT_DIR, countrySlug);
    ensure(countryDir);

    fs.writeFileSync(
      path.join(countryDir, 'index.html'),
      generateCountryPage(countrySlug, { ...countryData, regions: Object.values(countryData.regions) }),
      'utf-8'
    );
    console.log(`Generated: locations/${countrySlug}/`);
    pageCount++;

    for (const [regionSlug, regionData] of Object.entries(countryData.regions)) {
      const regionDir = path.join(countryDir, regionSlug);
      ensure(regionDir);

      fs.writeFileSync(
        path.join(regionDir, 'index.html'),
        generateRegionPage(countrySlug, countryData.name, regionSlug, regionData),
        'utf-8'
      );
      console.log(`Generated: locations/${countrySlug}/${regionSlug}/`);
      pageCount++;

      for (const [citySlug, cityEvents] of Object.entries(regionData.cities)) {
        // Skip if city slug same as region slug (avoids duplicate single-city regions)
        if (citySlug === regionSlug || !cityEvents.length) continue;

        const cityDir = path.join(regionDir, citySlug);
        ensure(cityDir);
        fs.writeFileSync(
          path.join(cityDir, 'index.html'),
          generateCityPage(countrySlug, countryData.name, regionSlug, regionData.name, citySlug, cityEvents),
          'utf-8'
        );
        console.log(`Generated: locations/${countrySlug}/${regionSlug}/${citySlug}/`);
        pageCount++;
      }
    }
  }

  console.log(`\nDone. ${pageCount} location pages generated in ./locations/`);

  // Write sitemap
  fs.writeFileSync(path.join(OUTPUT_DIR, 'sitemap.xml'), generateSitemap(hierarchy), 'utf-8');
  console.log(`Sitemap: locations/sitemap.xml (${pageCount} URLs)`);
}

main().catch(err => { console.error(err); process.exit(1); });
