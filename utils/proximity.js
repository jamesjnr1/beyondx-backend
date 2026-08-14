// utils/proximity.js
// Ghana-aware proximity calculation for BeyondX.
//
// Approach: text neighbourhood/city name → approximate lat/lng from a curated
// lookup table, then Haversine for straight-line distance × 1.4 road factor.
//
// Transport tiers:
//   Tier 1 — Local       (0–10km road)   GH₵0   — metro area, walkable/trotro
//   Tier 2 — Regional    (10–40km road)  GH₵20  — cross-suburb, two trotro legs
//   Tier 3 — Extended    (40–80km road)  GH₵50  — Nsawam/Aburi/Dodowa direction
//   Tier 4 — Intercity   (80km+  road)   GH₵80  — flagged separately; min job
//                                                   value required; overnight note
//
// Intercity jobs (Tier 4) are flagged with isIntercity=true so the UI can:
//   - Show a prominent warning before the worker accepts
//   - Require the job pay to meet INTERCITY_MIN_JOB_VALUE
//   - Surface an overnight note if roundtrip >~4h

const ROAD_FACTOR = 1.4;

// Minimum job pay for intercity dispatch to be offered at all
const INTERCITY_MIN_JOB_VALUE = 150; // GH₵

// Export so frontend can validate
const TIERS = {
  local:    { label: 'Local',            maxRoadKm: 10,  allowance: 0,  description: 'Metro area — no transport charge' },
  regional: { label: 'Regional',         maxRoadKm: 40,  allowance: 20, description: 'Cross-suburb — covers two trotro legs there and back' },
  extended: { label: 'Extended regional',maxRoadKm: 80,  allowance: 50, description: 'Nsawam / Aburi / Dodowa direction — full journey each way' },
  intercity:{ label: 'Intercity',        maxRoadKm: Infinity, allowance: 80, description: 'Long-distance assignment — worker needs full round-trip fare plus time allowance' },
};

const AREA_COORDS = {
  // ── Central / Accra proper ────────────────────────────────────────────────
  'accra':               [5.5600, -0.2050],
  'accra central':       [5.5500, -0.2167],
  'osu':                 [5.5530, -0.1736],
  'labadi':              [5.5565, -0.1599],
  'cantonments':         [5.5694, -0.1795],
  'airport residential': [5.6050, -0.1750],
  'labone':              [5.5628, -0.1723],
  'ridge':               [5.5778, -0.2003],
  'adabraka':            [5.5665, -0.2150],
  'ring road':           [5.5756, -0.2072],
  'north kaneshie':      [5.5556, -0.2489],
  'kaneshie':            [5.5556, -0.2400],
  'abossey okai':        [5.5450, -0.2350],
  // ── North / Peri-urban ───────────────────────────────────────────────────
  'madina':              [5.6720, -0.1683],
  'east legon':          [5.6360, -0.1610],
  'legon':               [5.6502, -0.1869],
  'haatso':              [5.6780, -0.2110],
  'dome':                [5.6900, -0.2278],
  'kwabenya':            [5.7310, -0.2036],
  'atomic':              [5.6972, -0.1814],
  'achimota':            [5.6136, -0.2289],
  'pokuase':             [5.7700, -0.2700],
  'medie':               [5.7850, -0.3050],
  'amasaman':            [5.8200, -0.3400],
  'ashesi university':   [5.7598, -0.2204],
  'berekuso':            [5.7560, -0.2170],
  // ── West / Dansoman corridor ──────────────────────────────────────────────
  'dansoman':            [5.5300, -0.2650],
  'mamprobi':            [5.5350, -0.2450],
  'korle-bu':            [5.5378, -0.2278],
  'bubuashie':           [5.5556, -0.2556],
  'odorkor':             [5.5450, -0.2750],
  'darkuman':            [5.5611, -0.2667],
  'lapaz':               [5.5897, -0.2567],
  'ablekuma':            [5.5483, -0.2825],
  // ── East / Tema corridor ──────────────────────────────────────────────────
  'tema':                [5.6698, -0.0166],
  'tema community 1':    [5.6667, -0.0167],
  'community 25':        [5.7089, -0.0028],
  'ashaiman':            [5.6953, -0.0328],
  'ashiaman':            [5.6953, -0.0328],
  'teshie':              [5.5912, -0.1378],
  'nungua':              [5.5897, -0.1108],
  'community 18':        [5.6900, -0.0450],
  'kpone':               [5.7050,  0.0300],
  'afienya':             [5.7800,  0.0600],
  // ── South / Coast ────────────────────────────────────────────────────────
  'nima':                [5.5839, -0.2197],
  'mamobi':              [5.5850, -0.2150],
  'maamobi':             [5.5850, -0.2150],
  'accra new town':      [5.5750, -0.2300],
  // ── Inner suburbs ────────────────────────────────────────────────────────
  'spintex':             [5.6208, -0.1311],
  'baatsona':            [5.6350, -0.1050],
  'community 7':         [5.6850, -0.0500],
  'community 9':         [5.7000, -0.0400],
  'sakumono':            [5.6361, -0.0417],
  'lashibi':             [5.6178, -0.0808],
  'adenta':              [5.6906, -0.1772],
  // ── Outer Greater Accra / Extended regional ───────────────────────────────
  'kasoa':               [5.5333, -0.4167],
  'weija':               [5.5667, -0.3500],
  'pokuase junction':    [5.7600, -0.2800],
  'nsawam':              [5.8035, -0.3480],
  'dodowa':              [5.8928, -0.0297],
  'aburi':               [5.8469, -0.1769],
  'aburi gardens':       [5.8530, -0.1730],
  'suhum':               [6.0417, -0.4528],
  'koforidua':           [6.0942, -0.2614],
  'sefwi':               [6.1000, -2.6000],
  // ── Intercity destinations ────────────────────────────────────────────────
  'ho':                  [6.6011,  0.4712],
  'kumasi':              [6.6884, -1.6244],
  'takoradi':            [4.8845, -1.7554],
  'cape coast':          [5.1053, -1.2466],
  'tamale':              [9.4035, -0.8424],
  'bolgatanga':          [10.7856, -0.8514],
  'wa':                  [10.0601, -2.5099],
  'sunyani':             [7.3349, -2.3266],
  'techiman':            [7.5924, -1.9348],
  'kintampo':            [8.0509, -1.7295],
  'nkawkaw':             [6.5483, -0.7649],
  'konongo':             [6.6167, -1.2167],
  'salaga':              [8.5520, -0.5139],
  'keta':                [5.9120,  0.9987],
  'aflao':               [6.1167,  1.1833],
};

function coordsForArea(areaText) {
  if (!areaText) return null;
  const t = areaText.toLowerCase().trim();
  if (AREA_COORDS[t]) return AREA_COORDS[t];
  for (const [key, coords] of Object.entries(AREA_COORDS)) {
    if (t.includes(key) || key.includes(t)) return coords;
  }
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

function calcProximity(workerHomeArea, jobLocation) {
  const workerCoords = coordsForArea(workerHomeArea);
  const jobCoords    = coordsForArea(jobLocation);

  if (!workerCoords || !jobCoords) {
    return {
      available: false,
      distanceKm: null,
      roadKm: null,
      transportAllowance: 0,
      tier: 'unknown',
      tierLabel: 'Unknown',
      isIntercity: false,
      meetsIntercityMinimum: null,
      overnightNote: false,
    };
  }

  const distanceKm = haversineKm(workerCoords, jobCoords);
  const roadKm     = distanceKm * ROAD_FACTOR;

  let tierKey, transportAllowance;
  if      (roadKm < 10) { tierKey = 'local';     transportAllowance = 0;  }
  else if (roadKm < 40) { tierKey = 'regional';  transportAllowance = 20; }
  else if (roadKm < 80) { tierKey = 'extended';  transportAllowance = 50; }
  else                  { tierKey = 'intercity';  transportAllowance = 80; }

  const tierInfo  = TIERS[tierKey];
  const isIntercity = tierKey === 'intercity';
  // Overnight likely if one-way road trip exceeds ~80km (typically 2h+ each way)
  const overnightNote = roadKm > 120;

  return {
    available: true,
    distanceKm: Math.round(distanceKm * 10) / 10,
    roadKm: Math.round(roadKm * 10) / 10,
    transportAllowance,
    tier: tierKey,
    tierLabel: tierInfo.label,
    tierDescription: tierInfo.description,
    isIntercity,
    meetsIntercityMinimum: null, // caller checks against actual job pay
    overnightNote,
    intercityMinJobValue: INTERCITY_MIN_JOB_VALUE,
  };
}

module.exports = { calcProximity, coordsForArea, AREA_COORDS, TIERS, INTERCITY_MIN_JOB_VALUE };
