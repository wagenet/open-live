/**
 * Crew mutes and audio-follow-video reach the fast return feeds: every change to
 * a channel's `to_main` is mirrored into the fast feeds' router in the
 * conversation flow (`ProductionDoc.fastFeedRouter`), after the mixer update.
 *
 * Drives the real WS controller against a throwaway Strom that records PATCHes.
 * CouchDB is mocked via vi.mock('../db/index.js'), as elsewhere in this suite.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SOURCES: Record<string, Record<string, unknown>> = {
  'cam-a': { _id: 'cam-a', name: 'Camera A', streamType: 'srt', address: 'srt://10.0.0.1:9000?mode=caller' },
  'cam-b': { _id: 'cam-b', name: 'Camera B', streamType: 'srt', address: 'srt://10.0.0.2:9000?mode=caller' },
  'cam-c': { _id: 'cam-c', name: 'Camera C', streamType: 'srt', address: 'srt://10.0.0.3:9000?mode=caller' },
};

const mockProductionGet = vi.fn();

vi.mock('../db/index.js', () => {
  const sourcesGet = (id: string) =>
    SOURCES[id] ? Promise.resolve({ ...SOURCES[id] }) : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
  return {
    getDb: () => ({ get: mockProductionGet, insert: vi.fn().mockResolvedValue({ ok: true }) }),
    getSourcesDb: () => ({ get: sourcesGet }),
    getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  };
});

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const mockBroadcast = vi.fn();
vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: (...args: unknown[]) => mockBroadcast(...args) };
});

const FLOW_ID = 'flow-program';
const MIXER_ID = 'b-mixer';
const CONV_FLOW_ID = 'flow-conv';
const ROUTER_ID = 'b-fast-router';
const MIXER_PATH = `/api/flows/${FLOW_ID}/blocks/${MIXER_ID}/properties`;
const ROUTER_PATH = `/api/flows/${CONV_FLOW_ID}/blocks/${ROUTER_ID}/properties`;

const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
let routerFails = false;
let mixerFails = false;
/** Answer the next mixer write this late (ms); Strom applies it on arrival either way. */
let slowNextMixerReplyMs = 0;
/** Answer the mixer write whose properties match this late (ms); Strom applies it on arrival. */
let slowMixerWrite: { match: (props: Record<string, unknown>) => boolean; ms: number } | null = null;
/** Refuse the next mixer write, this late (ms). */
let failNextMixerAfterMs: number | null = null;
/** Refuse every mixer write whose properties match, this late (ms). */
let refuseMixerWrites: { match: (props: Record<string, unknown>) => boolean; ms: number } | null = null;
let slowNextRouterReplyMs = 0;
let routerInFlight = 0;
let maxRouterInFlight = 0;

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (req.method === 'PATCH') patches.push({ path: req.url ?? '', body });
    if ((routerFails && req.url === ROUTER_PATH) || (mixerFails && req.url === MIXER_PATH)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'block gone' }));
      return;
    }
    if (req.url === MIXER_PATH && failNextMixerAfterMs !== null) {
      const after = failNextMixerAfterMs;
      failNextMixerAfterMs = null;
      setTimeout(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'block gone' }));
      }, after);
      return;
    }
    if (req.url === MIXER_PATH && refuseMixerWrites?.match(body['properties'] as Record<string, unknown>)) {
      setTimeout(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'block gone' }));
      }, refuseMixerWrites.ms);
      return;
    }
    let delay = 0;
    if (req.url === MIXER_PATH) { delay = slowNextMixerReplyMs; slowNextMixerReplyMs = 0; }
    if (req.url === MIXER_PATH && slowMixerWrite?.match(body['properties'] as Record<string, unknown>)) {
      delay = slowMixerWrite.ms;
      slowMixerWrite = null;
    }
    if (req.url === ROUTER_PATH) {
      delay = slowNextRouterReplyMs;
      slowNextRouterReplyMs = 0;
      maxRouterInFlight = Math.max(maxRouterInFlight, ++routerInFlight);
    }
    setTimeout(() => {
      if (req.url === ROUTER_PATH) routerInFlight--;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    }, delay);
  });
});

await new Promise<void>((resolve) => {
  stromServer.listen(0, '127.0.0.1', () => resolve());
});
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => {
  stromServer.close();
});

// Imported after STROM_URL is set so config picks up the throwaway server.
const { handleMessage, clearAudioState } = await import('../ws/controller.js');
const { confirmFastFeedState, whenFastFeedRouterIdle } = await import('../services/fast-feed-state.js');
const { fastRoutingMatrix } = await import('../lib/fast-returns.js');
const { setTally } = await import('../services/tally.service.js');

const PROD = 'prod-fast-mute';

// Channels 0, 1, 2 in mixerInput order; the fast-feed guest is on channel 1.
function makeProduction(withRouter = true) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Fast feed mutes',
    status: 'active',
    stromFlowId: FLOW_ID,
    audioMixerBlockId: MIXER_ID,
    sources: [
      { sourceId: 'cam-a', mixerInput: 'video_in_1' },
      { sourceId: 'cam-b', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus', lowLatency: true } },
      { sourceId: 'cam-c', mixerInput: 'video_in_3' },
    ],
    ...(withRouter && { fastFeedRouter: { flowId: CONV_FLOW_ID, blockId: ROUTER_ID, numInputs: 3, ownChannels: [1] } }),
    graphicAssignments: [],
    values: {},
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;
// One controller connection per test: rate limiting is per connection.
let ctx: { audioBlockId: string } = { audioBlockId: MIXER_ID };
// Router writes go out in the background; `send` waits for them too.
const send = async (msg: Record<string, unknown>) => {
  await handleMessage(PROD, ws, JSON.stringify(msg), ctx);
  await whenFastFeedRouterIdle(PROD);
};
const routerMatrices = () =>
  patches.filter((p) => p.path === ROUTER_PATH).map((p) => (p.body['properties'] as Record<string, unknown>)['routing_matrix']);

beforeEach(() => {
  ctx = { audioBlockId: MIXER_ID };
  patches.length = 0;
  routerFails = false;
  mixerFails = false;
  slowNextMixerReplyMs = 0;
  slowMixerWrite = null;
  failNextMixerAfterMs = null;
  refuseMixerWrites = null;
  slowNextRouterReplyMs = 0;
  maxRouterInFlight = 0;
  mockBroadcast.mockReset();
  clearAudioState(PROD);
  // As after a controller's first connect: the router may follow the mixer.
  confirmFastFeedState(PROD);
  mockProductionGet.mockResolvedValue(makeProduction());
});

describe('crew mutes reach the fast return feeds', () => {
  it('a muted channel leaves the fast feeds after the mixer update, and returns on unmute', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(patches.map((p) => p.path)).toEqual([MIXER_PATH, ROUTER_PATH]);
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([0]))]);

    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    expect(routerMatrices()[1]).toBe(fastRoutingMatrix(3, [1]));
  });

  it('keeps earlier mutes when another channel changes', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices()[1]).toBe(fastRoutingMatrix(3, [1], new Set([0, 2])));
  });

  it('AFV_SET takes an off-program channel out of the fast feeds', async () => {
    setTally(PROD, { pgm: 'video_in_1', pvw: 'video_in_3' });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_3', enabled: true });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([2]))]);
  });

  it('a CUT with audio-follow-video updates the fast feeds', async () => {
    setTally(PROD, { pgm: 'video_in_1', pvw: 'video_in_3' });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_1', enabled: true });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_3', enabled: true });
    patches.length = 0;

    await send({ type: 'CUT', mixerInput: 'video_in_3' });
    // applyAudioFollow is fired without awaiting; let its requests land.
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(1));
    expect(routerMatrices()[0]).toBe(fastRoutingMatrix(3, [1], new Set([0])));
  });

  it('a failed fast-feed update keeps the mute on program', async () => {
    routerFails = true;
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(patches.find((p) => p.path === MIXER_PATH)!.body['properties']).toMatchObject({ ch1_to_main: false });
    expect(mockBroadcast).toHaveBeenCalledWith(PROD, { type: 'AUDIO_STATE', elementId: 'ch1', property: 'mute', value: true });
  });

  it('a cut and a quick cut back end the fast feeds where program ends, however Strom orders its replies', async () => {
    setTally(PROD, { pgm: 'video_in_1', pvw: 'video_in_3' });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_1', enabled: true });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_3', enabled: true });
    patches.length = 0;

    // The first cut's mixer write is answered after the second's.
    slowMixerWrite = { match: (props) => props['ch3_to_main'] === true, ms: 200 };
    await send({ type: 'CUT', mixerInput: 'video_in_3' });
    await send({ type: 'CUT', mixerInput: 'video_in_1' });
    // applyAudioFollow is fired without awaiting; let both cuts' requests land.
    // Each cut syncs the router once its mixer write is answered.
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(2), { timeout: 2000 });
    await whenFastFeedRouterIdle(PROD);
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('leaves the fast feeds alone on a cut with no channel following video', async () => {
    setTally(PROD, { pgm: 'video_in_1', pvw: 'video_in_3' });
    await send({ type: 'CUT', mixerInput: 'video_in_3' });
    await new Promise((r) => setTimeout(r, 50));
    await whenFastFeedRouterIdle(PROD);
    expect(patches).toEqual([]);
  });

  it('a cut the mixer refused leaves the fast feeds where program still is', async () => {
    setTally(PROD, { pgm: 'video_in_1', pvw: 'video_in_3' });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_1', enabled: true });
    await send({ type: 'AFV_SET', mixerInput: 'video_in_3', enabled: true });
    patches.length = 0;

    mixerFails = true;
    await send({ type: 'CUT', mixerInput: 'video_in_3' });
    await vi.waitFor(() => expect(patches.some((p) => p.path === MIXER_PATH)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(routerMatrices()).toEqual([]);

    // The next change carries program's state, not the refused cut.
    mixerFails = false;
    await send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'mute', value: false });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([2]))]);
  });

  it('an AFV_SET the mixer refused leaves the fast feeds alone', async () => {
    setTally(PROD, { pgm: 'video_in_1', pvw: 'video_in_3' });
    mixerFails = true;
    await send({ type: 'AFV_SET', mixerInput: 'video_in_3', enabled: true });
    expect(routerMatrices()).toEqual([]);
    mixerFails = false;
    await send({ type: 'AUDIO_SET', elementId: 'ch2', property: 'mute', value: false });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1])]);
  });

  it('a mute the mixer refused leaves the fast feeds alone', async () => {
    mixerFails = true;
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(routerMatrices()).toEqual([]);
    mixerFails = false;
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([2]))]);
  });

  it('undoing a refused mute leaves a newer change to that channel in place', async () => {
    failNextMixerAfterMs = 150;
    const refused = send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await refused;
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0, 2])));
  });

  it('a mute and a quick unmute of one channel, both refused, leave it where program is', async () => {
    refuseMixerWrites = { match: (props) => props['ch1_to_main'] !== undefined, ms: 150 };
    await Promise.all([
      send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true }),
      send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false }),
    ]);
    refuseMixerWrites = null;
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('takes a refused mute back out of the router when another channel\'s write carried it', async () => {
    refuseMixerWrites = { match: (props) => props['ch1_to_main'] !== undefined, ms: 300 };
    const refused = send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0, 2])));
    await refused;
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('sends router writes one at a time, the last one carrying every change', async () => {
    slowNextRouterReplyMs = 150;
    await Promise.all([
      send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true }),
      send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true }),
    ]);
    expect(maxRouterInFlight).toBe(1);
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0, 2])));
  });

  it('tells the crew about a mute without waiting for a slow router write', async () => {
    slowNextRouterReplyMs = 1000;
    const started = Date.now();
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true }), ctx);
    expect(mockBroadcast).toHaveBeenCalledWith(PROD, { type: 'AUDIO_STATE', elementId: 'ch1', property: 'mute', value: true });
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true }), ctx);
    expect(mockBroadcast).toHaveBeenCalledWith(PROD, { type: 'AUDIO_STATE', elementId: 'ch3', property: 'mute', value: true });
    expect(Date.now() - started).toBeLessThan(500);
    await whenFastFeedRouterIdle(PROD);
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0, 2])));
  });

  it('sends one router write for changes made while another is on its way', async () => {
    slowNextRouterReplyMs = 150;
    for (const elementId of ['ch1', 'ch3', 'ch2']) {
      await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_SET', elementId, property: 'mute', value: true }), ctx);
    }
    await whenFastFeedRouterIdle(PROD);
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([0])), fastRoutingMatrix(3, [1], new Set([0, 1, 2]))]);
  });

  it('sends the next router write after a slow one times out, and writes again once the slow one lands', async () => {
    slowNextRouterReplyMs = 5500;
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true }), ctx);
    await handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true }), ctx);
    const both = fastRoutingMatrix(3, [1], new Set([0, 2]));
    // The second write goes out at the 5 s timeout, while the first is still unanswered.
    await vi.waitFor(() => expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([0])), both]), { timeout: 5400, interval: 50 });
    // Strom may apply the slow one last, so its reply is followed by the current state again.
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(3), { timeout: 2000, interval: 50 });
    expect(routerMatrices()[2]).toBe(both);
  }, 10_000);

  it('sends nothing to the router until the state is known to match the mixer', async () => {
    clearAudioState(PROD); // a restart, before any controller has connected
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(patches.map((p) => p.path)).toEqual([MIXER_PATH]);
  });

  it('keeps a mute made before the production had a router', async () => {
    mockProductionGet.mockResolvedValue(makeProduction(false));
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    mockProductionGet.mockResolvedValue(makeProduction());
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([0, 2]))]);
  });

  it('sends nothing to a conversation flow when the production has no fast feed', async () => {
    mockProductionGet.mockResolvedValue(makeProduction(false));
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(patches.map((p) => p.path)).toEqual([MIXER_PATH]);
  });
});

describe('crew faders reach the fast return feeds', () => {
  it('a fader level becomes the channel\'s level in the fast feeds, and zero takes it out', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'volume', value: 0.5 });
    // The fader is debounced; let its requests land.
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(1));
    expect(patches.map((p) => p.path)).toEqual([MIXER_PATH, ROUTER_PATH]);
    expect(routerMatrices()[0]).toBe(fastRoutingMatrix(3, [1], new Set(), new Map([[2, 0.5]])));
    expect(JSON.parse(routerMatrices()[0] as string)).toEqual({ i0c0: ['o0c0'], i0c1: ['o0c1'], i2c0: { o0c0: 0.5 }, i2c1: { o0c1: 0.5 } });

    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'volume', value: 0 });
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(2));
    expect(routerMatrices()[1]).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('plays a fader above unity at unity, the most a router crosspoint takes', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'volume', value: 1.6 });
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(1));
    expect(routerMatrices()[0]).toBe(fastRoutingMatrix(3, [1]));
  });

  it('leaves the fast feeds alone when the main fader moves', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'main', property: 'volume', value: 0.3 });
    await vi.waitFor(() => expect(patches).toHaveLength(1));
    expect(patches.map((p) => p.path)).toEqual([MIXER_PATH]);
  });
});
