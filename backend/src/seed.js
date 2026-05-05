import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { normalizeSerial } from './serial.js';
import { writeDeviceTelemetryPointAt, flushWrites } from './influx.js';
import { computeLatestForDevice } from './telemetry.js';
import { CITIES_RO } from './simulator.js';
import {
  GEOTRACKR_FLEET_SIZE,
  GEOTRACKR_ONLINE_COUNT,
  GEOTRACKR_COMPANY_NAME,
  GEOTRACKR_COMPANY_SLUG,
} from './geotrackr.js';

const DEMO_USER_EMAILS = ['user1@example.com', 'user2@example.com', 'user3@example.com'];
const DEMO_USER_PASSWORD = 'Demo1234!';

// Offline demo devices that should end with critically low battery (<10%).
const CRITICAL_OFFLINE_SERIALS = new Set([
  'GT-TRACK-007',
  'GT-TRACK-008',
  'U1-OFFLINE-001',
  'U2-OFFLINE-001',
  'U3-OFFLINE-001',
]);

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function pickCity(i) {
  return CITIES_RO[i % CITIES_RO.length];
}

function buildTrackerPlans() {
  const plans = [];
  for (let u = 1; u <= 3; u++) {
    for (let k = 1; k <= 3; k++) {
      plans.push({
        serial: `U${u}-ONLINE-00${k}`,
        userIdx: u - 1,
        online: true,
        name: `User ${u} Online ${k}`,
      });
    }
    for (let k = 1; k <= 2; k++) {
      plans.push({
        serial: `U${u}-OFFLINE-00${k}`,
        userIdx: u - 1,
        online: false,
        name: `User ${u} Offline ${k}`,
      });
    }
  }
  return plans;
}

/** Recent trail ending a few minutes ago so status stays active (<24h). */
async function seedOnlineTrajectory(deviceId, city) {
  const now = Date.now();
  const endOffsetMs = (2 + rand(0, 3)) * 60 * 1000; // 2–5 min ago
  const durationMs = 42 * 60 * 1000;
  const startT = now - endOffsetMs - durationMs;
  const endT = now - endOffsetMs;

  let lat0 = city.lat + rand(-0.015, 0.015);
  let lon0 = city.lon + rand(-0.02, 0.02);
  const lat1 = lat0 + rand(-0.006, 0.006);
  const lon1 = lon0 + rand(-0.008, 0.008);

  const steps = 36;
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const t = Math.round(startT + ratio * (endT - startT));
    const clat = lat0 + (lat1 - lat0) * ratio + rand(-0.0002, 0.0002);
    const clon = lon0 + (lon1 - lon0) * ratio + rand(-0.0002, 0.0002);
    const bat = Math.round(Math.max(22, Math.min(98, 78 - ratio * 18 + rand(-3, 3))));
    writeDeviceTelemetryPointAt(deviceId, clat, clon, bat, 'seed', new Date(t));
  }
}

/** Historical trail; last point 25–72h ago → offline; battery kept ≥22 so status is offline not low. */
async function seedOfflineTrajectory(deviceId, city) {
  const now = Date.now();
  const hoursAgo = 25 + Math.random() * 47;
  const lastT = Math.round(now - hoursAgo * 3600 * 1000);
  const trailHours = 56 + Math.random() * 40;
  const trailStart = Math.round(lastT - trailHours * 3600 * 1000);

  let lat = city.lat + rand(-0.015, 0.015);
  let lon = city.lon + rand(-0.02, 0.02);
  const steps = 32;
  const finalBat = Math.round(Math.max(25, Math.min(85, 48 + rand(-10, 10))));
  for (let i = 0; i < steps; i++) {
    const ratio = steps <= 1 ? 1 : i / (steps - 1);
    const t = Math.round(trailStart + ratio * (lastT - trailStart));
    lat += rand(-0.0011, 0.0011);
    lon += rand(-0.0014, 0.0014);
    const isLast = i === steps - 1;
    const bat = isLast
      ? finalBat
      : Math.round(Math.max(24, Math.min(92, 55 + rand(-18, 18))));
    writeDeviceTelemetryPointAt(deviceId, lat, lon, bat, 'seed', new Date(t));
  }
}

async function ensureCriticalOfflinePoint(deviceId, batteryMin = 3, batteryMax = 9) {
  const latest = await computeLatestForDevice(deviceId);
  const now = Date.now();
  const latestT = latest?.time ? new Date(latest.time).getTime() : null;

  // Pick a timestamp that is (a) newer than existing latest, (b) still >24h old.
  const maxT = now - (24 * 3600 * 1000 + 5 * 60 * 1000); // at least 24h+5m ago
  let t = maxT;
  if (typeof latestT === 'number' && Number.isFinite(latestT)) {
    t = Math.min(maxT, latestT + 60 * 1000);
  }
  if (!Number.isFinite(t) || t <= 0) t = maxT;

  const lat = Number(latest?.latitude);
  const lon = Number(latest?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const bat = Math.round(rand(batteryMin, batteryMax));
  writeDeviceTelemetryPointAt(deviceId, lat, lon, bat, 'seed', new Date(t));
}

async function ensureTelemetry(deviceId, online, cityIndex) {
  const city = pickCity(cityIndex);
  const latest = await computeLatestForDevice(deviceId);
  const now = Date.now();

  if (online) {
    const recent =
      latest?.time && now - new Date(latest.time).getTime() < 8 * 60 * 1000;
    if (recent) return;
    await seedOnlineTrajectory(deviceId, city);
    return;
  }

  if (latest?.time) {
    const age = now - new Date(latest.time).getTime();
    if (age > 24 * 3600 * 1000) return;
  }
  await seedOfflineTrajectory(deviceId, city);
}

const GEOTRACKR_MONITOR_EMAIL = (process.env.GEOTRACKR_MONITOR_EMAIL || 'monitor@geotrackr.com').toLowerCase();

function geotrackrSerial(n) {
  return `GT-TRACK-${String(n).padStart(3, '0')}`;
}

/** 001–006 online, 007–010 offline */
function buildGeoTrackrPlans() {
  const plans = [];
  for (let i = 1; i <= GEOTRACKR_FLEET_SIZE; i++) {
    plans.push({
      serial: geotrackrSerial(i),
      online: i <= GEOTRACKR_ONLINE_COUNT,
      name: `GeoTrackr Device ${i}`,
    });
  }
  return plans;
}

/** Online: last point 1–5 min ago; battery 40–100% */
async function seedGeoOnlineTrajectory(deviceId, city) {
  const now = Date.now();
  const endOffsetMs = (1 + rand(0, 4)) * 60 * 1000;
  const durationMs = 48 * 60 * 1000;
  const startT = now - endOffsetMs - durationMs;
  const endT = now - endOffsetMs;

  let lat0 = city.lat + rand(-0.015, 0.015);
  let lon0 = city.lon + rand(-0.02, 0.02);
  const lat1 = lat0 + rand(-0.006, 0.006);
  const lon1 = lon0 + rand(-0.008, 0.008);

  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const t = Math.round(startT + ratio * (endT - startT));
    const clat = lat0 + (lat1 - lat0) * ratio + rand(-0.0002, 0.0002);
    const clon = lon0 + (lon1 - lon0) * ratio + rand(-0.0002, 0.0002);
    const bat = Math.round(rand(40, 100));
    writeDeviceTelemetryPointAt(deviceId, clat, clon, bat, 'seed', new Date(t));
  }
}

/** Offline: last point 24–72h ago; trail history; final battery 10–60% */
async function seedGeoOfflineTrajectory(deviceId, city) {
  const now = Date.now();
  const hoursAgo = 24 + Math.random() * 48;
  const lastT = Math.round(now - hoursAgo * 3600 * 1000);
  const trailHours = 40 + Math.random() * 48;
  const trailStart = Math.round(lastT - trailHours * 3600 * 1000);

  let lat = city.lat + rand(-0.015, 0.015);
  let lon = city.lon + rand(-0.02, 0.02);
  const steps = 36;
  const finalBat = Math.round(rand(10, 60));
  for (let i = 0; i < steps; i++) {
    const ratio = steps <= 1 ? 1 : i / (steps - 1);
    const t = Math.round(trailStart + ratio * (lastT - trailStart));
    lat += rand(-0.0011, 0.0011);
    lon += rand(-0.0014, 0.0014);
    const isLast = i === steps - 1;
    const bat = isLast ? finalBat : Math.round(rand(15, 75));
    writeDeviceTelemetryPointAt(deviceId, lat, lon, bat, 'seed', new Date(t));
  }
}

async function ensureGeoTelemetry(deviceId, online, cityIndex) {
  const city = pickCity(cityIndex);
  const latest = await computeLatestForDevice(deviceId);
  const now = Date.now();

  if (online) {
    const recent = latest?.time && now - new Date(latest.time).getTime() < 8 * 60 * 1000;
    if (recent) return;
    await seedGeoOnlineTrajectory(deviceId, city);
    return;
  }

  if (latest?.time) {
    const age = now - new Date(latest.time).getTime();
    if (age > 24 * 3600 * 1000) return;
  }
  await seedGeoOfflineTrajectory(deviceId, city);
}

async function seedGeoTrackrFleet() {
  const password = process.env.GEOTRACKR_MONITOR_PASSWORD || 'Monitor123!';
  const hash = await bcrypt.hash(password, 12);

  let monitorId;
  const exM = await query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [GEOTRACKR_MONITOR_EMAIL]);
  if (exM.rows[0]) {
    monitorId = exM.rows[0].id;
  } else {
    const ins = await query(
      `INSERT INTO users(email, password_hash, role, status) VALUES ($1, $2, 'user', 'active') RETURNING id`,
      [GEOTRACKR_MONITOR_EMAIL, hash]
    );
    monitorId = ins.rows[0].id;
    console.log(`seed: GeoTrackr monitor (${GEOTRACKR_MONITOR_EMAIL})`);
  }

  const plans = buildGeoTrackrPlans();
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const serial = normalizeSerial(plan.serial);
    if (!serial) continue;

    const dr = await query(`SELECT id FROM devices WHERE serial_number=$1 LIMIT 1`, [serial]);
    let deviceId;
    if (dr.rows[0]) {
      deviceId = dr.rows[0].id;
    } else {
      const dev = await query(
        `INSERT INTO devices(serial_number, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [serial, plan.name, monitorId]
      );
      deviceId = dev.rows[0].id;
      console.log(`seed: GeoTrackr device ${serial}`);
    }

    await query(`INSERT INTO device_assignments(device_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      deviceId,
      monitorId,
    ]);

    await ensureGeoTelemetry(deviceId, plan.online, i);
    if (!plan.online && CRITICAL_OFFLINE_SERIALS.has(serial)) {
      await ensureCriticalOfflinePoint(deviceId, 3, 9);
    }
  }

  console.log(`seed: GeoTrackr fleet (${GEOTRACKR_FLEET_SIZE} devices) ok`);
}

async function seedGeoTrackrCompany() {
  const ex = await query(`SELECT id FROM companies WHERE slug=$1 LIMIT 1`, [GEOTRACKR_COMPANY_SLUG]);
  let companyId;
  if (ex.rows[0]) {
    companyId = ex.rows[0].id;
  } else {
    const ins = await query(
      `INSERT INTO companies(name, slug) VALUES ($1, $2) RETURNING id`,
      [GEOTRACKR_COMPANY_NAME, GEOTRACKR_COMPANY_SLUG]
    );
    companyId = ins.rows[0].id;
    console.log(`seed: company ${GEOTRACKR_COMPANY_NAME}`);
  }

  const monitor = await query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [GEOTRACKR_MONITOR_EMAIL]);
  const monitorId = monitor.rows[0]?.id;
  if (monitorId) {
    await query(
      `INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [companyId, monitorId]
    );
  }

  for (let i = 1; i <= GEOTRACKR_FLEET_SIZE; i++) {
    const serial = normalizeSerial(`GT-TRACK-${String(i).padStart(3, '0')}`);
    if (!serial) continue;
    const dr = await query(`SELECT id FROM devices WHERE serial_number=$1 LIMIT 1`, [serial]);
    const deviceId = dr.rows[0]?.id;
    if (!deviceId) continue;
    await query(
      `INSERT INTO company_devices(company_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [companyId, deviceId]
    );
  }
  console.log('seed: GeoTrackr company links ok');
}

/**
 * Demo admin + 3 demo users with 15 trackers (9 online / 6 offline) when SEED_DEMO is enabled.
 * GeoTrackr: monitor@geotrackr.com + 10 GT-TRACK-* devices (6 online / 4 offline), same gate.
 */
export async function seedDemo() {
  if (String(process.env.SEED_DEMO || '').toLowerCase() === 'false') {
    console.log('seed: skipped (SEED_DEMO=false)');
    return;
  }

  const seedAdmin = String(process.env.SEED_DEMO_ADMIN ?? 'true').toLowerCase() !== 'false';
  if (seedAdmin) {
    const email = (process.env.DEMO_ADMIN_EMAIL || 'admin@demo.local').toLowerCase();
    const password = process.env.DEMO_ADMIN_PASSWORD || 'demoAdmin123';

    const ex = await query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [email]);
    if (!ex.rows[0]) {
      const hash = await bcrypt.hash(password, 12);
      await query(`INSERT INTO users(email, password_hash, role, status) VALUES ($1, $2, 'admin', 'active')`, [
        email,
        hash,
      ]);
      console.log(`seed: demo admin created (${email})`);
    }
  }

  const demoHash = await bcrypt.hash(DEMO_USER_PASSWORD, 12);
  const userIds = [];

  for (let i = 0; i < DEMO_USER_EMAILS.length; i++) {
    const email = DEMO_USER_EMAILS[i].toLowerCase();
    const ex = await query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [email]);
    if (ex.rows[0]) {
      userIds.push(ex.rows[0].id);
    } else {
      const ins = await query(
        `INSERT INTO users(email, password_hash, role, status) VALUES ($1, $2, 'user', 'active') RETURNING id`,
        [email, demoHash]
      );
      userIds.push(ins.rows[0].id);
      console.log(`seed: demo user ${email}`);
    }
  }

  const plans = buildTrackerPlans();
  let cityIdx = 0;

  for (const plan of plans) {
    const serial = normalizeSerial(plan.serial);
    if (!serial) continue;
    const uid = userIds[plan.userIdx];
    if (!uid) continue;

    const dr = await query(`SELECT id FROM devices WHERE serial_number=$1 LIMIT 1`, [serial]);
    let deviceId;
    if (dr.rows[0]) {
      deviceId = dr.rows[0].id;
    } else {
      const dev = await query(
        `INSERT INTO devices(serial_number, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [serial, plan.name, uid]
      );
      deviceId = dev.rows[0].id;
      await query(`INSERT INTO device_assignments(device_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        deviceId,
        uid,
      ]);
      console.log(`seed: device ${serial}`);
    }

    await ensureTelemetry(deviceId, plan.online, cityIdx);
    if (!plan.online && CRITICAL_OFFLINE_SERIALS.has(serial)) {
      await ensureCriticalOfflinePoint(deviceId, 3, 9);
    }
    cityIdx += 1;
  }

  await seedGeoTrackrFleet();
  await seedGeoTrackrCompany();

  await flushWrites();
  console.log('seed: demo telemetry flush ok');
}
