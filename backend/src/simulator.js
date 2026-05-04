const CITIES_RO = [
  { name: 'Bucharest', lat: 44.4268, lon: 26.1025 },
  { name: 'Cluj-Napoca', lat: 46.7712, lon: 23.6236 },
  { name: 'Iași', lat: 47.1585, lon: 27.6014 },
  { name: 'Timișoara', lat: 45.7489, lon: 21.2087 },
  { name: 'Brașov', lat: 45.6579, lon: 25.6012 },
  { name: 'Constanța', lat: 44.1598, lon: 28.6348 },
  { name: 'Craiova', lat: 44.3302, lon: 23.7949 },
  { name: 'Sibiu', lat: 45.7936, lon: 24.1213 },
  { name: 'Oradea', lat: 47.0465, lon: 21.9189 },
  { name: 'Suceava', lat: 47.6514, lon: 26.2556 },
];

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function pickCity() {
  return CITIES_RO[Math.floor(Math.random() * CITIES_RO.length)];
}

/**
 * Simple "street-like" motion: small correlated steps around a city center.
 */
export function createDeviceState() {
  const c = pickCity();
  return {
    city: c.name,
    lat: c.lat + rand(-0.01, 0.01),
    lon: c.lon + rand(-0.015, 0.015),
    headingLat: rand(-1, 1) * 0.0002,
    headingLon: rand(-1, 1) * 0.0002,
    battery: Math.floor(rand(35, 100)),
  };
}

export function stepState(s) {
  // Slight random heading drift
  s.headingLat = clamp(s.headingLat + rand(-0.00003, 0.00003), -0.0004, 0.0004);
  s.headingLon = clamp(s.headingLon + rand(-0.00003, 0.00003), -0.0004, 0.0004);

  // Move
  s.lat += s.headingLat;
  s.lon += s.headingLon;

  // Battery drains slowly; occasional recharge jump to simulate charging
  if (Math.random() < 0.002) s.battery = clamp(s.battery + 20, 0, 100);
  s.battery = clamp(s.battery - rand(0.01, 0.08), 0, 100);

  return s;
}

export function startSimulator(intervalMs, onTick) {
  const id = setInterval(() => onTick(), intervalMs);
  return () => clearInterval(id);
}

export { CITIES_RO };
