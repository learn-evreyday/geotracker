import { InfluxDB, Point } from '@influxdata/influxdb-client';

const url = process.env.INFLUX_URL || 'http://influxdb:8086';
const token = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG || 'apimonitor';
const bucket = process.env.INFLUX_BUCKET || 'device_telemetry';

if (!token) {
  console.error('INFLUX_TOKEN is required');
  process.exit(1);
}

const influx = new InfluxDB({ url, token });
const writeApi = influx.getWriteApi(org, bucket, 'ns', {
  batchSize: 500,
  flushInterval: 1000,
  maxRetries: 2,
});
const queryApi = influx.getQueryApi(org);

writeApi.useDefaultTags({ service: 'backend' });
writeApi.on('error', (e) => {
  // Keep the process alive even if Influx is temporarily down (e.g. local dev without Docker).
  console.warn(`WARN: Influx write error: ${e?.code || ''} ${e?.message || e}`);
});

export function writeTrafficPoint(route, count, source = 'sim') {
  const p = new Point('api_request')
    .tag('route', route)
    .tag('source', source)
    .intField('count', Math.max(0, Math.floor(Number(count)) || 0));
  writeApi.writePoint(p);
}

export function writeDeviceTelemetryPoint(deviceId, latitude, longitude, batteryPercent, source = 'sim', when = null) {
  writeDeviceTelemetryPointAt(deviceId, latitude, longitude, batteryPercent, source, when);
}

/** Write telemetry at an explicit time (for historical / demo seed). `when` = Date | ISO string | ms. */
export function writeDeviceTelemetryPointAt(deviceId, latitude, longitude, batteryPercent, source = 'seed', when = null) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const bat = Math.max(0, Math.min(100, Math.floor(Number(batteryPercent))));
  if (!deviceId || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const p = new Point('device_telemetry')
    .tag('device_id', String(deviceId))
    .tag('source', String(source || 'seed'))
    .floatField('latitude', lat)
    .floatField('longitude', lon)
    .intField('battery_percent', Number.isFinite(bat) ? bat : 0);

  if (when != null) {
    const d = when instanceof Date ? when : new Date(when);
    if (!Number.isNaN(d.getTime())) p.timestamp(d);
  }

  writeApi.writePoint(p);
}

export async function flushWrites() {
  await writeApi.flush();
}

/**
 * Run Flux query; returns table rows as array of objects (time, route, value)
 */
export async function queryFlux(flux) {
  const rows = [];
  return new Promise((resolve, reject) => {
    queryApi.queryRows(flux, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        rows.push(o);
      },
      error(e) {
        reject(e);
      },
      complete() {
        resolve(rows);
      },
    });
  });
}

export { bucket, org, queryApi };
