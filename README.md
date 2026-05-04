# GeoTracker (Postgres + InfluxDB)

**GeoTracker** is a device tracking platform for live maps, history, and fleet awareness. Branding: violet/blue “GeoTracker” UI with **Device Tracking Platform** as the product tagline.

- **PostgreSQL**: users, roles, device serials, **device_assignments** (unchanged), **companies** (optional layer: `companies`, `company_users`, `company_devices`), **alerts** (offline / low battery)
- **InfluxDB 2**: time-series telemetry (location + battery)
- **React + Vite + Tailwind + Leaflet**: dashboard with stats, map legend, alert bell, company summary for the **GeoTrackr** demo fleet
- **Nginx**: reverse proxy `/api/*` → backend

## Security: never commit `.env`

- **Do not** push `.env`, `.env.local`, or any file containing real credentials to GitHub (or any public repository).
- These files typically hold **secrets**: database passwords, **JWT signing keys**, **InfluxDB tokens**, API keys, and demo passwords. Committing them exposes your infrastructure and invalidates tokens.
- The repository includes **`.env.example`** files (backend and frontend) with **placeholders only**. Copy them to `.env`, replace values locally, and rely on `.gitignore` to exclude real env files from commits.

## Environment Variables

Configuration is **not** bundled in the repo. You must **create environment files yourself**:

| Location | Purpose |
|----------|---------|
| **`backend/.env`** | PostgreSQL, InfluxDB, JWT, seed/simulator options when running the Node API locally or when your process loads dotenv. |
| **`frontend/.env`** or **`frontend/.env.local`** | Optional Vite variables (e.g. `VITE_API_BASE`) for local dev. |
| **Repo root `.env`** (optional) | Used by **Docker Compose** variable substitution (e.g. `PGPASSWORD`, `INFLUX_TOKEN`); same security rules apply. |

1. Copy the examples: `cp backend/.env.example backend/.env` and, if needed, `cp frontend/.env.example frontend/.env.local`.
2. Edit the new files and set **your own** secrets and hosts. Do not reuse sample passwords from documentation.

The Node backend **does not load `dotenv` by default**. For local `npm start`, export variables in your shell (see [Run backend locally](#run-backend-locally-without-docker)), use your IDE’s env runner, or add a small `dotenv` bootstrap yourself. **Docker Compose** passes variables from the repo root `.env` into containers as configured in `docker-compose.yml`.

The backend reads **individual PostgreSQL settings** (`PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, …) as implemented in `backend/src/db.js`. A single `DATABASE_URL` is **not** used by default; you can keep one in `.env` only for other tooling if you wish.

### Example: `backend/.env` (placeholders only)

Do **not** copy this block verbatim into production; replace every placeholder.

```env
PGHOST=localhost
PGPORT=5432
PGDATABASE=geotracker
PGUSER=your-user
PGPASSWORD=your-password

DATABASE_URL=postgresql://user:password@localhost:5555/geotracker

JWT_SECRET=your-secret-key

INFLUX_URL=http://localhost:8888
INFLUX_TOKEN=your-token
INFLUX_ORG=your-org
INFLUX_BUCKET=your-bucket

SEED_DEMO=true
```

See **`backend/.env.example`** for the full list of variables (including auth expiry, rate limits, simulator, alerts).

### Example: `frontend/.env.local` (optional)

```env
VITE_API_BASE=
```

Empty `VITE_API_BASE` is typical when the UI and API share the same origin (e.g. nginx proxies `/api`). Set to your API origin when developing against a separate backend URL.

## Run with Docker

Create a **repo root** `.env` if you need to override Compose defaults (database password, Influx token, JWT secret, etc.). Never commit that file.

```bash
docker compose up --build
```

Open `http://localhost:8080`.

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

You still need **InfluxDB** + **PostgreSQL** reachable from your machine. Set variables from **`backend/.env`** by exporting them (example below uses placeholders — use your real values, never commit them).

### PowerShell (Windows)

```powershell
cd path\to\sitemaps\backend
$env:INFLUX_URL="http://localhost:8086"
$env:INFLUX_TOKEN="your-token"
$env:INFLUX_ORG="your-org"
$env:INFLUX_BUCKET="your-bucket"
$env:PGHOST="localhost"
$env:PGPORT="5432"
$env:PGDATABASE="geotracker"
$env:PGUSER="your-user"
$env:PGPASSWORD="your-password"
$env:JWT_SECRET="your-secret-key"
npm.cmd start
```

### WSL / bash

```bash
cd /path/to/sitemaps/backend
export INFLUX_URL="http://localhost:8086"
export INFLUX_TOKEN="your-token"
export INFLUX_ORG="your-org"
export INFLUX_BUCKET="your-bucket"
export PGHOST="localhost"
export PGPORT="5432"
export PGDATABASE="geotracker"
export PGUSER="your-user"
export PGPASSWORD="your-password"
export JWT_SECRET="your-secret-key"
npm start
```

Backend prints `http://localhost:3000` (or the port from `PORT`).

