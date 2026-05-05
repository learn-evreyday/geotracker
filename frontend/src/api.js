const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

function getAccessToken() {
  return localStorage.getItem('token');
}

function getRefreshToken() {
  return localStorage.getItem('refreshToken');
}

function authHeaders() {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonOrThrow(res) {
  if (res.ok) return res.json();
  const err = await res.json().catch(() => ({}));
  throw new Error(err.message || err.error || res.statusText);
}

let refreshPromise = null;

async function refreshAccessToken() {
  const rt = getRefreshToken();
  if (!rt) throw new Error('no_refresh');
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const res = await fetch(`${base}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'refresh_failed');
      const access = data.accessToken || data.token;
      if (access) localStorage.setItem('token', access);
      if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
      if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
      return access;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function apiFetch(url, options = {}) {
  const opts = {
    ...options,
    headers: { ...authHeaders(), ...options.headers },
  };
  let res = await fetch(url, opts);
  if (res.status === 401 && getRefreshToken()) {
    try {
      await refreshAccessToken();
      res = await fetch(url, {
        ...options,
        headers: { ...authHeaders(), ...options.headers },
      });
    } catch {
      /* ignore */
    }
  }
  return res;
}

export async function authRegister(email, password) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return jsonOrThrow(res);
}

export async function authLogin(email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return jsonOrThrow(res);
}

export async function listDevices() {
  const res = await apiFetch(`${base}/api/devices`);
  return jsonOrThrow(res);
}

export async function listOfflineDevices() {
  const res = await apiFetch(`${base}/api/devices/offline`);
  return jsonOrThrow(res);
}

export async function getDeviceById(id) {
  const res = await apiFetch(`${base}/api/devices/${encodeURIComponent(id)}`);
  return jsonOrThrow(res);
}

export async function getHistoryByDeviceId(deviceId, range) {
  const q = new URLSearchParams({ range });
  const res = await apiFetch(`${base}/api/devices/${encodeURIComponent(deviceId)}/history?${q}`);
  return jsonOrThrow(res);
}

export async function unassignDevice(deviceId) {
  const res = await apiFetch(`${base}/api/devices/${encodeURIComponent(deviceId)}/assignment`, {
    method: 'DELETE',
  });
  return jsonOrThrow(res);
}

export async function adminDeleteDevice(deviceId) {
  const res = await apiFetch(`${base}/api/admin/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  return jsonOrThrow(res);
}

export async function adminListAllDevices() {
  const res = await apiFetch(`${base}/api/admin/devices`);
  return jsonOrThrow(res);
}

export async function registerDeviceBySerial(serialNumber, name) {
  const res = await apiFetch(`${base}/api/devices/register-by-serial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial_number: serialNumber, name }),
  });
  return jsonOrThrow(res);
}

export async function getDeviceBySerial(serialNumber) {
  const res = await apiFetch(`${base}/api/devices/by-serial/${encodeURIComponent(serialNumber)}`);
  return jsonOrThrow(res);
}

export async function getHistoryBySerial(serialNumber, range) {
  const q = new URLSearchParams({ range });
  const res = await apiFetch(
    `${base}/api/devices/by-serial/${encodeURIComponent(serialNumber)}/history?${q}`
  );
  return jsonOrThrow(res);
}

export async function getLatestById(deviceId) {
  const res = await apiFetch(`${base}/api/devices/${encodeURIComponent(deviceId)}/latest`);
  return jsonOrThrow(res);
}

export async function adminListUsers() {
  const res = await apiFetch(`${base}/api/users`);
  return jsonOrThrow(res);
}

export async function fetchDeviceBySerialStatus(serialNumber) {
  const res = await apiFetch(`${base}/api/devices/by-serial/${encodeURIComponent(serialNumber)}`);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function authChangePassword(oldPassword, newPassword) {
  const res = await apiFetch(`${base}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });
  return jsonOrThrow(res);
}

export async function listCompanies() {
  const res = await apiFetch(`${base}/api/companies`);
  return jsonOrThrow(res);
}

export async function getCompanySummary(companyId) {
  const res = await apiFetch(`${base}/api/companies/${encodeURIComponent(companyId)}/summary`);
  return jsonOrThrow(res);
}

export async function listAlerts() {
  const res = await apiFetch(`${base}/api/alerts`);
  return jsonOrThrow(res);
}

export async function getUnreadAlertsCount() {
  const res = await apiFetch(`${base}/api/alerts/unread-count`);
  return jsonOrThrow(res);
}

export async function markAlertReadApi(alertId) {
  const res = await apiFetch(`${base}/api/alerts/${encodeURIComponent(alertId)}/read`, {
    method: 'POST',
  });
  return jsonOrThrow(res);
}

export async function markAllAlertsReadApi() {
  const res = await apiFetch(`${base}/api/alerts/read-all`, { method: 'POST' });
  return jsonOrThrow(res);
}
