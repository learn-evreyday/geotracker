/** GeoTrackr demo fleet: shared serials for seed + simulator exclusion. */
export const GEOTRACKR_ONLINE_COUNT = 6;
export const GEOTRACKR_FLEET_SIZE = 10;
export const GEOTRACKR_COMPANY_NAME = 'GeoTrackr';
export const GEOTRACKR_COMPANY_SLUG = 'geotrackr';

export const GEOTRACKR_OFFLINE_SIM_SERIALS = Array.from({ length: GEOTRACKR_FLEET_SIZE - GEOTRACKR_ONLINE_COUNT }, (_, k) => {
  const n = GEOTRACKR_ONLINE_COUNT + 1 + k;
  return `GT-TRACK-${String(n).padStart(3, '0')}`;
});
