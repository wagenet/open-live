/**
 * lib/ice-servers.ts — the ICE lookup shared by GET /api/v1/ice-servers and
 * the guest join: its cache, stale-on-error, and the deadline that keeps a
 * hung Strom or token exchange off the guest's join path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { iceServersMock, getStromTokenMock } = vi.hoisted(() => ({
  iceServersMock: vi.fn(),
  getStromTokenMock: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  return {
    ...actual,
    StromClient: class {
      system = { iceServers: iceServersMock };
    },
  };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: getStromTokenMock,
}));

import { getIceServers, resetIceServersCache, ICE_SERVERS_TIMEOUT_MS } from '../lib/ice-servers.js';
import { StromClientError } from '../lib/strom.js';

const LIST = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }];

beforeEach(() => {
  resetIceServersCache();
  iceServersMock.mockReset();
  getStromTokenMock.mockReset().mockResolvedValue('token');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getIceServers', () => {
  it("returns Strom's list, asking Strom to answer within the deadline", async () => {
    iceServersMock.mockResolvedValue({ ice_servers: LIST });
    await expect(getIceServers()).resolves.toEqual({ iceServers: LIST });
    const [timeoutMs] = iceServersMock.mock.calls[0];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(ICE_SERVERS_TIMEOUT_MS);
  });

  it('serves the cached list, with the error, when Strom fails', async () => {
    iceServersMock.mockResolvedValueOnce({ ice_servers: LIST });
    await getIceServers();
    iceServersMock.mockRejectedValueOnce(new StromClientError(0, 'Strom unreachable'));
    const result = await getIceServers();
    expect(result.iceServers).toEqual(LIST);
    expect(result.stale).toBeInstanceOf(StromClientError);
  });

  it('throws when Strom fails and nothing is cached', async () => {
    iceServersMock.mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    await expect(getIceServers()).rejects.toBeInstanceOf(StromClientError);
  });

  it('drops the cached list after 5 minutes, so expired TURN credentials are not served', async () => {
    vi.useFakeTimers();
    iceServersMock.mockResolvedValueOnce({ ice_servers: LIST });
    await getIceServers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    iceServersMock.mockRejectedValueOnce(new StromClientError(0, 'Strom unreachable'));
    await expect(getIceServers()).rejects.toBeInstanceOf(StromClientError);
  });

  it('stops waiting for a hung token exchange at the deadline', async () => {
    vi.useFakeTimers();
    getStromTokenMock.mockReturnValue(new Promise(() => {}));
    iceServersMock.mockResolvedValue({ ice_servers: LIST });
    const lookup = getIceServers();
    await vi.advanceTimersByTimeAsync(ICE_SERVERS_TIMEOUT_MS);
    // Strom is still asked, with whatever time is left.
    await expect(lookup).resolves.toEqual({ iceServers: LIST });
    expect(iceServersMock.mock.calls[0][0]).toBeGreaterThan(0);
  });
});
