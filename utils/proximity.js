// utils/proximity.js
// Ghana-aware proximity calculation for BeyondX.
//
// Approach: text neighbourhood name → approximate lat/lng from a curated
// lookup table of Greater Accra areas, then Haversine for straight-line
// distance. Straight-line deliberately understimates real travel distance,
// so we apply a 1.4× road factor (calibrated for Accra's grid/sprawl)
// to get a more realistic driving/trotro distance.
//
// Transport cost model:
//   0-5km   → GH₵0  (walkable / close, no transport)
//   5-10km  → GH₵5  (one trotro, short)
//   10-20km → GH₵10 (one or two trotros, medium)
//   20-35km → GH₵20 (long cross-city journey)
//   35km+   → GH₵30 (outer districts — Tema, Kasoa, Nsawam corridor)
//
// These are approximations tuned for 2026 Accra trotro fares.
// Workers get this amount added on top of their full task pay.

const ROAD_FACTOR = 1.4; // straight-line → road distance multiplier

// Approximate centroids for Greater Accra neighbourhoods.
// Curated manually — good enough for a transport cost estimate.
const AREA_COORDS = {
  // Central / Accra proper
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
  // North / Peri-urban
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
  // West / Dansoman corridor
  'dansoman':            [5.5300, -0.2650],
  'mamprobi':            [5.5350, -0.2450],
  'korle-bu':            [5.5378, -0.2278],
  'bubuashie':           [5.5556, -0.2556],
  'odorkor':             [5.5450, -0.2750],
  'darkuman':            [5.5611, -0.2667],
  'lapaz':               [5.5897, -0.2567],
  'ablekuma':            [5.5483, -0.2825],
  // East / Tema corridor
  'tema':                [5.6698, -0.0166],
  'tema community 1':    [5.6667, -0.0167],
  'community 25':        [5.7089, -0.0028],
  'ashaiman':            [5.6953, -0.0328],
  'teshie':              [5.5912, -0.1378],
  'nungua':              [5.5897, -0.1108],
  'community 18':        [5.6900, -0.0450],
  // South / Coast
  'nima':                [5.5839, -0.2197],
  'mamobi':              [5.5850, -0.2150],
  'maamobi':             [5.5850, -0.2150],
  'accra new town':      [5.5750, -0.2300],
  // Suburbs
  'spintex':             [5.6208, -0.1311],
  'baatsona':            [5.6350, -0.1050],
  'community 7':         [5.6850, -0.0500],
  'community 9':         [5.7000, -0.0400],
  'sakumono':            [5.6361, -0.0417],
  'lashibi':             [5.6178, -0.0808],
  'kpone':               [5.7050, 0.0300],
  // Outer Greater Accra
  'kasoa':               [5.5333, -0.4167],
  'weija':               [5.5667, -0.3500],
  'pokuase junction':    [5.7600, -0.2800],
  'nsawam':              [5.8035, -0.3480],
  'dodowa':              [5.8928, -0.0297],
  'adenta':              [5.6906, -0.1772],
  'ashiaman':            [5.6953, -0.0328],
};

/**
 * Try to find coordinates for a place name string.
 * Does a fuzzy match against the area lookup — lowercased, checks if any
 * key is contained in the input or vice versa.
 * Returns null if no match found.
 */
function coordsForArea(areaText) {
  if (!areaText) return null;
  const t = areaText.toLowerCase().trim();
  // Exact match first
  if (AREA_COORDS[t]) return AREA_COORDS[t];
  // Check if any known area name appears as a substring of the input
  for (const [key, coords] of Object.entries(AREA_COORDS)) {
    if (t.includes(key) || key.includes(t)) return coords;
  }
  return null;
}

/**
 * Haversine straight-line distance in km between two lat/lng pairs.
 */
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

/**
 * Main function — given worker's home area text and job location text,
 * returns:
 *   { distanceKm, roadKm, transportAllowance, tier, available }
 *
 * available: false when we couldn't geocode either location (graceful
 * degradation — don't show proximity info rather than show wrong info).
 */
function calcProximity(workerHomeArea, jobLocation) {
  const workerCoords = coordsForArea(workerHomeArea);
  const jobCoords    = coordsForArea(jobLocation);

  if (!workerCoords || !jobCoords) {
    return { available: false, distanceKm: null, roadKm: null, transportAllowance: 0, tier: 'unknown' };
  }

  const distanceKm = haversineKm(workerCoords, jobCoords);
  const roadKm     = distanceKm * ROAD_FACTOR;

  let transportAllowance, tier;
  if (roadKm < 5) {
    transportAllowance = 0;  tier = 'nearby';
  } else if (roadKm < 10) {
    transportAllowance = 5;  tier = 'short';
  } else if (roadKm < 20) {
    transportAllowance = 10; tier = 'medium';
  } else if (roadKm < 35) {
    transportAllowance = 20; tier = 'far';
  } else {
    transportAllowance = 30; tier = 'very_far';
  }

  return {
    available: true,
    distanceKm: Math.round(distanceKm * 10) / 10,
    roadKm: Math.round(roadKm * 10) / 10,
    transportAllowance,
    tier,
  };
}

module.exports = { calcProximity, coordsForArea, AREA_COORDS };
