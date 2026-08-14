// utils/proximity.js
// Ghana-aware proximity calculation for BeyondX.
//
// Two-stage geocoding:
//   1. Local lookup table (fast, offline, ~150 Greater Accra locations)
//   2. Nominatim fallback for anything not in the table (async only)
//
// Transport tiers (2026 Accra fares):
//   Tier 1 — Local       (0–10km road)   GH₵8   — metro area, small flat
//   Tier 2 — Regional    (10–40km road)  GH₵40  — round-trip trotro + transfer
//   Tier 3 — Extended    (40–80km road)  GH₵90  — intercity bus round trip + buffer
//   Tier 4 — Intercity   (80km+  road)   GH₵200 — full bus fare + food + transit day

const ROAD_FACTOR = 1.4;
const INTERCITY_MIN_JOB_VALUE = 200;

const TIERS = {
  local:    { label: 'Local',            maxRoadKm: 10,       allowance: 8,   description: 'Metro area — small flat contribution' },
  regional: { label: 'Regional',         maxRoadKm: 40,       allowance: 40,  description: 'Cross-suburb — round-trip trotro with transfer' },
  extended: { label: 'Extended regional',maxRoadKm: 80,       allowance: 90,  description: 'Intercity bus round trip plus waiting and taxi buffer' },
  intercity:{ label: 'Intercity',        maxRoadKm: Infinity, allowance: 200, description: 'Full round-trip bus fare, food, and transit day compensation' },
};

const AREA_COORDS = {
  // ── Central Accra ─────────────────────────────────────────────────────────
  'accra':                  [5.5600, -0.2050],
  'accra central':          [5.5500, -0.2167],
  'accra cbd':              [5.5500, -0.2167],
  'osu':                    [5.5530, -0.1736],
  'osu oxford street':      [5.5530, -0.1736],
  'labadi':                 [5.5565, -0.1599],
  'labadi beach':           [5.5560, -0.1590],
  'cantonments':            [5.5694, -0.1795],
  'airport residential':    [5.6050, -0.1750],
  'airport city':           [5.6000, -0.1680],
  'kotoka':                 [5.6050, -0.1668],
  'labone':                 [5.5628, -0.1723],
  'ridge':                  [5.5778, -0.2003],
  'adabraka':               [5.5665, -0.2150],
  'ring road':              [5.5756, -0.2072],
  'roman ridge':            [5.5800, -0.1900],
  'kanda':                  [5.5790, -0.2100],
  'north ridge':            [5.5800, -0.2050],
  'ministries':             [5.5600, -0.2000],
  'victoriaborg':           [5.5467, -0.2017],
  'jamestown':              [5.5386, -0.2108],
  'usher town':             [5.5420, -0.2050],
  // ── Inner north ───────────────────────────────────────────────────────────
  'dzorwulu':               [5.5994, -0.2028],
  'north dzorwulu':         [5.6050, -0.2050],
  'abelemkpe':              [5.5900, -0.2150],
  'north kaneshie':         [5.5556, -0.2489],
  'kaneshie':               [5.5556, -0.2400],
  'abossey okai':           [5.5450, -0.2350],
  'kwashieman':             [5.5700, -0.2600],
  'santa maria':            [5.5800, -0.2500],
  'tantra hill':            [5.5980, -0.2400],
  'nii boi town':           [5.5900, -0.2350],
  'odokor':                 [5.5450, -0.2750],
  'odorkor':                [5.5450, -0.2750],
  'darkuman':               [5.5611, -0.2667],
  'bubuashie':              [5.5556, -0.2556],
  'lapaz':                  [5.5897, -0.2567],
  'ablekuma':               [5.5483, -0.2825],
  'awoshie':                [5.5700, -0.2850],
  'ofankor':                [5.6200, -0.2700],
  'taifa':                  [5.6300, -0.2500],
  'taifa barrier':          [5.6350, -0.2550],
  // ── North / East Legon corridor ───────────────────────────────────────────
  'madina':                 [5.6720, -0.1683],
  'medina':                 [5.6720, -0.1683],
  'east legon':             [5.6360, -0.1610],
  'east legon hills':       [5.6500, -0.1500],
  'legon':                  [5.6502, -0.1869],
  'university of ghana':    [5.6502, -0.1869],
  'haatso':                 [5.6780, -0.2110],
  'dome':                   [5.6900, -0.2278],
  'kwabenya':               [5.7310, -0.2036],
  'atomic':                 [5.6972, -0.1814],
  'atomic junction':        [5.6972, -0.1814],
  'achimota':               [5.6136, -0.2289],
  'achimota school':        [5.6100, -0.2250],
  'pokuase':                [5.7700, -0.2700],
  'pokuase junction':       [5.7600, -0.2800],
  'medie':                  [5.7850, -0.3050],
  'amasaman':               [5.8200, -0.3400],
  'ashesi university':      [5.7598, -0.2204],
  'berekuso':               [5.7560, -0.2170],
  'adjiringanor':           [5.6550, -0.1450],
  'shiashie':               [5.6250, -0.1700],
  'lakeside':               [5.6600, -0.1400],
  'lakeside estate':        [5.6600, -0.1400],
  'frafraha':               [5.7000, -0.1500],
  'oyarifa':                [5.7200, -0.1350],
  'abokobi':                [5.7450, -0.1600],
  'pantang':                [5.7200, -0.1850],
  'adenta':                 [5.6906, -0.1772],
  'adenta housing':         [5.6950, -0.1800],
  'ashale botwe':           [5.6800, -0.1350],
  'oyibi':                  [5.7600, -0.0900],
  'dodowa':                 [5.8928, -0.0297],
  'dodowa road':            [5.7900, -0.1100],
  // ── Dansoman / West ───────────────────────────────────────────────────────
  'dansoman':               [5.5300, -0.2650],
  'dansoman roundabout':    [5.5280, -0.2680],
  'mamprobi':               [5.5350, -0.2450],
  'korle-bu':               [5.5378, -0.2278],
  'korle bu':               [5.5378, -0.2278],
  'weija':                  [5.5667, -0.3500],
  'kasoa':                  [5.5333, -0.4167],
  'mccarthy hill':          [5.5400, -0.3050],
  'west hills mall':        [5.5450, -0.3200],
  'sowutuom':               [5.5750, -0.2750],
  // ── Tema corridor / East ──────────────────────────────────────────────────
  'tema':                   [5.6698, -0.0166],
  'tema community 1':       [5.6667, -0.0167],
  'community 1':            [5.6667, -0.0167],
  'community 5':            [5.6780, -0.0280],
  'community 7':            [5.6850, -0.0500],
  'community 9':            [5.7000, -0.0400],
  'community 18':           [5.6900, -0.0450],
  'community 25':           [5.7089, -0.0028],
  'comm 25':                [5.7089, -0.0028],
  'ashaiman':               [5.6953, -0.0328],
  'ashiaman':               [5.6953, -0.0328],
  'teshie':                 [5.5912, -0.1378],
  'teshie nungua':          [5.5900, -0.1200],
  'nungua':                 [5.5897, -0.1108],
  'nungua beach':           [5.5880, -0.1050],
  'spintex':                [5.6208, -0.1311],
  'spintex road':           [5.6200, -0.1300],
  'baatsona':               [5.6350, -0.1050],
  'sakumono':               [5.6361, -0.0417],
  'lashibi':                [5.6178, -0.0808],
  'kpone':                  [5.7050,  0.0300],
  'afienya':                [5.7800,  0.0600],
  'trasacco':               [5.6650, -0.1300],
  'trasacco valley':        [5.6650, -0.1300],
  // ── Nima / inner east ─────────────────────────────────────────────────────
  'nima':                   [5.5839, -0.2197],
  'mamobi':                 [5.5850, -0.2150],
  'maamobi':                [5.5850, -0.2150],
  'accra new town':         [5.5750, -0.2300],
  'new town':               [5.5750, -0.2300],
  'asylum down':            [5.5700, -0.2200],
  'kokomlemle':             [5.5780, -0.2100],
  // ── Outer Greater Accra ───────────────────────────────────────────────────
  'nsawam':                 [5.8035, -0.3480],
  'aburi':                  [5.8469, -0.1769],
  'aburi gardens':          [5.8530, -0.1730],
  'suhum':                  [6.0417, -0.4528],
  'koforidua':              [6.0942, -0.2614],
  // ── Intercity destinations ────────────────────────────────────────────────
  'ho':                     [6.6011,  0.4712],
  'kumasi':                 [6.6884, -1.6244],
  'takoradi':               [4.8845, -1.7554],
  'cape coast':             [5.1053, -1.2466],
  'tamale':                 [9.4035, -0.8424],
  'bolgatanga':             [10.7856, -0.8514],
  'wa':                     [10.0601, -2.5099],
  'sunyani':                [7.3349, -2.3266],
  'techiman':               [7.5924, -1.9348],
  'kintampo':               [8.0509, -1.7295],
  'nkawkaw':                [6.5483, -0.7649],
  'konongo':                [6.6167, -1.2167],
  'keta':                   [5.9120,  0.9987],
  'aflao':                  [6.1167,  1.1833],
};

function coordsForArea(areaText) {
  if (!areaText) return null;
  const t = areaText.toLowerCase().trim();
  if (AREA_COORDS[t]) return AREA_COORDS[t];
  // Substring match — handles "Tema Community 5", "Accra Mall" etc.
  for (const [key, coords] of Object.entries(AREA_COORDS)) {
    if (t.includes(key) || key.includes(t)) return coords;
  }
  return null;
}

// Async Nominatim fallback — used by the /api/workers/proximity endpoint
// when the local table has no match. Biased to Ghana.
async function geocodeViaNominatim(areaText) {
  try {
    const q = encodeURIComponent(`${areaText}, Ghana`);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=gh`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BeyondX/1.0 (beyondxco.com)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data?.[0]) return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch { /* network error or timeout — fall through */ }
  return null;
}

function haversineKm([lat1, lng1], [lat2, lng2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tierFromRoadKm(roadKm) {
  let tierKey;
  if      (roadKm < 10) tierKey = 'local';
  else if (roadKm < 40) tierKey = 'regional';
  else if (roadKm < 80) tierKey = 'extended';
  else                  tierKey = 'intercity';
  return { tierKey, ...TIERS[tierKey] };
}

function buildResult(workerCoords, jobCoords) {
  const distanceKm = haversineKm(workerCoords, jobCoords);
  const roadKm     = distanceKm * ROAD_FACTOR;
  const { tierKey, label, allowance, description } = tierFromRoadKm(roadKm);
  return {
    available:           true,
    distanceKm:          Math.round(distanceKm * 10) / 10,
    roadKm:              Math.round(roadKm * 10) / 10,
    transportAllowance:  allowance,
    tier:                tierKey,
    tierLabel:           label,
    tierDescription:     description,
    isIntercity:         tierKey === 'intercity',
    overnightNote:       roadKm > 120,
    intercityMinJobValue: INTERCITY_MIN_JOB_VALUE,
  };
}

// Sync version — uses local table only. Used inside backend task creation
// where we can't await (inside Prisma $transaction map).
function calcProximity(workerHomeArea, jobLocation) {
  const workerCoords = coordsForArea(workerHomeArea);
  const jobCoords    = coordsForArea(jobLocation);
  if (!workerCoords || !jobCoords) {
    return { available: false, distanceKm: null, roadKm: null, transportAllowance: 0,
             tier: 'unknown', tierLabel: 'Unknown', isIntercity: false, overnightNote: false };
  }
  return buildResult(workerCoords, jobCoords);
}

// Async version — tries local table first, falls back to Nominatim for both
// worker home and job location. Used by GET /api/workers/proximity.
async function calcProximityAsync(workerHomeArea, jobLocation) {
  let workerCoords = coordsForArea(workerHomeArea);
  let jobCoords    = coordsForArea(jobLocation);

  // Nominatim fallback for whichever side wasn't in the table
  if (!workerCoords) workerCoords = await geocodeViaNominatim(workerHomeArea);
  if (!jobCoords)    jobCoords    = await geocodeViaNominatim(jobLocation);

  if (!workerCoords || !jobCoords) {
    return { available: false, distanceKm: null, roadKm: null, transportAllowance: 0,
             tier: 'unknown', tierLabel: 'Unknown', isIntercity: false, overnightNote: false };
  }
  return buildResult(workerCoords, jobCoords);
}

module.exports = { calcProximity, calcProximityAsync, coordsForArea, AREA_COORDS, TIERS, INTERCITY_MIN_JOB_VALUE };
