import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
  matchPath,
  useLocation,
} from 'react-router-dom';
import {
  LayoutDashboard,
  MapPin,
  Radio,
  Users,
  Settings,
  LogOut,
  Languages,
  Shield,
  Battery,
  Clock,
  History as HistoryIcon,
  ArrowLeft,
  Unlink,
  Copy,
  Radar,
  Bell,
  Boxes,
  Signal,
  WifiOff,
  BatteryWarning,
} from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import * as Dialog from '@radix-ui/react-dialog';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  authLogin,
  authRegister,
  authChangePassword,
  fetchDeviceBySerialStatus,
  getHistoryBySerial,
  getLatestById,
  listDevices,
  adminListUsers,
  registerDeviceBySerial,
  getDeviceById,
  getHistoryByDeviceId,
  unassignDevice,
  adminDeleteDevice,
  adminListAllDevices,
  listOfflineDevices,
  listCompanies,
  getCompanySummary,
  listAlerts,
  getUnreadAlertsCount,
  markAlertReadApi,
  markAllAlertsReadApi,
} from './api.js';

const REFRESH_CHOICES = [500, 1000, 2000, 5000, 10000];
const HISTORY_RANGES = ['1h', '24h', '7d'];

function useAuth() {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  });
  const token = localStorage.getItem('token');
  return {
    user,
    token,
    setSession: (accessToken, refreshTokenValue, userValue) => {
      localStorage.setItem('token', accessToken);
      if (refreshTokenValue) localStorage.setItem('refreshToken', refreshTokenValue);
      localStorage.setItem('user', JSON.stringify(userValue));
      setUser(userValue);
    },
    logout: () => {
      localStorage.removeItem('token');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
      setUser(null);
    },
  };
}

function useMe() {
  const raw = localStorage.getItem('user');
  return raw ? JSON.parse(raw) : null;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatCoord(n) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(5);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function isGeoTrackrFleetSerial(serial) {
  return /^GT-TRACK-\d{3}$/i.test(String(serial || '').trim());
}

/** Rough RO city areas for display + location filter (coordinates only; no stored city in DB). */
const RO_CITY_ESTIMATES = [
  { name: 'Bucharest', la: 44.4268, lo: 26.1025, r: 0.12 },
  { name: 'Cluj-Napoca', la: 46.7712, lo: 23.6236, r: 0.1 },
  { name: 'Iași', la: 47.1585, lo: 27.6014, r: 0.09 },
  { name: 'Timișoara', la: 45.7489, lo: 21.2087, r: 0.09 },
  { name: 'Brașov', la: 45.6579, lo: 25.6012, r: 0.09 },
  { name: 'Constanța', la: 44.1598, lo: 28.6348, r: 0.1 },
  { name: 'Craiova', la: 44.3302, lo: 23.7949, r: 0.08 },
  { name: 'Sibiu', la: 45.7936, lo: 24.1213, r: 0.07 },
  { name: 'Oradea', la: 47.0465, lo: 21.9189, r: 0.07 },
  { name: 'Suceava', la: 47.6514, lo: 26.2556, r: 0.07 },
];

function estimateCityNearCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  for (const c of RO_CITY_ESTIMATES) {
    if (Math.abs(lat - c.la) <= c.r && Math.abs(lon - c.lo) <= c.r * 1.25) return c.name;
  }
  return '';
}

function trackerLocationSearchBlob(l) {
  if (!l || !Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return '';
  const lat = l.latitude;
  const lon = l.longitude;
  const city = estimateCityNearCoords(lat, lon);
  const coordChunk = `${formatCoord(lat)},${formatCoord(lon)} ${lat} ${lon}`.toLowerCase();
  const cityChunk = `${city} ${city.replace(/-/g, ' ')}`.toLowerCase();
  const romanianAliases =
    city === 'Bucharest'
      ? 'bucurești bucuresti'
      : city === 'Timișoara'
        ? 'timisoara'
        : city === 'Iași'
          ? 'iasi'
          : city === 'Brașov'
            ? 'brasov'
            : city === 'Constanța'
              ? 'constanta'
              : '';
  return `${coordChunk} ${cityChunk} ${romanianAliases}`.trim().toLowerCase();
}

function computeTrackerStatus(l) {
  if (!l) return 'offline';
  const battery = typeof l.batteryPercent === 'number' ? l.batteryPercent : null;
  if (l.status === 'offline') return 'offline';
  if (battery != null && battery < 20) return 'low';
  return l.status === 'active' ? 'active' : 'offline';
}

function formatTrackerLocationLine(l) {
  if (!l || !Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return '—';
  const city = estimateCityNearCoords(l.latitude, l.longitude);
  const coord = `${formatCoord(l.latitude)}, ${formatCoord(l.longitude)}`;
  return city ? `${city} · ${coord}` : coord;
}

function CopySerialButton({ serial, className = '', onCopied }) {
  const { t } = useTranslation();
  const s = String(serial || '').trim();
  return (
    <button
      type="button"
      disabled={!s}
      onClick={async () => {
        if (!s) return;
        const ok = await copyToClipboard(s);
        if (ok) onCopied?.();
      }}
      className={`inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-50 ${className}`}
    >
      <Copy className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2} />
      {t('copySerial')}
    </button>
  );
}

/** Fixed toast — use with CopySerialButton onCopied */
function SerialCopiedToast({ visible, message }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-[100] max-w-sm -translate-x-1/2 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm font-medium text-gray-900 shadow-cardHover md:bottom-10">
      {message}
    </div>
  );
}

function MapLegend() {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-auto absolute bottom-6 left-4 z-[500] max-w-[220px] rounded-2xl border border-gray-200/80 bg-white/90 px-3 py-2.5 text-xs text-gray-700 shadow-md backdrop-blur-sm md:bottom-8">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">{t('mapLegend')}</div>
      <ul className="space-y-1.5">
        <li className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500 ring-1 ring-emerald-800/20" />
          {t('mapLegendActive')}
        </li>
        <li className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500 ring-1 ring-red-900/25" />
          {t('mapLegendOffline')}
        </li>
        <li className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 ring-1 ring-amber-800/30" />
          {t('mapLegendLow')}
        </li>
      </ul>
    </div>
  );
}

function AlertsBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const wrapRef = useRef(null);
  const prevUnreadRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [unread, setUnread] = useState(0);
  const [burstToast, setBurstToast] = useState(null);

  const load = async () => {
    try {
      const [a, c] = await Promise.all([listAlerts(), getUnreadAlertsCount()]);
      const list = a.alerts || [];
      const n = c.count ?? 0;
      setAlerts(list);
      if (prevUnreadRef.current != null && n > prevUnreadRef.current) {
        setBurstToast(t('alertsNewToast'));
        window.setTimeout(() => setBurstToast(null), 3200);
      }
      prevUnreadRef.current = n;
      setUnread(n);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    load();
    const id = window.setInterval(load, 20000);
    return () => window.clearInterval(id);
  }, [t]);

  useEffect(() => {
    const fn = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [open]);

  return (
    <>
      {burstToast && (
        <div className="pointer-events-none fixed bottom-20 left-1/2 z-[120] max-w-sm -translate-x-1/2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-950 shadow-lg md:bottom-10">
          {burstToast}
        </div>
      )}
      <div className="relative shrink-0" ref={wrapRef}>
        <button
          type="button"
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-700 shadow-sm transition hover:bg-gray-50"
          aria-label={t('recentAlerts')}
          onClick={() => {
            setOpen((o) => !o);
            load();
          }}
        >
          <Bell className="h-5 w-5 text-accent" strokeWidth={2} />
          {unread > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white shadow-sm">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
        {open ? (
          <div className="absolute right-0 top-full z-[200] mt-2 flex max-h-[min(70vh,420px)] w-[min(calc(100vw-2rem),360px)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-cardHover">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <span className="text-sm font-semibold text-gray-900">{t('recentAlerts')}</span>
              {unread > 0 ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-accent hover:underline"
                  onClick={async () => {
                    await markAllAlertsReadApi();
                    await load();
                  }}
                >
                  {t('markAllRead')}
                </button>
              ) : null}
            </div>
            <div className="overflow-y-auto">
              {!alerts.length ? (
                <div className="px-4 py-8 text-center text-sm text-gray-500">{t('noAlerts')}</div>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {alerts.slice(0, 25).map((al) => (
                    <li key={al.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            al.type === 'offline'
                              ? 'bg-red-50 text-red-700 ring-1 ring-red-100'
                              : 'bg-amber-50 text-amber-800 ring-1 ring-amber-100'
                          }`}
                        >
                          {al.type === 'offline' ? t('offline') : t('lowBattery')}
                        </span>
                        <span className="text-[10px] text-gray-400">{formatTime(al.created_at)}</span>
                      </div>
                      <p className="mt-1 text-xs text-gray-700">{al.message}</p>
                      <p className="mt-0.5 font-mono text-[11px] font-semibold text-gray-900">{al.serial_number}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="text-xs font-semibold text-accent hover:underline"
                          onClick={() => {
                            navigate(`/trackers/${encodeURIComponent(al.serial_number)}/map`);
                            setOpen(false);
                          }}
                        >
                          {t('viewTracker')}
                        </button>
                        {!al.is_read ? (
                          <button
                            type="button"
                            className="text-xs font-medium text-gray-500 hover:text-gray-800"
                            onClick={async () => {
                              await markAlertReadApi(al.id);
                              await load();
                            }}
                          >
                            {t('markAsRead')}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function statusFromLatest(latest, lowBattery = 20) {
  const b = latest?.batteryPercent ?? latest?.battery_percent;
  if (typeof b === 'number' && b < lowBattery) return 'low';
  return latest?.status || 'offline';
}

function markerColor(status) {
  if (status === 'low') return '#f59e0b';
  if (status === 'active') return '#22c55e';
  return '#ef4444';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markerIcon(color, opts = {}) {
  const ring =
    opts.highlight === true
      ? `box-shadow:0 0 0 4px rgba(56,189,248,0.55),0 6px 18px rgba(0,0,0,0.35);animation:dmPulse 1.1s ease-in-out infinite`
      : `box-shadow:0 6px 18px rgba(0,0,0,0.35)`;
  return L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:9999px;background:${color};border:2px solid rgba(0,0,0,0.35);${ring}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function MarkerClusterLayer({ points, highlightSerial, markersRef, popupLabels }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!layerRef.current) {
      layerRef.current = L.markerClusterGroup();
      map.addLayer(layerRef.current);
    }
    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [map]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    markersRef.current = {};
    for (const p of points) {
      const serialKey = String(p.serial_number || '').toUpperCase();
      const ic = markerIcon(markerColor(p.status), {
        highlight: Boolean(highlightSerial && serialKey && serialKey === highlightSerial.toUpperCase()),
      });
      const m = L.marker([p.latitude, p.longitude], { icon: ic });
      const histPath = `/history?serial=${encodeURIComponent(serialKey)}&range=7d`;
      const mapPath = `/trackers/${encodeURIComponent(serialKey)}/map`;
      const statusText =
        p.status === 'low' ? popupLabels.lowBattery : p.status === 'active' ? popupLabels.active : popupLabels.offline;
      const locLine = `<div><span style="opacity:.75">${escapeHtml(popupLabels.lastKnownLocation)}:</span> ${formatCoord(p.latitude)}, ${formatCoord(p.longitude)}</div>`;
      m.bindPopup(
        `<div style="font-family: Inter, system-ui; font-size: 12px; min-width: 200px; color:#111827;">
          <div style="font-weight:600;margin-bottom:6px">${escapeHtml(p.name || 'Tracker')}</div>
          <div><span style="opacity:.75">${escapeHtml(popupLabels.serial)}:</span> ${escapeHtml(serialKey)}</div>
          <div><span style="opacity:.75">${escapeHtml(popupLabels.battery)}:</span> ${p.batteryPercent ?? '—'}%</div>
          <div><span style="opacity:.75">${escapeHtml(popupLabels.statusHeader)}:</span> ${escapeHtml(statusText)}</div>
          <div><span style="opacity:.75">${escapeHtml(popupLabels.lastSeen)}:</span> ${p.time ? escapeHtml(new Date(p.time).toLocaleString()) : '—'}</div>
          ${locLine}
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
            <a href="${mapPath}" style="color:#7c3aed;font-weight:600">${escapeHtml(popupLabels.viewMap)}</a>
            <a href="${histPath}" style="color:#2563eb;font-weight:600">${escapeHtml(popupLabels.history)}</a>
          </div>
        </div>`
      );
      layer.addLayer(m);
      if (serialKey) markersRef.current[serialKey] = m;
    }
  }, [points, highlightSerial, popupLabels]);

  return null;
}

function MapFlyTo({ latlng, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (!latlng) return;
    map.flyTo(latlng, zoom, { duration: 0.85 });
  }, [map, latlng, zoom]);
  return null;
}

function resolveShellTitle(pathname, t) {
  if (pathname === '/') return t('shellPageTitleDashboard');
  if (pathname === '/trackers') return t('navTrackers');
  if (pathname === '/history') return t('navHistory');
  if (pathname === '/offline-investigation') return t('navOfflineInvestigation');
  if (pathname === '/settings') return t('navSettings');
  if (pathname === '/admin/users') return t('navAdminUsers');
  if (pathname === '/admin/devices') return t('navAdminDevices');
  const m = matchPath('/trackers/:serialNumber/map', pathname);
  if (m?.params?.serialNumber) {
    try {
      return `${t('trackerMapTitle')} · ${decodeURIComponent(m.params.serialNumber)}`;
    } catch {
      return `${t('trackerMapTitle')} · ${m.params.serialNumber}`;
    }
  }
  const d = matchPath('/devices/:deviceId', pathname);
  if (d?.params?.deviceId) return t('details');
  return t('title');
}

function Shell({ auth, children }) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const headerTitle = useMemo(() => resolveShellTitle(location.pathname, t), [location.pathname, t]);

  useEffect(() => {
    document.title = t('browserTitle');
  }, [t, i18n.language]);

  const navCls = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
      isActive ? 'bg-accent-soft text-accent shadow-sm' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
    }`;

  return (
    <div className="flex min-h-screen w-full bg-[#F8FAFC] text-gray-900">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white md:sticky md:top-0 md:max-h-screen md:self-start md:overflow-y-auto">
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-blue-600 text-white shadow-md ring-2 ring-white">
              <Radar className="h-6 w-6" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="text-[16px] font-bold leading-tight tracking-tight text-gray-900">{t('brandName')}</div>
              <div className="text-xs font-medium text-gray-500">{t('brandSubtitle')}</div>
            </div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3">
          <NavLink to="/" end className={navCls}>
            <LayoutDashboard className="h-5 w-5 shrink-0 opacity-80" />
            {t('navDashboard')}
          </NavLink>
          <NavLink to="/trackers" className={navCls}>
            <MapPin className="h-5 w-5 shrink-0 opacity-80" />
            {t('navTrackers')}
          </NavLink>
          <NavLink to="/history" className={navCls}>
            <HistoryIcon className="h-5 w-5 shrink-0 opacity-80" />
            {t('navHistory')}
          </NavLink>
          <NavLink to="/offline-investigation" className={navCls}>
            <Radio className="h-5 w-5 shrink-0 opacity-80" />
            {t('navOfflineInvestigation')}
          </NavLink>
          {auth.user?.role === 'admin' && (
            <NavLink to="/admin/users" className={navCls}>
              <Users className="h-5 w-5 shrink-0 opacity-80" />
              {t('navAdminUsers')}
            </NavLink>
          )}
          <NavLink to="/settings" className={navCls}>
            <Settings className="h-5 w-5 shrink-0 opacity-80" />
            {t('navSettings')}
          </NavLink>
          {auth.user?.role === 'admin' && (
            <NavLink
              to="/admin/devices"
              className={({ isActive }) =>
                `${navCls({ isActive })} mt-2 border-t border-gray-100 pt-2`
              }
            >
              <Shield className="h-5 w-5 shrink-0 opacity-80" />
              {t('navAdminDevices')}
            </NavLink>
          )}
        </nav>
        <div className="mt-auto border-t border-gray-100 p-4">
          <div className="truncate text-xs font-medium text-gray-900">{auth.user?.email}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              onClick={() => {
                const lng = i18n.language.startsWith('ro') ? 'en' : 'ro';
                i18n.changeLanguage(lng);
                localStorage.setItem('lang', lng);
              }}
            >
              <Languages className="h-3.5 w-3.5" />
              {t('toggleLang')}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
              onClick={auth.logout}
            >
              <LogOut className="h-3.5 w-3.5" />
              {t('logout')}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 md:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h1 className="truncate text-lg font-semibold text-gray-900">{headerTitle}</h1>
            <span className="hidden shrink-0 rounded-lg bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent md:inline">
              {t('platformBadge')}
            </span>
          </div>
          <AlertsBell />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-t border-gray-200 bg-white px-2 py-2 md:hidden">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium ${
              isActive ? 'bg-accent-soft text-accent' : 'text-gray-600'
            }`
          }
        >
          {t('navDashboard')}
        </NavLink>
        <NavLink
          to="/trackers"
          className={({ isActive }) =>
            `whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium ${
              isActive ? 'bg-accent-soft text-accent' : 'text-gray-600'
            }`
          }
        >
          {t('navTrackers')}
        </NavLink>
        <NavLink
          to="/history"
          className={({ isActive }) =>
            `whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium ${
              isActive ? 'bg-accent-soft text-accent' : 'text-gray-600'
            }`
          }
        >
          {t('navHistory')}
        </NavLink>
        <NavLink
          to="/offline-investigation"
          className={({ isActive }) =>
            `whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium ${
              isActive ? 'bg-accent-soft text-accent' : 'text-gray-600'
            }`
          }
        >
          {t('navOfflineInvestigation')}
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium ${
              isActive ? 'bg-accent-soft text-accent' : 'text-gray-600'
            }`
          }
        >
          {t('navSettings')}
        </NavLink>
        </nav>
      </div>
    </div>
  );
}

function LoginPage({ auth }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = mode === 'login' ? await authLogin(email, password) : await authRegister(email, password);
      const access = r.accessToken || r.token;
      auth.setSession(access, r.refreshToken, r.user);
      nav('/');
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    document.title = t('browserTitle');
  }, [t]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4">
      <div className="w-full max-w-md rounded-[22px] border border-gray-100 bg-white p-8 shadow-cardHover">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-blue-600 text-white shadow-lg ring-4 ring-violet-100">
            <Radar className="h-9 w-9" strokeWidth={2} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">
            {mode === 'login' ? t('welcomeLoginTitle') : t('register')}
          </h1>
          <p className="mt-2 max-w-sm text-sm text-gray-500">
            {mode === 'login' ? t('welcomeLoginSubtitle') : t('authHint')}
          </p>
        </div>
        {err && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
        )}
        <div className="mt-6 space-y-3">
          <input
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none ring-accent/10 placeholder:text-gray-400 focus:border-accent focus:ring-2"
            placeholder={t('email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
            placeholder={t('password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            className="w-full rounded-xl bg-accent px-3 py-3 text-sm font-semibold text-white shadow-sm hover:bg-violet-600 disabled:opacity-60"
            onClick={submit}
            disabled={busy}
          >
            {busy ? t('loading') : mode === 'login' ? t('login') : t('register')}
          </button>
          <button
            className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? t('switchToRegister') : t('switchToLogin')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [refreshMs, setRefreshMs] = useState(2000);
  const [devices, setDevices] = useState([]);
  const [latestById, setLatestById] = useState({});
  const [searchQuery, setSearchQuery] = useState('');
  const [mapFilter, setMapFilter] = useState('all');
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);
  const markersRef = useRef({});
  const handledFocusKeyRef = useRef(null);
  const [highlightSerial, setHighlightSerial] = useState(null);
  const [flyTo, setFlyTo] = useState(null);
  const searchWrapRef = useRef(null);
  const [searchFocused, setSearchFocused] = useState(false);

  const popupLabels = useMemo(
    () => ({
      serial: t('serial'),
      battery: t('battery'),
      statusHeader: t('statusLabel'),
      lastSeen: t('lastSeen'),
      lastKnownLocation: t('lastKnownLocation'),
      history: t('history'),
      viewMap: t('viewMap'),
      active: t('active'),
      offline: t('offline'),
      lowBattery: t('lowBattery'),
    }),
    [t]
  );

  const focusSerialRaw = searchParams.get('focus');
  const focusSerial = focusSerialRaw ? focusSerialRaw.trim().toUpperCase() : '';

  const load = async () => {
    setErr(null);
    try {
      const r = await listDevices();
      setDevices(r.devices || []);
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  useEffect(() => {
    if (!devices.length) return;
    let cancelled = false;
    const run = async () => {
      const next = {};
      await Promise.all(
        devices.map(async (d) => {
          try {
            const r = await getLatestById(d.id);
            next[d.id] = r.latest;
          } catch {}
        })
      );
      if (!cancelled) setLatestById(next);
    };
    run();
    const id = setInterval(run, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [devices, refreshMs]);

  const searchSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return devices.filter((d) => {
      const serial = String(d.serial_number || '').toLowerCase();
      const name = String(d.name || '').toLowerCase();
      return serial.includes(q) || name.includes(q);
    });
  }, [devices, searchQuery]);

  useEffect(() => {
    const fn = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) setSearchFocused(false);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const points = useMemo(() => {
    return devices
      .map((d) => {
        const l = latestById[d.id];
        if (!l || !Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return null;
        const battery = typeof l.batteryPercent === 'number' ? l.batteryPercent : null;
        const status =
          l.status === 'offline'
            ? 'offline'
            : battery != null && battery < 20
              ? 'low'
              : l.status || 'offline';
        return {
          ...d,
          latitude: l.latitude,
          longitude: l.longitude,
          batteryPercent: battery,
          time: l.time,
          status,
        };
      })
      .filter(Boolean);
  }, [devices, latestById]);

  const mapPoints = useMemo(() => {
    if (mapFilter === 'all') return points;
    return points.filter((p) => {
      if (mapFilter === 'active') return p.status === 'active';
      if (mapFilter === 'offline') return p.status === 'offline';
      if (mapFilter === 'low') return p.status === 'low';
      return true;
    });
  }, [points, mapFilter]);

  const dashboardStats = useMemo(() => {
    let online = 0;
    let offline = 0;
    let low = 0;
    for (const d of devices) {
      const l = latestById[d.id];
      if (!l) continue;
      const battery = typeof l.batteryPercent === 'number' ? l.batteryPercent : null;
      const st =
        l.status === 'offline'
          ? 'offline'
          : battery != null && battery < 20
            ? 'low'
            : l.status || 'offline';
      if (st === 'active') online += 1;
      else if (st === 'offline') offline += 1;
      else if (st === 'low') low += 1;
    }
    return { total: devices.length, online, offline, low };
  }, [devices, latestById]);

  const [companySummary, setCompanySummary] = useState(null);
  useEffect(() => {
    let c = true;
    (async () => {
      try {
        const { companies } = await listCompanies();
        if (!c) return;
        const gt = companies?.find((x) => String(x.slug).toLowerCase() === 'geotrackr');
        if (!gt) {
          setCompanySummary(null);
          return;
        }
        const s = await getCompanySummary(gt.id);
        if (c) setCompanySummary(s);
      } catch {
        if (c) setCompanySummary(null);
      }
    })();
    return () => {
      c = false;
    };
  }, [devices.length, refreshMs]);

  const [dashAlerts, setDashAlerts] = useState([]);
  useEffect(() => {
    let c = true;
    const pull = async () => {
      try {
        const a = await listAlerts();
        if (c) setDashAlerts(a.alerts?.slice(0, 8) || []);
      } catch {
        if (c) setDashAlerts([]);
      }
    };
    pull();
    const id = window.setInterval(pull, 25000);
    return () => {
      c = false;
      window.clearInterval(id);
    };
  }, [refreshMs]);

  const me = useMe();
  const showGeoCompanyCard =
    companySummary &&
    (me?.role === 'admin' ||
      String(me?.email || '')
        .toLowerCase()
        .includes('geotrackr') ||
      devices.some((d) => isGeoTrackrFleetSerial(d.serial_number)));

  const goToTrackerMap = (serial) => {
    const s = String(serial || '').trim();
    if (!s) return;
    setSearchQuery('');
    setSearchFocused(false);
    navigate(`/trackers/${encodeURIComponent(s)}/map`);
  };

  const onSearchKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (searchSuggestions.length === 1) {
      goToTrackerMap(searchSuggestions[0].serial_number);
      return;
    }
    const q = searchQuery.trim().toLowerCase();
    const exact = devices.find(
      (d) => String(d.serial_number).toLowerCase() === q || String(d.name || '').toLowerCase() === q
    );
    if (exact) {
      goToTrackerMap(exact.serial_number);
      return;
    }
    if (searchSuggestions.length > 0) {
      goToTrackerMap(searchSuggestions[0].serial_number);
      return;
    }
    setToast(t('toastTrackerNotFound'));
    setTimeout(() => setToast(null), 3200);
  };

  useEffect(() => {
    if (!focusSerial) return;

    const focusToken = focusSerialRaw || '';
    const focusKey = `${focusToken}`;
    // Prevent loops on refresh/polling: handle once per distinct focus query value.
    if (handledFocusKeyRef.current === focusKey) return;

    const device = devices.find((d) => String(d.serial_number || '').toUpperCase() === focusSerial);
    if (!device) {
      setToast(t('focusNotFound'));
      setTimeout(() => setToast(null), 3500);
      handledFocusKeyRef.current = focusKey;

      const next = new URLSearchParams(searchParams);
      next.delete('focus');
      setSearchParams(next, { replace: true });
      return;
    }

    const l = latestById[device.id];
    const hasLoc =
      l &&
      Number.isFinite(l.latitude) &&
      Number.isFinite(l.longitude);

    if (!hasLoc) {
      // Wait until latest fetch completes for this device at least once.
      if (!(device.id in latestById)) return;

      setToast(t('focusNoLocation'));
      setTimeout(() => setToast(null), 3500);
      handledFocusKeyRef.current = focusKey;

      const next = new URLSearchParams(searchParams);
      next.delete('focus');
      setSearchParams(next, { replace: true });
      return;
    }

    handledFocusKeyRef.current = focusKey;

    setFlyTo({ lat: l.latitude, lng: l.longitude });
    setHighlightSerial(focusSerial);

    // Wait until markers are recreated for this points render.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const m = markersRef.current[focusSerial];
        if (m) {
          m.openPopup();
        }
      });
    });

    window.setTimeout(() => setHighlightSerial(null), 4500);

    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }, [devices, latestById, focusSerial, focusSerialRaw, searchParams, setSearchParams, t]);

  return (
    <div className="relative flex flex-col bg-[#F8FAFC] pb-8">
      {err && (
        <div className="absolute left-4 right-4 top-3 z-[50] rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 shadow-card md:left-auto md:right-8 md:top-4 md:max-w-md">
          {err}
        </div>
      )}
      {toast && (
        <div className="fixed bottom-20 left-1/2 z-[60] max-w-sm -translate-x-1/2 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm text-gray-900 shadow-cardHover md:bottom-8">
          {toast}
        </div>
      )}

      <div className="shrink-0 space-y-4 px-4 pb-3 pt-4 md:px-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-[20px] border border-gray-100 bg-white p-5 shadow-card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-3xl font-bold tabular-nums text-gray-900">{dashboardStats.total}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('statTotalTrackers')}</div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-accent">
                <Boxes className="h-5 w-5" strokeWidth={2} />
              </div>
            </div>
          </div>
          <div className="rounded-[20px] border border-gray-100 bg-white p-5 shadow-card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-3xl font-bold tabular-nums text-emerald-600">{dashboardStats.online}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('statOnline')}</div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                <Signal className="h-5 w-5" strokeWidth={2} />
              </div>
            </div>
          </div>
          <div className="rounded-[20px] border border-gray-100 bg-white p-5 shadow-card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-3xl font-bold tabular-nums text-red-600">{dashboardStats.offline}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('statOffline')}</div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50 text-red-600">
                <WifiOff className="h-5 w-5" strokeWidth={2} />
              </div>
            </div>
          </div>
          <div className="rounded-[20px] border border-gray-100 bg-white p-5 shadow-card">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-3xl font-bold tabular-nums text-amber-600">{dashboardStats.low}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-400">{t('statLowBattery')}</div>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                <BatteryWarning className="h-5 w-5" strokeWidth={2} />
              </div>
            </div>
          </div>
        </div>

        {showGeoCompanyCard ? (
          <div className="rounded-[20px] border border-violet-100 bg-gradient-to-br from-white to-violet-50/50 p-5 shadow-card">
            <div className="mb-4 text-sm font-bold text-gray-900">{t('companyGeoTrackrTitle')}</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-violet-100/80 bg-white/90 px-4 py-3 shadow-sm">
                <div className="text-2xl font-bold tabular-nums text-gray-900">{companySummary.total_trackers}</div>
                <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  {t('statTotalTrackers')}
                </div>
              </div>
              <div className="rounded-xl border border-violet-100/80 bg-white/90 px-4 py-3 shadow-sm">
                <div className="text-2xl font-bold tabular-nums text-emerald-600">{companySummary.online_trackers}</div>
                <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">{t('statOnline')}</div>
              </div>
              <div className="rounded-xl border border-violet-100/80 bg-white/90 px-4 py-3 shadow-sm">
                <div className="text-2xl font-bold tabular-nums text-red-600">{companySummary.offline_trackers}</div>
                <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">{t('statOffline')}</div>
              </div>
              <div className="rounded-xl border border-violet-100/80 bg-white/90 px-4 py-3 shadow-sm">
                <div className="text-2xl font-bold tabular-nums text-amber-600">{companySummary.low_battery_trackers}</div>
                <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">{t('statLowBattery')}</div>
              </div>
            </div>
          </div>
        ) : null}

        {dashAlerts.length > 0 ? (
          <div className="rounded-[20px] border border-gray-100 bg-white p-5 shadow-card">
            <div className="mb-3 text-sm font-semibold text-gray-900">{t('recentAlerts')}</div>
            <ul className="space-y-3">
              {dashAlerts.map((al) => (
                <li
                  key={al.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-gray-50 bg-gray-50/80 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          al.type === 'offline'
                            ? 'bg-red-50 text-red-700 ring-1 ring-red-100'
                            : 'bg-amber-50 text-amber-800 ring-1 ring-amber-100'
                        }`}
                      >
                        {al.type === 'offline' ? t('offline') : t('lowBattery')}
                      </span>
                      <span className="font-mono text-xs font-semibold text-gray-900">{al.serial_number}</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-600">{al.message}</p>
                    <p className="mt-0.5 text-[10px] text-gray-400">{formatTime(al.created_at)}</p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-xs font-semibold text-accent hover:underline"
                    onClick={() => navigate(`/trackers/${encodeURIComponent(al.serial_number)}/map`)}
                  >
                    {t('viewTracker')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="sticky top-0 z-[45] shrink-0 border-b border-gray-100/90 bg-[#F8FAFC]/95 px-4 py-3 backdrop-blur-md md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div ref={searchWrapRef} className="relative w-full max-w-md">
          <input
            type="search"
            className="w-full rounded-2xl border border-gray-200 bg-white py-3 pl-4 pr-4 text-sm text-gray-900 shadow-card outline-none ring-accent/20 transition placeholder:text-gray-400 focus:border-accent focus:ring-2"
            placeholder={t('dashboardSearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchFocused(true);
            }}
            onFocus={() => setSearchFocused(true)}
            onKeyDown={onSearchKeyDown}
            autoComplete="off"
          />
          {searchFocused && searchQuery.trim() && searchSuggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-50 mt-2 max-h-64 overflow-auto rounded-2xl border border-gray-100 bg-white py-2 shadow-cardHover">
              {searchSuggestions.slice(0, 10).map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left text-sm hover:bg-gray-50"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goToTrackerMap(d.serial_number)}
                  >
                    <span className="font-medium text-gray-900">{d.name}</span>
                    <span className="font-mono text-xs text-gray-500">{d.serial_number}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-card md:py-2">
          <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
            {t('mapFilter')}
            <select
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              value={mapFilter}
              onChange={(e) => setMapFilter(e.target.value)}
            >
              <option value="all">{t('filterAll')}</option>
              <option value="active">{t('filterActive')}</option>
              <option value="offline">{t('filterOffline')}</option>
              <option value="low">{t('filterLowBattery')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
            {t('refresh')}
            <select
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              value={refreshMs}
              onChange={(e) => setRefreshMs(Number(e.target.value))}
            >
              {REFRESH_CHOICES.map((ms) => (
                <option key={ms} value={ms}>
                  {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
                </option>
              ))}
            </select>
          </label>
        </div>
        </div>
      </div>

      <div className="relative mx-4 mt-3 md:mx-6 md:mt-4">
        {devices.length === 0 && !err && (
          <div className="absolute inset-0 z-[40] flex items-center justify-center rounded-[22px] bg-[#F8FAFC]/95 p-6">
            <EmptyState title={t('emptyNoTrackers')} subtitle={t('emptyNoTrackersHint')} />
          </div>
        )}
        <MapContainer
          center={[45.9432, 24.9668]}
          zoom={6}
          className="z-0 min-h-[380px] h-[58vh] max-h-[640px] w-full rounded-[22px] border border-gray-100 bg-white shadow-card"
        >
          <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <style>{`
            @keyframes dmPulse {
              0% { transform: scale(1); filter: brightness(1); }
              50% { transform: scale(1.25); filter: brightness(1.25); }
              100% { transform: scale(1); filter: brightness(1); }
            }
          `}</style>
          {flyTo ? <MapFlyTo latlng={[flyTo.lat, flyTo.lng]} zoom={16} /> : null}
          <MarkerClusterLayer
            points={mapPoints}
            highlightSerial={highlightSerial}
            markersRef={markersRef}
            popupLabels={popupLabels}
          />
        </MapContainer>

        <MapLegend />

        <Dialog.Root>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="pointer-events-auto absolute bottom-6 right-6 z-[46] flex h-14 w-14 items-center justify-center rounded-full bg-accent text-lg font-semibold text-white shadow-cardHover transition hover:bg-violet-600"
              aria-label={t('addTracker')}
            >
              +
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-gray-200 bg-white p-6 shadow-cardHover">
              <Dialog.Title className="text-base font-semibold text-gray-900">{t('addTrackerBySerial')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-gray-500">{t('addTrackerHint')}</Dialog.Description>
              <AddBySerialForm
                onSuccess={(msg) => {
                  setToast(msg);
                  setTimeout(() => setToast(null), 2500);
                  load();
                }}
              />
              <div className="mt-4 flex justify-end">
                <Dialog.Close className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  {t('close')}
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </div>
  );
}

function AddBySerialForm({ onSuccess }) {
  const { t } = useTranslation();
  const [serial, setSerial] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(null);

  const runRegister = async (serialNorm, nameVal) => {
    const r = await registerDeviceBySerial(serialNorm, nameVal || undefined);
    onSuccess(r.message === 'tracker_already_associated' ? t('alreadyAssociated') : t('associatedOk'));
    setSerial('');
    setName('');
  };

  const submit = async () => {
    setErr(null);
    const serialNorm = serial.trim().toUpperCase();
    if (serialNorm.length < 3) {
      setErr(t('invalidSerial'));
      return;
    }
    setBusy(true);
    try {
      const st = await fetchDeviceBySerialStatus(serialNorm);
      if (st.status === 200) {
        onSuccess(t('alreadyAssociated'));
        setSerial('');
        setName('');
        return;
      }
      if (st.status === 404) {
        await runRegister(serialNorm, name);
        return;
      }
      if (st.status === 403 && st.data?.canRegister) {
        setPending({ serial: serialNorm, name });
        setConfirmOpen(true);
        return;
      }
      if (st.status === 401) {
        setErr(t('sessionExpired'));
        return;
      }
      setErr(t('associateForbidden'));
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const confirmAssociate = async () => {
    if (!pending) return;
    setConfirmOpen(false);
    setBusy(true);
    setErr(null);
    try {
      await runRegister(pending.serial, pending.name);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      )}
      <input
        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
        placeholder={t('serialNumber')}
        value={serial}
        onChange={(e) => setSerial(e.target.value)}
      />
      <input
        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
        placeholder={t('deviceNameOptional')}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        className="w-full rounded-xl bg-accent px-3 py-3 text-sm font-semibold text-white shadow-sm hover:bg-violet-600 disabled:opacity-60"
        onClick={submit}
        disabled={busy || serial.trim().length < 3}
      >
        {busy ? t('loading') : t('add')}
      </button>

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-gray-200 bg-white p-6 shadow-cardHover">
            <Dialog.Title className="text-base font-semibold text-gray-900">{t('confirmAssociateTitle')}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-500">{t('confirmAssociateBody')}</Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                onClick={() => setConfirmOpen(false)}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-violet-600"
                onClick={confirmAssociate}
              >
                {t('confirm')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function OfflineInvestigationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      setErr(null);
      try {
        const r = await listOfflineDevices();
        if (!cancelled) setRows(r.devices || []);
      } catch (e) {
        if (!cancelled) setErr(String(e.message || e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-[#F8FAFC]">
      <div className="border-b border-gray-200 bg-white px-4 py-5 shadow-sm md:px-8">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('navOfflineInvestigation')}</div>
        <div className="mt-1 text-xl font-semibold text-gray-900">{t('offlineInvestigationTitle')}</div>
        <p className="mt-2 max-w-2xl text-sm text-gray-500">{t('offlineInvestigationHint')}</p>
      </div>
      {err && (
        <div className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 md:mx-8">
          {err}
        </div>
      )}
      <div className="p-4 md:p-8">
        {busy ? (
          <div className="text-sm text-gray-500">{t('loading')}</div>
        ) : !rows.length ? (
          <EmptyState title={t('emptyNoOfflineDevices')} subtitle={t('emptyNoOfflineDevicesHint')} />
        ) : (
          <div className="overflow-hidden rounded-[20px] border border-gray-100 bg-white shadow-card">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">{t('serial')}</th>
                  <th className="px-4 py-3">{t('name')}</th>
                  <th className="px-4 py-3">{t('owner')}</th>
                  <th className="px-4 py-3">{t('lastSeen')}</th>
                  <th className="px-4 py-3">{t('lastKnownLocation')}</th>
                  <th className="px-4 py-3">{t('battery')}</th>
                  <th className="px-4 py-3">{t('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((d) => (
                  <tr key={d.device_id} className="hover:bg-gray-50/80">
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">{d.serial_number}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{d.name}</td>
                    <td className="px-4 py-3 text-gray-600">{d.owner_email}</td>
                    <td className="px-4 py-3 text-xs text-gray-600">{d.last_seen ? formatTime(d.last_seen) : '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">
                      {Number.isFinite(d.last_known_latitude) && Number.isFinite(d.last_known_longitude)
                        ? `${formatCoord(d.last_known_latitude)}, ${formatCoord(d.last_known_longitude)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-900">{d.battery_percent != null ? `${d.battery_percent}%` : '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                          onClick={() =>
                            navigate(`/history?serial=${encodeURIComponent(d.serial_number)}&range=7d`)
                          }
                        >
                          {t('viewHistory')}
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-600"
                          onClick={() =>
                            navigate(`/trackers/${encodeURIComponent(d.serial_number)}/map`)
                          }
                        >
                          {t('focusOnMap')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [serial, setSerial] = useState(() => searchParams.get('serial') || '');
  const [range, setRange] = useState(() => {
    const r = searchParams.get('range');
    return HISTORY_RANGES.includes(r) ? r : '24h';
  });
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const fetchHistory = async (s, rng) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await getHistoryBySerial(s, rng);
      setData(r);
    } catch (e) {
      setErr(String(e.message || e));
      setData(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const s = searchParams.get('serial')?.trim() || '';
    const r = searchParams.get('range');
    const rng = HISTORY_RANGES.includes(r) ? r : '24h';
    if (s) setSerial(s);
    if (r && HISTORY_RANGES.includes(r)) setRange(rng);
    if (s.length >= 3) fetchHistory(s, rng);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- URL-driven load only
  }, [searchParams]);

  const onSearchClick = () => {
    const s = serial.trim();
    if (s.length < 3) return;
    setSearchParams({ serial: s, range });
  };

  const path = useMemo(() => {
    const pts = data?.points || [];
    return pts.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)).map((p) => [p.latitude, p.longitude]);
  }, [data]);

  const batterySeries = useMemo(() => {
    const pts = data?.points || [];
    return pts.map((p) => ({ t: new Date(p.t).toLocaleTimeString(), v: p.batteryPercent }));
  }, [data]);

  const last = data?.points?.[data.points.length - 1];
  const lastAgeMs = last?.t ? Date.now() - new Date(last.t).getTime() : 0;
  const lastIsOffline = lastAgeMs > 24 * 3600 * 1000;
  const lastMarkerColor = lastIsOffline ? '#ef4444' : '#22c55e';

  return (
    <div className="flex min-h-full flex-col bg-[#F8FAFC]">
      <div className="border-b border-gray-200 bg-white px-4 py-5 shadow-sm md:px-8">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('navHistory')}</div>
        <div className="mt-1 text-xl font-semibold text-gray-900">{t('historyTitle')}</div>
        <div className="mt-4 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <input
            className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-2 focus:ring-accent/20 md:min-w-[240px]"
            placeholder={t('serialNumber')}
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
          />
          <select
            className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            {HISTORY_RANGES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-violet-600 disabled:opacity-60"
            onClick={onSearchClick}
            disabled={busy || serial.trim().length < 3}
          >
            {busy ? t('loading') : t('search')}
          </button>
        </div>
        {err && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 md:p-8 lg:grid-cols-2">
        <div className="min-h-[320px] overflow-hidden rounded-[20px] border border-gray-100 bg-white shadow-card lg:min-h-[480px]">
          <MapContainer
            center={[45.9432, 24.9668]}
            zoom={6}
            className="min-h-[320px] h-[50vh] max-h-[520px] w-full lg:min-h-[480px] lg:h-[480px]"
          >
            <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {path.length > 1 && <Polyline positions={path} pathOptions={{ color: '#7c3aed', weight: 4, opacity: 0.9 }} />}
            {last && Number.isFinite(last.latitude) && Number.isFinite(last.longitude) && (
              <Marker position={[last.latitude, last.longitude]} icon={markerIcon(lastMarkerColor)}>
                <Popup>
                  <div className="text-xs">
                    <div className="font-semibold">{serial.trim().toUpperCase()}</div>
                    <div>
                      {t('statusLabel')}: {lastIsOffline ? t('offline') : t('active')}
                    </div>
                    <div>
                      {t('lastTransmission')}: {formatTime(last.t)}
                    </div>
                    <div>
                      {t('battery')}: {last.batteryPercent}%
                    </div>
                    <div>
                      {t('lastKnownLocation')}: {formatCoord(last.latitude)}, {formatCoord(last.longitude)}
                    </div>
                  </div>
                </Popup>
              </Marker>
            )}
          </MapContainer>
        </div>

        <div className="space-y-4">
          <div className="rounded-[20px] border border-gray-100 bg-white shadow-card p-4">
            <div className="text-sm font-semibold">{t('batteryOverTime')}</div>
            <div className="mt-3 h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={batterySeries}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="v" stroke="#7c3aed" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-[20px] border border-gray-100 bg-white shadow-card p-4">
            <div className="text-sm font-semibold">{t('latestPoints')}</div>
            <div className="mt-3 max-h-56 overflow-auto text-xs text-gray-600">
              {(data?.points || []).slice(-30).reverse().map((p) => (
                <div key={p.t} className="border-b border-gray-100 py-2">
                  <div className="text-xs text-gray-400">{formatTime(p.t)}</div>
                  <div className="text-gray-800">
                    {p.latitude?.toFixed?.(5)}, {p.longitude?.toFixed?.(5)} — {t('battery')}: {p.batteryPercent}%
                  </div>
                </div>
              ))}
              {!data?.points?.length && (
                <EmptyState title={t('emptyNoDataRange')} subtitle={t('emptyHistoryHint')} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackerMapPage() {
  const { t } = useTranslation();
  const { serialNumber: serialParam } = useParams();
  const navigate = useNavigate();
  const serial = useMemo(() => decodeURIComponent(String(serialParam || '')).trim(), [serialParam]);
  const [range, setRange] = useState('24h');
  const [device, setDevice] = useState(null);
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);
  const [serialToast, setSerialToast] = useState(false);

  useEffect(() => {
    if (!serialToast) return undefined;
    const id = window.setTimeout(() => setSerialToast(false), 2800);
    return () => window.clearTimeout(id);
  }, [serialToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!serial || serial.length < 2) {
        setErr('not_found');
        setBusy(false);
        setDevice(null);
        return;
      }
      setBusy(true);
      setErr(null);
      try {
        const st = await fetchDeviceBySerialStatus(serial);
        if (st.status === 404) {
          if (!cancelled) {
            setErr('not_found');
            setDevice(null);
          }
          return;
        }
        if (st.status === 403) {
          if (!cancelled) {
            setErr('forbidden');
            setDevice(null);
          }
          return;
        }
        if (!st.ok || !st.data?.device) {
          if (!cancelled) setErr('other');
          return;
        }
        const dev = st.data.device;
        const [l, h] = await Promise.all([
          getLatestById(dev.id),
          getHistoryByDeviceId(dev.id, range),
        ]);
        if (!cancelled) {
          setDevice(dev);
          setLatest(l.latest);
          setHistory(h);
        }
      } catch {
        if (!cancelled) setErr('other');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serial, range]);

  const path = useMemo(() => {
    const pts = history?.points || [];
    return pts
      .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map((p) => [p.latitude, p.longitude]);
  }, [history]);

  const lastIsOffline =
    Boolean(latest?.time) && Date.now() - new Date(latest.time).getTime() > 24 * 3600 * 1000;
  const markerHue = lastIsOffline ? '#ef4444' : '#22c55e';

  if (busy && !err) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center bg-[#F8FAFC] p-8 text-sm text-gray-500">
        {t('loading')}
      </div>
    );
  }

  if (err === 'not_found') {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 bg-[#F8FAFC] p-8 text-center">
        <p className="text-gray-900">{t('toastTrackerNotFound')}</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-600"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('backToDashboard')}
        </Link>
      </div>
    );
  }

  if (err === 'forbidden') {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 bg-[#F8FAFC] p-8 text-center">
        <p className="text-gray-900">{t('toastTrackerNoAccess')}</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('backToDashboard')}
        </Link>
      </div>
    );
  }

  if (err === 'other') {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 bg-[#F8FAFC] p-8">
        <p className="text-sm text-red-600">{t('errorGeneric')}</p>
        <Link to="/" className="text-sm font-medium text-accent hover:underline">
          {t('backToDashboard')}
        </Link>
      </div>
    );
  }

  if (!device) return null;

  const hasLoc = latest && Number.isFinite(latest.latitude) && Number.isFinite(latest.longitude);
  const center = hasLoc ? [latest.latitude, latest.longitude] : [45.9432, 24.9668];

  const batteryNum = typeof latest?.batteryPercent === 'number' ? latest.batteryPercent : null;
  const rawStatus =
    latest?.status === 'offline'
      ? 'offline'
      : batteryNum != null && batteryNum < 20
        ? 'low'
        : latest?.status || 'offline';
  const badgeClass =
    rawStatus === 'active'
      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
      : rawStatus === 'low'
        ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
        : 'bg-red-50 text-red-700 ring-1 ring-red-200';
  const statusLabel =
    rawStatus === 'active' ? t('active') : rawStatus === 'low' ? t('lowBattery') : t('offline');

  return (
    <>
      <SerialCopiedToast visible={serialToast} message={t('serialCopiedToast')} />
      <div className="flex flex-col bg-[#F8FAFC] p-4 pb-10 md:p-6">
        <div className="mb-4 flex justify-end">
          <select
            className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            aria-label={t('mapTimeRange')}
          >
            {HISTORY_RANGES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col-reverse gap-6 lg:flex-row lg:items-stretch lg:gap-8">
          <div className="flex w-full flex-col rounded-[22px] border border-gray-100 bg-white shadow-card lg:min-w-0 lg:flex-1">
            {hasLoc ? (
              <MapContainer
                center={center}
                zoom={14}
                className="min-h-[380px] h-[55vh] max-h-[640px] w-full rounded-[22px]"
              >
                <TileLayer
                  attribution="&copy; OpenStreetMap contributors"
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {path.length > 1 && (
                  <Polyline positions={path} pathOptions={{ color: '#7c3aed', weight: 4, opacity: 0.88 }} />
                )}
                <Marker position={[latest.latitude, latest.longitude]} icon={markerIcon(markerHue)}>
                  <Popup>
                    <div className="text-xs text-gray-800">
                      <div className="font-semibold">{device.name}</div>
                      <div>
                        {t('statusLabel')}: {statusLabel}
                      </div>
                    </div>
                  </Popup>
                </Marker>
              </MapContainer>
            ) : (
              <div className="flex min-h-[320px] flex-1 items-center justify-center text-sm text-gray-500">
                {t('focusNoLocation')}
              </div>
            )}
          </div>

          <aside className="w-full shrink-0 lg:w-[300px] xl:w-[320px]">
            <div className="rounded-[20px] border border-gray-100 bg-white p-5 shadow-card lg:sticky lg:top-4">
              <h2 className="text-lg font-bold leading-tight text-gray-900">{device.name}</h2>

              <div className="mt-4">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('serial')}</div>
                <p className="mt-1 break-all font-mono text-sm font-semibold text-gray-900">{device.serial_number}</p>
              </div>

              <div className="mt-4">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('addedBy')}</div>
                <p className="mt-1 text-sm font-medium text-gray-900">{device.created_by_email || '—'}</p>
              </div>

              <div className="mt-4">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('statusLabel')}</div>
                <span className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${badgeClass}`}>
                  {statusLabel}
                </span>
              </div>

              <dl className="mt-5 space-y-4 text-sm">
                <div>
                  <dt className="flex items-center gap-2 text-xs font-medium text-gray-400">
                    <Battery className="h-3.5 w-3.5 text-accent" />
                    {t('battery')}
                  </dt>
                  <dd className="mt-1 font-semibold text-gray-900">
                    {latest?.batteryPercent != null ? `${latest.batteryPercent}%` : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs font-medium text-gray-400">
                    <Clock className="h-3.5 w-3.5 text-accent" />
                    {t('lastSeen')}
                  </dt>
                  <dd className="mt-1 font-medium leading-snug text-gray-900">
                    {latest?.time ? formatTime(latest.time) : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs font-medium text-gray-400">
                    <MapPin className="h-3.5 w-3.5 text-accent" />
                    {t('lastKnownLocation')}
                  </dt>
                  <dd className="mt-1 font-mono text-xs leading-relaxed text-gray-800">
                    {hasLoc ? `${formatCoord(latest.latitude)}, ${formatCoord(latest.longitude)}` : '—'}
                  </dd>
                </div>
              </dl>

              <div className="mt-6 flex flex-col gap-2 border-t border-gray-100 pt-5">
                <Link
                  to={`/history?serial=${encodeURIComponent(device.serial_number)}&range=7d`}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  <HistoryIcon className="h-4 w-4 text-accent" />
                  {t('history')}
                </Link>
                <CopySerialButton
                  serial={device.serial_number}
                  className="w-full"
                  onCopied={() => setSerialToast(true)}
                />
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-semibold text-gray-800 hover:bg-gray-100"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t('backToDashboard')}
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function TrackersPage() {
  const { t } = useTranslation();
  const me = useMe();
  const isAdmin = me?.role === 'admin';

  const [refreshMs, setRefreshMs] = useState(2000);
  const [devices, setDevices] = useState([]);
  const [latestById, setLatestById] = useState({});
  const [err, setErr] = useState(null);
  const [serialToast, setSerialToast] = useState(false);

  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [batterySort, setBatterySort] = useState('default');
  const [locationFilter, setLocationFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [adminUserEmails, setAdminUserEmails] = useState([]);

  useEffect(() => {
    if (!serialToast) return undefined;
    const id = window.setTimeout(() => setSerialToast(false), 2800);
    return () => window.clearTimeout(id);
  }, [serialToast]);

  useEffect(() => {
    if (!isAdmin) return;
    let c = true;
    (async () => {
      try {
        const r = await adminListUsers();
        if (!c) return;
        const emails = (r.users || []).map((u) => u.email).filter(Boolean);
        setAdminUserEmails(emails.sort());
      } catch {
        if (c) setAdminUserEmails([]);
      }
    })();
    return () => {
      c = false;
    };
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setErr(null);
      try {
        const r = await listDevices();
        const devs = r.devices || [];
        if (cancelled) return;
        setDevices(devs);

        const next = {};
        await Promise.all(
          devs.map(async (d) => {
            try {
              const r2 = await getLatestById(d.id);
              next[d.id] = r2.latest;
            } catch {}
          })
        );
        if (!cancelled) setLatestById(next);
      } catch (e) {
        if (!cancelled) setErr(String(e.message || e));
      }
    };
    run();
    const id = setInterval(run, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshMs]);

  const ownerEmailOptions = useMemo(() => {
    const fromDevices = [...new Set(devices.map((d) => d.created_by_email).filter(Boolean))];
    if (isAdmin && adminUserEmails.length) {
      return [...new Set([...adminUserEmails, ...fromDevices])].sort();
    }
    return fromDevices.sort();
  }, [devices, isAdmin, adminUserEmails]);

  const filteredSortedDevices = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const locQ = locationFilter.trim().toLowerCase();

    let rows = devices.map((d) => {
      const l = latestById[d.id];
      const statusKey = computeTrackerStatus(l);
      const battery =
        typeof l?.batteryPercent === 'number' && Number.isFinite(l.batteryPercent)
          ? l.batteryPercent
          : null;
      const locBlob = trackerLocationSearchBlob(l);
      const ownerEmail = String(d.created_by_email || '').toLowerCase();
      const serial = String(d.serial_number || '').toLowerCase();
      const name = String(d.name || '').toLowerCase();
      const company = String(d.company_name || '').toLowerCase();

      return { d, l, statusKey, battery, locBlob, ownerEmail, serial, name, company };
    });

    rows = rows.filter((row) => {
      if (ownerFilter !== 'all' && row.d.created_by_email !== ownerFilter) return false;

      if (statusFilter !== 'all' && row.statusKey !== statusFilter) return false;

      if (locQ && !row.locBlob.includes(locQ)) return false;

      if (q) {
        const hay = `${row.serial} ${row.name} ${row.ownerEmail} ${row.company} ${row.locBlob}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });

    if (batterySort === 'asc') {
      rows.sort((a, b) => {
        const ba = a.battery;
        const bb = b.battery;
        if (ba == null && bb == null) return 0;
        if (ba == null) return 1;
        if (bb == null) return -1;
        return ba - bb;
      });
    } else if (batterySort === 'desc') {
      rows.sort((a, b) => {
        const ba = a.battery;
        const bb = b.battery;
        if (ba == null && bb == null) return 0;
        if (ba == null) return 1;
        if (bb == null) return -1;
        return bb - ba;
      });
    }

    return rows.map((x) => x.d);
  }, [
    devices,
    latestById,
    searchText,
    statusFilter,
    batterySort,
    locationFilter,
    ownerFilter,
  ]);

  const resetFilters = () => {
    setSearchText('');
    setStatusFilter('all');
    setBatterySort('default');
    setLocationFilter('');
    setOwnerFilter('all');
  };

  const showFilterEmpty = filteredSortedDevices.length === 0 && devices.length > 0 && !err;
  const showNoDevices = devices.length === 0 && !err;

  return (
    <>
      <SerialCopiedToast visible={serialToast} message={t('serialCopiedToast')} />
      <div className="min-h-full w-full bg-[#F8FAFC] pb-12 pt-2 md:pt-4">
        <div className="mx-auto mb-4 flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 md:mb-6 md:px-8">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-500">
            {t('refresh')}
            <select
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              value={refreshMs}
              onChange={(e) => setRefreshMs(Number(e.target.value))}
            >
              {REFRESH_CHOICES.map((ms) => (
                <option key={ms} value={ms}>
                  {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mx-auto mb-6 max-w-7xl px-4 md:px-8">
          <div className="rounded-[20px] border border-gray-100 bg-white p-4 shadow-card md:p-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
              <div className="xl:col-span-2">
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {t('trackerFiltersSearchLabel')}
                </label>
                <input
                  type="search"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t('trackerFiltersSearchPlaceholder')}
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {t('trackerFilterStatus')}
                </label>
                <select
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">{t('filterAll')}</option>
                  <option value="active">{t('filterActive')}</option>
                  <option value="offline">{t('filterOffline')}</option>
                  <option value="low">{t('filterLowBattery')}</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {t('trackerFilterBatterySort')}
                </label>
                <select
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  value={batterySort}
                  onChange={(e) => setBatterySort(e.target.value)}
                >
                  <option value="default">{t('batterySortDefault')}</option>
                  <option value="asc">{t('batterySortAsc')}</option>
                  <option value="desc">{t('batterySortDesc')}</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {t('trackerFilterLocation')}
                </label>
                <input
                  type="text"
                  value={locationFilter}
                  onChange={(e) => setLocationFilter(e.target.value)}
                  placeholder={t('trackerFilterLocationPlaceholder')}
                  className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-2 focus:ring-accent/20"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {t('trackerFilterOwner')}
                </label>
                <select
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                  value={ownerFilter}
                  onChange={(e) => setOwnerFilter(e.target.value)}
                >
                  <option value="all">{t('filterOwnerAll')}</option>
                  {ownerEmailOptions.map((em) => (
                    <option key={em} value={em}>
                      {em}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-800 shadow-sm transition hover:bg-gray-100"
              >
                {t('resetFilters')}
              </button>
            </div>
          </div>
        </div>

        {err && (
          <div className="mx-auto mb-6 max-w-7xl rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 md:px-8">
            {err}
          </div>
        )}

        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-4 md:grid-cols-2 md:px-8 xl:grid-cols-3">
          {filteredSortedDevices.map((d) => {
            const l = latestById[d.id];
            const battery = typeof l?.batteryPercent === 'number' ? l.batteryPercent : null;
            const statusKey = computeTrackerStatus(l);
            const statusLabel =
              statusKey === 'active' ? t('active') : statusKey === 'low' ? t('lowBattery') : t('offline');
            const badgeClass =
              statusKey === 'active'
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : statusKey === 'low'
                  ? 'bg-amber-50 text-amber-800 ring-amber-200'
                  : 'bg-red-50 text-red-700 ring-red-200';

            return (
              <div
                key={d.id}
                className="group flex min-h-[340px] flex-col rounded-[22px] border border-gray-100 bg-white p-6 shadow-card transition duration-200 hover:-translate-y-1 hover:shadow-cardHover"
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent transition group-hover:bg-violet-100">
                    <MapPin className="h-7 w-7" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold tracking-tight text-gray-900">{d.name}</h3>
                    {isGeoTrackrFleetSerial(d.serial_number) && (
                      <span className="mt-1 inline-flex w-fit rounded-lg bg-violet-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200/90">
                        {t('geoTrackrFleetBadge')}
                      </span>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="break-all font-mono text-sm text-gray-600">{d.serial_number}</p>
                      <CopySerialButton serial={d.serial_number} onCopied={() => setSerialToast(true)} />
                    </div>
                    <p className="mt-3 text-sm text-gray-600">
                      <span className="font-medium text-gray-400">{t('addedBy')}: </span>
                      {d.created_by_email || '—'}
                    </p>
                    {d.company_name ? (
                      <p className="mt-1 text-sm text-gray-600">
                        <span className="font-medium text-gray-400">{t('company')}: </span>
                        {d.company_name}
                      </p>
                    ) : null}
                  </div>
                  <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${badgeClass}`}>
                    {statusLabel}
                  </span>
                </div>

                <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('battery')}</div>
                    <div className="mt-1 font-semibold text-gray-900">{battery != null ? `${battery}%` : '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('lastSeen')}</div>
                    <div className="mt-1 font-medium text-gray-800">{l?.time ? formatTime(l.time) : '—'}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
                      {t('lastKnownLocation')}
                    </div>
                    <div className="mt-1 font-mono text-xs leading-relaxed text-gray-700">
                      {formatTrackerLocationLine(l)}
                    </div>
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap gap-2 border-t border-gray-50 pt-6">
                  <Link
                    to={`/trackers/${encodeURIComponent(d.serial_number)}/map`}
                    className="inline-flex flex-1 min-w-[120px] items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-violet-600"
                  >
                    <MapPin className="h-4 w-4" />
                    {t('viewMap')}
                  </Link>
                  <Link
                    to={`/history?serial=${encodeURIComponent(d.serial_number)}&range=7d`}
                    className="inline-flex flex-1 min-w-[120px] items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-center text-sm font-semibold text-gray-800 shadow-sm hover:bg-gray-50"
                  >
                    <HistoryIcon className="h-4 w-4 text-accent" />
                    {t('history')}
                  </Link>
                  <button
                    type="button"
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50/80 px-4 py-2.5 text-sm font-semibold text-red-700 transition hover:bg-red-100 sm:w-auto sm:flex-none"
                    onClick={async () => {
                      if (!window.confirm(t('confirmUnassign'))) return;
                      try {
                        await unassignDevice(d.id);
                        setDevices((prev) => prev.filter((x) => x.id !== d.id));
                        setLatestById((prev) => {
                          const n = { ...prev };
                          delete n[d.id];
                          return n;
                        });
                      } catch (e) {
                        alert(String(e.message || e));
                      }
                    }}
                  >
                    <Unlink className="h-4 w-4" />
                    {t('removeFromAccount')}
                  </button>
                </div>
              </div>
            );
          })}
          {showNoDevices && (
            <div className="col-span-full">
              <EmptyState title={t('emptyNoTrackers')} subtitle={t('emptyNoTrackersHint')} />
            </div>
          )}
          {showFilterEmpty && (
            <div className="col-span-full">
              <EmptyState title={t('trackersNoMatchFilters')} subtitle={t('trackersResetFiltersHint')} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function EmptyState({ title, subtitle }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[22px] border border-dashed border-gray-200 bg-white px-8 py-14 text-center shadow-card">
      <div className="text-base font-semibold text-gray-900">{title}</div>
      {subtitle && <div className="mt-2 max-w-md text-sm text-gray-500">{subtitle}</div>}
    </div>
  );
}

function DeviceDetailsPage() {
  const { deviceId } = useParams();
  const nav = useNavigate();
  const { t } = useTranslation();
  const me = useMe();
  const [range, setRange] = useState('24h');
  const [device, setDevice] = useState(null);
  const [latest, setLatest] = useState(null);
  const [history, setHistory] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      setErr(null);
      try {
        const [d, l, h] = await Promise.all([
          getDeviceById(deviceId),
          getLatestById(deviceId),
          getHistoryByDeviceId(deviceId, range),
        ]);
        if (!cancelled) {
          setDevice(d.device);
          setLatest(l.latest);
          setHistory(h);
        }
      } catch (e) {
        if (!cancelled) setErr(String(e.message || e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, range]);

  const path = useMemo(() => {
    const pts = history?.points || [];
    return pts.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)).map((p) => [p.latitude, p.longitude]);
  }, [history]);

  const batterySeries = useMemo(() => {
    const pts = history?.points || [];
    return pts.map((p) => ({ t: new Date(p.t).toLocaleTimeString(), v: p.batteryPercent }));
  }, [history]);

  const statusLabel =
    latest?.status === 'low'
      ? t('lowBattery')
      : latest?.status === 'active'
        ? t('active')
        : t('offline');

  const onRemove = async () => {
    if (!window.confirm(t('confirmUnassign'))) return;
    await unassignDevice(deviceId);
    nav('/trackers');
  };

  const onAdminDelete = async () => {
    if (!window.confirm(t('confirmAdminDelete'))) return;
    await adminDeleteDevice(deviceId);
    nav('/admin/devices');
  };

  if (busy && !device && !err) {
    return (
      <div className="p-8 text-sm text-gray-500">{t('loading')}</div>
    );
  }

  if (err || !device) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm">{err || t('notFound')}</div>
        <button type="button" className="mt-4 text-sm text-sky-400 hover:underline" onClick={() => nav(-1)}>
          {t('back')}
        </button>
      </div>
    );
  }

  const hasTelemetry = latest?.latitude != null && latest?.longitude != null;
  const hasHistoryPoints = (history?.points?.length || 0) > 0;

  return (
    <div className="min-h-full w-full bg-[#F8FAFC]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-200 bg-white p-4 shadow-sm md:p-6">
        <div>
          <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => nav('/trackers')}>
            ← {t('navTrackers')}
          </button>
          <h1 className="mt-2 text-xl font-semibold text-gray-900">{device.name}</h1>
          <div className="mt-1 text-sm text-gray-500">
            {t('serial')}: {device.serial_number}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/trackers/${encodeURIComponent(device.serial_number)}/map`}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-800 shadow-sm hover:bg-gray-50"
          >
            {t('viewMap')}
          </Link>
          <select
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900 shadow-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            {HISTORY_RANGES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {me?.role !== 'admin' && (
            <button
              type="button"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
              onClick={onRemove}
            >
              {t('removeFromAccount')}
            </button>
          )}
          {me?.role === 'admin' && (
            <button
              type="button"
              className="rounded-xl border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
              onClick={onAdminDelete}
            >
              {t('deleteTrackerGlobal')}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 p-4 md:gap-8 md:p-8 xl:grid-cols-2">
        <div className="rounded-[20px] border border-gray-100 bg-white shadow-card p-4">
          <div className="text-sm font-semibold">{t('deviceInfo')}</div>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">{t('addedBy')}</dt>
              <dd>{device.created_by_email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">{t('statusLabel')}</dt>
              <dd>{statusLabel}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">{t('battery')}</dt>
              <dd>{latest?.batteryPercent != null ? `${latest.batteryPercent}%` : '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">{t('lastSeen')}</dt>
              <dd>{latest?.time ? formatTime(latest.time) : '—'}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-[20px] border border-gray-100 bg-white shadow-card p-4">
          <div className="text-sm font-semibold">{t('batteryOverTime')}</div>
          <div className="mt-3 h-48">
            {!hasHistoryPoints ? (
              <EmptyState title={t('emptyNoDataRange')} subtitle={t('emptyHistoryHint')} />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={batterySeries}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="v" stroke="#7c3aed" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="xl:col-span-2 min-h-[320px] overflow-hidden rounded-[20px] border border-gray-100 bg-white shadow-card">
          {!hasTelemetry ? (
            <div className="p-8">
              <EmptyState title={t('emptyNoTelemetryYet')} subtitle={t('emptyNoTelemetryHint')} />
            </div>
          ) : (
            <MapContainer
              center={[latest.latitude, latest.longitude]}
              zoom={14}
              className="h-[320px] w-full"
              key={`${latest.latitude}-${latest.longitude}`}
            >
              <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              {path.length > 1 && <Polyline positions={path} pathOptions={{ color: '#7c3aed', weight: 4, opacity: 0.9 }} />}
              <Marker position={[latest.latitude, latest.longitude]} icon={markerIcon(markerColor(latest.status))}>
                <Popup>
                  <div className="text-xs">
                    <div className="font-semibold">{device.name}</div>
                    <div>
                      {device.serial_number} — {statusLabel}
                    </div>
                  </div>
                </Popup>
              </Marker>
            </MapContainer>
          )}
        </div>

        <div className="xl:col-span-2 rounded-[20px] border border-gray-100 bg-white shadow-card p-4">
          <div className="text-sm font-semibold">{t('latestPoints')}</div>
          <div className="mt-3 max-h-64 overflow-auto text-xs">
            {!hasHistoryPoints ? (
              <div className="text-gray-500">{t('emptyNoDataRange')}</div>
            ) : (
              (history.points || [])
                .slice(-40)
                .reverse()
                .map((p) => (
                  <div key={p.t} className="border-b border-gray-100 py-2">
                    <div className="text-xs text-gray-400">{formatTime(p.t)}</div>
                    <div className="text-gray-800">
                      {p.latitude?.toFixed(5)}, {p.longitude?.toFixed(5)} — {t('battery')}: {p.batteryPercent}%
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminDevicesPage() {
  const me = useMe();
  const { t } = useTranslation();
  const [devices, setDevices] = useState([]);
  const [err, setErr] = useState(null);

  const load = async () => {
    setErr(null);
    try {
      const r = await adminListAllDevices();
      setDevices(r.devices || []);
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (me?.role !== 'admin') {
    return (
      <div className="bg-[#F8FAFC] p-8 text-sm text-gray-600">
        {t('adminOnly')}
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-[#F8FAFC]">
      <div className="border-b border-gray-200 bg-white px-4 py-5 shadow-sm md:px-8">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('navAdminDevices')}</div>
        <div className="mt-1 text-xl font-semibold text-gray-900">{t('adminDevicesTitle')}</div>
      </div>
      {err && (
        <div className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 md:mx-8">
          {err}
        </div>
      )}
      <div className="p-4 md:p-8">
        <div className="overflow-hidden rounded-[20px] border border-gray-100 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr className="border-b border-gray-100">
                <th className="py-3 pl-4">{t('serial')}</th>
                <th className="py-3">{t('name')}</th>
                <th className="py-3">{t('assignees')}</th>
                <th className="py-3">{t('statusLabel')}</th>
                <th className="py-3">{t('lastSeen')}</th>
                <th className="py-3 pr-4 text-right">{t('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {devices.map((d) => (
                <tr key={d.id} className="hover:bg-gray-50/80">
                  <td className="py-3 pl-4 font-mono text-xs text-gray-900">{d.serial_number}</td>
                  <td className="py-3 font-medium text-gray-900">{d.name}</td>
                  <td className="py-3 text-xs text-gray-600">
                    {(d.assignees || [])
                      .map((a) => a.email)
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </td>
                  <td className="py-3 text-xs text-gray-800">
                    {d.latest?.status === 'low'
                      ? t('lowBattery')
                      : d.latest?.status === 'active'
                        ? t('active')
                        : t('offline')}
                  </td>
                  <td className="py-3 text-xs text-gray-600">{d.lastSeen ? formatTime(d.lastSeen) : '—'}</td>
                  <td className="py-3 pr-4 text-right">
                    <button
                      type="button"
                      className="text-xs font-semibold text-red-600 hover:underline"
                      onClick={async () => {
                        if (!window.confirm(t('confirmAdminDelete'))) return;
                        await adminDeleteDevice(d.id);
                        load();
                      }}
                    >
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!devices.length && !err && (
          <div className="mt-8">
            <EmptyState title={t('emptyNoDevicesAdmin')} />
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsPage() {
  const auth = useAuth();
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await authChangePassword(oldPassword, newPassword);
      setMsg(t('passwordChanged'));
      setOldPassword('');
      setNewPassword('');
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full w-full bg-[#F8FAFC] p-6 md:p-10">
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('navSettings')}</div>
          <div className="mt-1 text-xl font-semibold text-gray-900">{t('settingsTitle')}</div>
        </div>

        <div className="rounded-[20px] border border-gray-100 bg-white p-6 shadow-card">
          <div className="text-sm font-semibold text-gray-900">{t('profileEmail')}</div>
          <div className="mt-2 text-sm text-gray-700">{auth.user?.email || '—'}</div>
        </div>

        <div className="space-y-4 rounded-[20px] border border-gray-100 bg-white p-6 shadow-card">
          <div className="text-sm font-semibold text-gray-900">{t('changePassword')}</div>
          {err && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{err}</div>
          )}
          {msg && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{msg}</div>
          )}
          <input
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            type="password"
            placeholder={t('oldPassword')}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
          />
          <input
            className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            type="password"
            placeholder={t('newPassword')}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <button
            className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-violet-600 disabled:opacity-60"
            onClick={save}
            disabled={busy || !oldPassword || newPassword.length < 8}
          >
            {busy ? t('loading') : t('savePassword')}
          </button>
        </div>

        <button
          type="button"
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          onClick={auth.logout}
        >
          {t('logout')}
        </button>
      </div>
    </div>
  );
}

function AdminUsersPage() {
  const me = useMe();
  const { t } = useTranslation();
  const [err, setErr] = useState(null);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    (async () => {
      setErr(null);
      try {
        const r = await adminListUsers();
        setUsers(r.users || []);
      } catch (e) {
        setErr(String(e.message || e));
      }
    })();
  }, []);

  if (me?.role !== 'admin') {
    return (
      <div className="bg-[#F8FAFC] p-8 text-sm text-gray-600">
        {t('adminOnly')}
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-[#F8FAFC]">
      <div className="border-b border-gray-200 bg-white px-4 py-5 shadow-sm md:px-8">
        <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{t('navAdminUsers')}</div>
        <div className="mt-1 text-xl font-semibold text-gray-900">{t('adminUsersTitle')}</div>
      </div>
      {err && (
        <div className="mx-4 mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 md:mx-8">
          {err}
        </div>
      )}
      <div className="p-4 md:p-8">
        <div className="overflow-hidden rounded-[20px] border border-gray-100 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr className="border-b border-gray-100">
                <th className="py-3 pl-4 text-left">{t('email')}</th>
                <th className="py-3 text-left">{t('role')}</th>
                <th className="py-3 text-left">{t('status')}</th>
                <th className="py-3 text-left">{t('createdAt')}</th>
                <th className="py-3 pr-4 text-right">{t('trackerCount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50/80">
                  <td className="py-3 pl-4 font-medium text-gray-900">{u.email}</td>
                  <td className="py-3 text-gray-800">{u.role}</td>
                  <td className="py-3 text-gray-800">{u.status}</td>
                  <td className="py-3 text-xs text-gray-600">{formatTime(u.createdAt)}</td>
                  <td className="py-3 pr-4 text-right text-gray-900">{u.trackerCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const auth = useAuth();
  if (!auth.token) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<LoginPage auth={auth} />} />
        </Routes>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter>
      <Shell auth={auth}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/trackers" element={<TrackersPage />} />
          <Route path="/trackers/:serialNumber/map" element={<TrackerMapPage />} />
          <Route path="/devices" element={<Navigate to="/trackers" replace />} />
          <Route path="/devices/:deviceId" element={<DeviceDetailsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/offline-investigation" element={<OfflineInvestigationPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/admin/devices" element={<AdminDevicesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}

export default function App() {
  return <AppInner />;
}
