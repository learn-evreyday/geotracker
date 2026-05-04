import { bucket } from './influx.js';

function rangeStart(window) {
  const w = String(window || '5m');
  if (w === '1h' || w === '5m' || w === '15m' || w === '30m') {
    return `-${w}`;
  }
  return '-5m';
}

/** Mean count per 1s across all routes (single blended series) */
export function fluxMeanPerSecond(range) {
  const r = rangeStart(range);
  return `from(bucket: "${bucket}")
  |> range(start: ${r})
  |> filter(fn: (r) => r._measurement == "api_request" and r._field == "count")
  |> group()
  |> aggregateWindow(every: 1s, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])`;
}

/** Total requests per 1s (sum across tags) */
export function fluxSumPerSecond(range) {
  const r = rangeStart(range);
  return `from(bucket: "${bucket}")
  |> range(start: ${r})
  |> filter(fn: (r) => r._measurement == "api_request" and r._field == "count")
  |> group()
  |> aggregateWindow(every: 1s, fn: sum, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])`;
}

/** Max total RPS within each 10s bucket (peak load) */
export function fluxPeakPerWindow(range) {
  const r = rangeStart(range);
  return `from(bucket: "${bucket}")
  |> range(start: ${r})
  |> filter(fn: (r) => r._measurement == "api_request" and r._field == "count")
  |> group()
  |> aggregateWindow(every: 1s, fn: sum, createEmpty: false)
  |> aggregateWindow(every: 10s, fn: max, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])`;
}

export function fluxGlobalTotal(range) {
  const r = rangeStart(range);
  return `from(bucket: "${bucket}")
  |> range(start: ${r})
  |> filter(fn: (r) => r._measurement == "api_request" and r._field == "count")
  |> sum()
  |> keep(columns: ["_value"])`;
}

export function fluxSpikeAlerts(range, threshold) {
  const r = rangeStart(range);
  const t = Number(threshold) || 15;
  return `from(bucket: "${bucket}")
  |> range(start: ${r})
  |> filter(fn: (r) => r._measurement == "api_request" and r._field == "count")
  |> group()
  |> aggregateWindow(every: 1s, fn: sum, createEmpty: false)
  |> filter(fn: (r) => r._value > ${t})
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])`;
}
