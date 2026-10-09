/**
 * The guest page's return-feed playback, run in a VM with fake DOM, fetch and
 * RTCPeerConnection objects:
 *  - with only a picture feed, the guest hears the picture's audio;
 *  - with a fast feed, the picture plays muted on one PeerConnection and the
 *    fast feed's audio plays on a second, audio-only one;
 *  - if the fast feed fails, the picture's audio is unmuted;
 *  - on leave, both return sessions are deleted before the guest session.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import Fastify from 'fastify';
import guestPageRoutes from '../routes/guest-page.js';

async function pageScript(): Promise<string> {
  const app = Fastify();
  await app.register(guestPageRoutes);
  const res = await app.inject({ method: 'GET', url: '/guest/inv-1' });
  await app.close();
  const m = /<script>([\s\S]*)<\/script>/.exec(res.body);
  if (!m) throw new Error('no inline script');
  return m[1];
}

class FakeElement {
  textContent = '';
  className = '';
  innerHTML = '';
  value = '';
  disabled = false;
  muted = false;
  srcObject: unknown = null;
  private classes = new Set<string>();
  private listeners: Record<string, Array<() => void>> = {};
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  appendChild() {}
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    (this.listeners[type] ?? []).forEach((fn) => fn());
  }
}

interface FakePc {
  kinds: string[];
  closed: boolean;
  config: unknown;
  trackListener?: (e: { streams: unknown[] }) => void;
}

interface Request {
  method: string;
  url: string;
}

type Feed = { id: string; url: string; video: boolean };

interface PageOpts {
  failFast?: boolean;
  /** The join response's iceServers; absent when undefined. */
  iceServers?: unknown[];
  /** Each PeerConnection's iceGatheringState; 'complete' skips the gathering wait. */
  gathering?: string;
}

function runPage(script: string, feeds: Feed[], opts: PageOpts = {}) {
  const ids = [
    'banner', 'muted-indicator', 'onair-badge', 'preview', 'return', 'return-audio',
    'return-hint', 'cam', 'mic', 'pickers', 'golive', 'mute', 'leave',
  ];
  const els: Record<string, FakeElement> = {};
  for (const id of ids) els[id] = new FakeElement();
  els['return'].classList.add('hidden');

  const pcs: FakePc[] = [];
  const requests: Request[] = [];
  // The page's timer delays; long ones (the ICE gathering cap) fire at once.
  const delays: number[] = [];
  const pageSetTimeout = (fn: () => void, ms = 0) => {
    delays.push(ms);
    return setTimeout(fn, ms >= 1000 ? 0 : ms);
  };

  class RTCPeerConnection {
    state: FakePc = { kinds: [], closed: false, config: undefined };
    iceGatheringState = opts.gathering ?? 'complete';
    localDescription = { sdp: 'offer' };
    constructor(config: { iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }> }) {
      // As a browser must (WebRTC §4.4.1.1): an unknown scheme is a SyntaxError,
      // a TURN URL without a username and credential an InvalidAccessError.
      for (const server of config?.iceServers ?? []) {
        for (const url of ([] as string[]).concat(server.urls)) {
          if (!/^(stuns?|turns?):/.test(url)) throw Object.assign(new Error(`bad ICE url ${url}`), { name: 'SyntaxError' });
          if (/^turns?:/.test(url) && (server.username === undefined || server.credential === undefined)) {
            throw Object.assign(new Error(`no credentials for ${url}`), { name: 'InvalidAccessError' });
          }
        }
      }
      this.state.config = config;
      pcs.push(this.state);
    }
    addTrack() {}
    addTransceiver(kind: string) { this.state.kinds.push(kind); }
    addEventListener(type: string, fn: (e: { streams: unknown[] }) => void) {
      if (type === 'track') this.state.trackListener = fn;
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() {
      const stream = { id: `stream-${pcs.indexOf(this.state)}` };
      this.state.trackListener?.({ streams: [stream] });
      return Promise.resolve();
    }
    close() { this.state.closed = true; }
  }

  const fetch = (url: string, init: { method?: string } = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ method, url });
    const headers = (loc: string | null) => ({ get: (h: string) => (h === 'Location' ? loc : null) });
    if (url.endsWith('/join')) {
      return Promise.resolve({
        ok: true, status: 200, headers: headers(null),
        json: () => Promise.resolve({
          whipUrl: 'https://live.example.com/whip',
          feeds,
          ...(opts.iceServers ? { iceServers: opts.iceServers } : {}),
        }),
      });
    }
    if (method === 'POST' && url.endsWith('/fast/whep') && opts.failFast) {
      return Promise.resolve({ ok: false, status: 502, headers: headers(null), text: () => Promise.resolve('') });
    }
    if (method === 'POST' && url.endsWith('/whep')) {
      const feed = url.endsWith('/fast/whep') ? 'fast' : 'picture';
      return Promise.resolve({
        ok: true, status: 201, headers: headers(`/api/v1/productions/p1/returns/in1/${feed}/whep/s-${feed}`),
        text: () => Promise.resolve('answer'),
      });
    }
    return Promise.resolve({ ok: true, status: 201, headers: headers('/whip/s1'), text: () => Promise.resolve('answer') });
  };

  const track = { enabled: true, stop() {} };
  const context = {
    document: {
      getElementById: (id: string) => els[id],
      createElement: () => new FakeElement(),
    },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: 'https://live.example.com' },
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
        enumerateDevices: () => Promise.resolve([]),
      },
    },
    window: { RTCPeerConnection, addEventListener() {} },
    RTCPeerConnection,
    fetch,
    URL,
    Promise,
    setTimeout: pageSetTimeout,
  };
  vm.runInNewContext(script, context);
  return { els, pcs, requests, delays };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

const PICTURE: Feed = { id: 'picture', url: 'https://live.example.com/api/v1/productions/p1/returns/in1/picture/whep', video: true };
const FAST: Feed = { id: 'fast', url: 'https://live.example.com/api/v1/productions/p1/returns/in1/fast/whep', video: false };

describe('guest page return feeds', () => {
  it('plays the picture feed with its own audio when there is no fast feed', async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE]);
    await flush();
    els['golive'].fire('click');
    await flush();
    // pcs[0] is the WHIP publish.
    expect(pcs).toHaveLength(2);
    expect(pcs[1].kinds).toEqual(['video', 'audio']);
    expect(els['return'].muted).toBe(false);
    expect(els['return'].srcObject).toEqual({ id: 'stream-1' });
    expect(els['return-audio'].srcObject).toBeNull();
  });

  it('plays the fast feed on its own audio-only PeerConnection and mutes the picture', async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE, FAST]);
    await flush();
    els['golive'].fire('click');
    await flush();
    expect(pcs).toHaveLength(3);
    expect(pcs[1].kinds).toEqual(['video', 'audio']);
    expect(pcs[2].kinds).toEqual(['audio']);
    expect(els['return'].muted).toBe(true);
    expect(els['return'].srcObject).toEqual({ id: 'stream-1' });
    expect(els['return-audio'].srcObject).toEqual({ id: 'stream-2' });
  });

  it("unmutes the picture's audio when the fast feed fails", async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE, FAST], { failFast: true });
    await flush();
    els['golive'].fire('click');
    await flush();
    expect(els['return'].muted).toBe(false);
    expect(pcs[2].closed).toBe(true);
    expect(els['return-audio'].srcObject).toBeNull();
  });

  it('deletes both return sessions before the guest session on leave', async () => {
    const { els, pcs, requests } = runPage(await pageScript(), [PICTURE, FAST]);
    await flush();
    els['golive'].fire('click');
    await flush();
    els['leave'].fire('click');
    await flush();
    const deletes = requests.filter((r) => r.method === 'DELETE').map((r) => r.url);
    expect(deletes).toEqual([
      'https://live.example.com/api/v1/productions/p1/returns/in1/picture/whep/s-picture',
      'https://live.example.com/api/v1/productions/p1/returns/in1/fast/whep/s-fast',
      'https://live.example.com/api/v1/guests/inv-1/session',
    ]);
    expect(pcs[1].closed).toBe(true);
    expect(pcs[2].closed).toBe(true);
  });
});

describe('guest page ICE servers', () => {
  const STUN = { urls: 'stun:stun.l.google.com:19302' };
  // Strom's shape: `urls` is one string.
  const DEPLOYMENT = [
    { urls: 'stun:stun.example.com:3478' },
    { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
  ];
  // RTCIceServer also takes an array.
  const DEPLOYMENT_ARRAYS = [
    { urls: ['stun:stun.example.com:3478'] },
    { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
  ];

  async function goLive(opts: PageOpts) {
    const page = runPage(await pageScript(), [PICTURE], opts);
    await flush();
    page.els['golive'].fire('click');
    await flush();
    return page;
  }

  const published = (requests: Request[]) => requests.some((r) => r.url === 'https://live.example.com/whip');

  it("uses the join response's ICE servers for the publish and the returns", async () => {
    for (const iceServers of [DEPLOYMENT, DEPLOYMENT_ARRAYS]) {
      const { pcs } = await goLive({ iceServers });
      expect(pcs).toHaveLength(2);
      expect(pcs[0].config).toEqual({ iceServers });
      expect(pcs[1].config).toEqual({ iceServers });
    }
  });

  it('keeps its STUN server when the join response has none', async () => {
    const { pcs } = await goLive({});
    expect(pcs[0].config).toEqual({ iceServers: [STUN] });
  });

  it('drops a TURN entry without credentials, which the browser would reject, and goes live', async () => {
    const { pcs, requests, els } = await goLive({
      iceServers: [{ urls: 'stun:stun.example.com:3478' }, { urls: 'turn:turn.example.com:3478' }],
    });
    expect(pcs[0].config).toEqual({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] });
    expect(published(requests)).toBe(true);
    expect(els['banner'].className).toBe('live');
  });

  it('falls back to its STUN server when the browser rejects the list, and goes live', async () => {
    const { pcs, requests, els } = await goLive({ iceServers: [{ urls: 'bogus:turn.example.com' }] });
    expect(pcs[0].config).toEqual({ iceServers: [STUN] });
    expect(published(requests)).toBe(true);
    expect(els['banner'].className).toBe('live');
  });

  it('waits longer for ICE gathering when there is a TURN server', async () => {
    for (const iceServers of [DEPLOYMENT, DEPLOYMENT_ARRAYS]) {
      const withTurn = await goLive({ iceServers, gathering: 'gathering' });
      expect(published(withTurn.requests)).toBe(true);
      expect(withTurn.delays).toContain(6000);
    }

    const stunOnly = await goLive({ gathering: 'gathering' });
    expect(stunOnly.delays).toContain(2000);
    expect(stunOnly.delays).not.toContain(6000);
  });
});
