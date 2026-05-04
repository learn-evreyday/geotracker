# GeoTracker (Postgres + InfluxDB)

**GeoTracker** is a device tracking platform for live maps, history, and fleet awareness. Branding: violet/blue “GeoTracker” UI with **Device Tracking Platform** as the product tagline.

- **PostgreSQL**: users, roles, device serials, **device_assignments** (unchanged), **companies** (optional layer: `companies`, `company_users`, `company_devices`), **alerts** (offline / low battery)
- **InfluxDB 2**: time-series telemetry (location + battery)
- **React + Vite + Tailwind + Leaflet**: dashboard with stats, map legend, alert bell, company summary for the **GeoTrackr** demo fleet
- **Nginx**: reverse proxy `/api/*` → backend

## Run with Docker

```bash
docker compose up --build
```

Open `http://localhost:8080`.

### Recommended `.env`

Create `.env` in repo root (example values):

```bash
INFLUX_USER=admin
INFLUX_PASSWORD=adminpasswordchange
INFLUX_ORG=apimonitor
INFLUX_BUCKET=device_telemetry
INFLUX_TOKEN=apimonitor-dev-token-replace-in-prod

PGDATABASE=devicemonitor
PGUSER=devicemonitor
PGPASSWORD=devpasswordchange

JWT_SECRET=dev-secret-change
JWT_ACCESS_EXPIRES=15m
REFRESH_TOKEN_DAYS=30
AUTH_RATE_WINDOW_MS=60000
AUTH_RATE_MAX=40
SEED_DEMO=true
SEED_DEMO_ADMIN=true
DEMO_ADMIN_EMAIL=admin@demo.local
DEMO_ADMIN_PASSWORD=demoAdmin123
# Demo users (same password Demo1234!): user1@example.com … user3@example.com — 15 trackers (U1–U3 ONLINE/OFFLINE serials)
# GeoTrackr company demo (when SEED_DEMO is not false): monitor@geotrackr.com / Monitor123! — 10 devices GT-TRACK-001…010 (6 online, 4 offline; simulator updates only 001–006)
# GEOTRACKR_MONITOR_EMAIL=monitor@geotrackr.com
# GEOTRACKR_MONITOR_PASSWORD=Monitor123!
SIM_INTERVAL_MS=2000
SIM_ENABLED=true
# Alert sync: evaluate telemetry and create alerts (default 60s)
# ALERT_SYNC_INTERVAL_MS=60000
```

### Demo: GeoTrackr company

When `SEED_DEMO` is enabled, the seed creates the **GeoTrackr** company (`slug: geotrackr`), links **monitor@geotrackr.com** / **Monitor123!**, and assigns **GT-TRACK-001…010** to that company (in addition to normal `device_assignments`). Use the dashboard **Company: GeoTrackr** block and the **Flotă GeoTrackr** badge on tracker cards to identify that fleet.

## Core flows

### User flow
- Register / Login
- Add tracker by serial (`TRK-2026-0001`)
- See assigned devices on dashboard + devices page
- Search history by serial number

### Admin flow
- Login with an admin account (`users.role=admin`; demo seed creates `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD`)
- **Admin devices** (`/admin/devices`): all trackers, serial, assignees, status, last seen, global delete
- View users list with tracker counts

## API endpoints

Auth:
- `POST /api/auth/register` — body validated (Zod); rate limited
- `POST /api/auth/login` — returns `accessToken`, `refreshToken`, `expiresIn`, `token` (alias for access)
- `POST /api/auth/refresh` — `{ "refreshToken": "..." }`; rotates refresh token; rate limited
- `POST /api/auth/change-password` (JWT) — `old_password`, `new_password`; revokes refresh tokens

Access JWT expiry is configured with `JWT_ACCESS_EXPIRES` (default **15m**). Refresh tokens are opaque, stored hashed (`REFRESH_TOKEN_DAYS`, default 30).

Devices:
- `GET /api/devices`
- `POST /api/devices/register-by-serial`
- `DELETE /api/devices/:id/assignment` — remove tracker from **your** account (not admin delete)
- `GET /api/devices/offline` — trackers whose **last telemetry is older than 24h** (still returns **last known** lat/lon/battery). Regular users: assigned devices only; admin: all.
- `GET /api/devices/:id`
- `GET /api/devices/:id/latest`
- `GET /api/devices/:id/history?range=5m|15m|30m|1h|24h|7d`
- `GET /api/devices/by-serial/:serialNumber`
- `GET /api/devices/by-serial/:serialNumber/history?range=1h|24h|7d`

Admin:
- `GET /api/users` (admin only)
- `GET /api/admin/devices` — all devices + assignees JSON, status, last seen
- `DELETE /api/admin/devices/:id` — delete device globally (Postgres + related rows)

Telemetry ingest:
- `POST /api/telemetry` (JWT required; writes InfluxDB measurement `device_telemetry`)

**Companies** (extra layer; does not replace `device_assignments`):
- `GET /api/companies` — members see companies they belong to; **admin** sees all
- `GET /api/companies/:id/summary` — `total_trackers`, `online_trackers`, `offline_trackers`, `low_battery_trackers` (from Influx latest + same rules as UI)
- `GET /api/companies/:id/devices` — devices linked to the company; access if member (or admin)

**Alerts** (deduplicated: no second **unread** row for the same `device_id` + `type`):
- Background job calls Influx/telemetry on an interval (`ALERT_SYNC_INTERVAL_MS`, default 60s): **offline** if last transmission is older than 24 hours, **low_battery** if battery is below 20% (matches app status rules)
- `GET /api/alerts` — assigned devices for users; **all** for admin
- `GET /api/alerts/unread-count`
- `POST /api/alerts/:id/read`
- `POST /api/alerts/read-all`

## Curl examples

Register:

```bash
curl -sS -X POST http://localhost:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"changeme123"}'
```

Login (single response includes `accessToken`, `refreshToken`, `expiresIn`):

```bash
LOGIN_JSON=$(curl -sS -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"changeme123"}')
TOKEN=$(echo "$LOGIN_JSON" | jq -r '.accessToken // .token')
REFRESH=$(echo "$LOGIN_JSON" | jq -r .refreshToken)
```

Refresh access token:

```bash
curl -sS -X POST http://localhost:8080/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH\"}"
```

Register/associate tracker by serial:

```bash
curl -sS -X POST http://localhost:8080/api/devices/register-by-serial \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serial_number":"TRK-2026-0001","name":"Personal tracker"}'
```

Fetch latest:

```bash
DEVICE_ID="<uuid>"
curl -sS http://localhost:8080/api/devices/$DEVICE_ID/latest \
  -H "Authorization: Bearer $TOKEN"
```

History by serial:

```bash
curl -sS "http://localhost:8080/api/devices/by-serial/TRK-2026-0001/history?range=24h" \
  -H "Authorization: Bearer $TOKEN"
```

## Run backend locally (without Docker)

You still need **InfluxDB** + **PostgreSQL** reachable from your machine.

### PowerShell (Windows)

```powershell
cd d:\cursor\sitemaps\backend
$env:INFLUX_URL="http://localhost:8086"
$env:INFLUX_TOKEN="apimonitor-dev-token-replace-in-prod"
$env:INFLUX_ORG="apimonitor"
$env:INFLUX_BUCKET="device_telemetry"
$env:PGHOST="localhost"
$env:PGPORT="5432"
$env:PGDATABASE="devicemonitor"
$env:PGUSER="devicemonitor"
$env:PGPASSWORD="devpasswordchange"
$env:JWT_SECRET="dev-secret-change"
npm.cmd start
```

### WSL / bash

```bash
cd /mnt/d/cursor/sitemaps/backend
export INFLUX_URL="http://localhost:8086"
export INFLUX_TOKEN="apimonitor-dev-token-replace-in-prod"
export INFLUX_ORG="apimonitor"
export INFLUX_BUCKET="device_telemetry"
export PGHOST="localhost"
export PGPORT="5432"
export PGDATABASE="devicemonitor"
export PGUSER="devicemonitor"
export PGPASSWORD="devpasswordchange"
export JWT_SECRET="dev-secret-change"
npm start
```

Backend prints `http://localhost:3000`.

