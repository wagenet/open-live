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
 *
 * A lookup gives up after ICE_SERVERS_TIMEOUT_MS, token exchange included: it
 * is on the guest join's path, and a hung Strom must not hold a guest on
 * "Connecting…" for the fetch's own ~5 minute default.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
export const ICE_SERVERS_TIMEOUT_MS = 3000;
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

/**
 * The token, or undefined once `ms` pass. The exchange itself is shared with
 * every other caller (getStromToken coalesces them), so it is not aborted;
 * this lookup only stops waiting for it.
 */
async function tokenWithin(ms: number): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([getStromToken(config.stromToken).catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The list, and the error when it is the cached one served because Strom failed. */
export async function getIceServers(): Promise<{ iceServers: IceServer[]; stale?: Error }> {
  if (Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    cachedIceServers = null;
  }
  const deadline = Date.now() + ICE_SERVERS_TIMEOUT_MS;
  try {
    const stromToken = await tokenWithin(ICE_SERVERS_TIMEOUT_MS);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
    const { ice_servers } = await strom.system.iceServers(Math.max(1, deadline - Date.now()));
    cachedIceServers = ice_servers;
    cacheTimestamp = Date.now();
    return { iceServers: ice_servers };
  } catch (err) {
    if (cachedIceServers) {
      return { iceServers: cachedIceServers, stale: err instanceof Error ? err : new Error(String(err)) };
    }
    throw err;
  }
}
