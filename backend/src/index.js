import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { flushWrites } from './influx.js';
import { runMigrations } from './migrations.js';
import { register, login, refresh, changePassword } from './auth.js';
import { authRequired, requireRole } from './middleware.js';
import { listUsers } from './users.js';
import {
  listDevices,
  listOfflineDevices,
  createDevice,
  getDevice,
  registerBySerial,
  getDeviceBySerial,
  unassignFromMe,
  adminDeleteDevice,
  listAdminDevices,
} from './devices.js';
import { postTelemetry, getLatest, getHistory } from './telemetry.js';
import { startSimulator, createDeviceState, stepState } from './simulator.js';
import { query } from './db.js';
import { writeDeviceTelemetryPoint } from './influx.js';
import { seedDemo } from './seed.js';
import { GEOTRACKR_OFFLINE_SIM_SERIALS } from './geotrackr.js';
import { computeLatestForDevice } from './telemetry.js';
import { listCompanies, getCompanySummary, getCompanyDevices } from './companies.js';
import {
  syncAlertsFromTelemetry,
  listAlerts,
  getUnreadAlertCount,
  markAlertRead,
  markAllAlertsRead,
} from './alerts.js';

const PORT = Number(process.env.PORT) || 3000;

const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.AUTH_RATE_MAX) || 40,
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Auth
app.post('/api/auth/register', authLimiter, register);
app.post('/api/auth/login', authLimiter, login);
app.post('/api/auth/refresh', authLimiter, refresh);
app.post('/api/auth/change-password', authRequired, changePassword);

// Admin
app.get('/api/users', authRequired, requireRole('admin'), listUsers);
app.get('/api/admin/devices', authRequired, requireRole('admin'), listAdminDevices);
app.delete('/api/admin/devices/:id', authRequired, requireRole('admin'), adminDeleteDevice);

// Devices
app.get('/api/devices', authRequired, listDevices);
app.get('/api/devices/offline', authRequired, listOfflineDevices);
app.post('/api/devices', authRequired, createDevice);
app.post('/api/devices/register-by-serial', authRequired, registerBySerial);
app.delete('/api/devices/:id/assignment', authRequired, unassignFromMe);
app.get('/api/devices/:id', authRequired, getDevice);
app.get('/api/devices/:id/latest', authRequired, getLatest);
app.get('/api/devices/:id/history', authRequired, getHistory);
app.get('/api/devices/by-serial/:serialNumber', authRequired, getDeviceBySerial);
app.get('/api/devices/by-serial/:serialNumber/history', authRequired, async (req, res) => {
  // Resolve device_id in Postgres then reuse history handler
  const serial = String(req.params.serialNumber || '').trim().toUpperCase();
  if (!serial) return res.status(400).json({ error: 'invalid_input' });

  const { rows } = await query(`SELECT id FROM devices WHERE serial_number=$1 LIMIT 1`, [serial]);
  const deviceId = rows[0]?.id;
  if (!deviceId) return res.status(404).json({ error: 'not_found' });

  req.params.id = deviceId;
  // audit after access checks in getHistory
  const r = await getHistory(req, res);
  return r;
});

// Telemetry ingest
app.post('/api/telemetry', authRequired, postTelemetry);

// Companies (additional layer; device_assignments unchanged)
app.get('/api/companies', authRequired, listCompanies);
app.get('/api/companies/:id/summary', authRequired, getCompanySummary);
app.get('/api/companies/:id/devices', authRequired, getCompanyDevices);

// Alerts
app.get('/api/alerts', authRequired, listAlerts);
app.get('/api/alerts/unread-count', authRequired, getUnreadAlertCount);
app.post('/api/alerts/:id/read', authRequired, markAlertRead);
app.post('/api/alerts/read-all', authRequired, markAllAlertsRead);

app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 10);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`backend listening on http://localhost:${PORT}`);
});

async function shutdown() {
  await flushWrites();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const alertSyncMs = Math.max(10_000, Number(process.env.ALERT_SYNC_INTERVAL_MS) || 60_000);

// Startup DB migrations
runMigrations()
  .then(() => console.log('postgres migrations ok'))
  .then(() => seedDemo())
  .then(() => syncAlertsFromTelemetry().catch((e) => console.warn('alert sync initial:', e.message)))
  .then(() => maybeStartSimulator())
  .then(() => {
    setInterval(() => {
      syncAlertsFromTelemetry().catch((e) => console.warn('alert sync:', e.message));
    }, alertSyncMs);
  })
  .catch((e) => console.error('postgres migrations failed', e));

let stopSim = null;
let simIntervalMs = Math.max(500, Number(process.env.SIM_INTERVAL_MS) || 2000);
const simEnabled = String(process.env.SIM_ENABLED ?? 'true') !== 'false';
const deviceStates = new Map(); // device_id -> state

async function maybeStartSimulator() {
  if (!simEnabled) return;
  const { rows } = await query(
    `SELECT id, serial_number FROM devices
     WHERE serial_number NOT ILIKE '%-OFFLINE-%'
       AND NOT (serial_number::text = ANY($1::text[]))
     ORDER BY created_at DESC
     LIMIT 200`,
    [GEOTRACKR_OFFLINE_SIM_SERIALS]
  );
  if (!rows.length) {
    console.log('simulator: no devices in Postgres (create one via POST /api/devices)');
    return;
  }
  for (const r of rows) {
    if (deviceStates.has(r.id)) continue;
    let st = null;
    try {
      const latest = await computeLatestForDevice(r.id);
      if (
        latest?.latitude != null &&
        latest?.longitude != null &&
        Number.isFinite(Number(latest.latitude)) &&
        Number.isFinite(Number(latest.longitude))
      ) {
        const lat = Number(latest.latitude);
        const lon = Number(latest.longitude);
        const bat =
          typeof latest.batteryPercent === 'number' && Number.isFinite(latest.batteryPercent)
            ? Math.max(0, Math.min(100, latest.batteryPercent))
            : 70;
        st = {
          city: 'latest',
          lat,
          lon,
          headingLat: (Math.random() * 2 - 1) * 0.00015,
          headingLon: (Math.random() * 2 - 1) * 0.00015,
          battery: bat,
        };
      }
    } catch (e) {
      console.warn(`simulator: could not read latest for ${r.serial_number}`, e?.message || e);
    }
    if (!st) st = createDeviceState();
    deviceStates.set(r.id, st);
  }

  if (stopSim) stopSim();
  stopSim = startSimulator(simIntervalMs, () => {
    for (const [deviceId, st] of deviceStates) {
      const next = stepState(st);
      writeDeviceTelemetryPoint(deviceId, next.lat, next.lon, next.battery, 'sim');
    }
  });
  console.log(`simulator: enabled (${rows.length} devices, GeoTrackr offline fleet excluded) @ ${simIntervalMs}ms`);
}
