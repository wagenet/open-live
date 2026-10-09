import { StromClient, type IceServer } from './strom.js';
import { getStromToken } from './strom-token.js';
import { config } from '../config.js';

/**
 * Strom's ICE server list (STROM_SERVER_ICE_SERVERS) in RTCIceServer shape,
 * shared by GET /api/v1/ice-servers (crew) and the guest join response (the
 * guest page), so every browser gets the same STUN/TURN servers.
 *
 * Stale-on-error: serves the last successful list when Strom is temporarily
 * unreachable (e.g. brief DNS failure after a network reconnect). ICE server
 * config changes rarely so a stale list is far better than none. The cache is
 * dropped after 5 minutes so expired TURN credentials are not served
 * indefinitely. Throws when Strom fails and nothing is cached.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedIceServers: IceServer[] | null = null;
let cacheTimestamp = 0;

/**
 * Clear the module-level stale-on-error cache.
 *
 * The cache is module-scoped so it survives across `buildServer()` instances —
 * that is correct in production (the last-good ICE config should outlive a
 * server rebuild) but leaks state between tests, where each test builds a fresh
 * server yet shares this module. Tests call this in `beforeEach` so a cached
 * success from an earlier test can't mask a later error expectation.
 */
export function resetIceServersCache(): void {
  cachedIceServers = null;
}

/** The list, and whether it is the cached one served because Strom failed. */
export async function getIceServers(): Promise<{ iceServers: IceServer[]; stale?: unknown }> {
  if (Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    cachedIceServers = null;
  }
  try {
    const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
    const { ice_servers } = await strom.system.iceServers();
    cachedIceServers = ice_servers;
    cacheTimestamp = Date.now();
    return { iceServers: ice_servers };
  } catch (err) {
    if (cachedIceServers) return { iceServers: cachedIceServers, stale: err };
    throw err;
  }
}
