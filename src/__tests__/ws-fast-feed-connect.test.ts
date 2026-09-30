/**
 * The fast return feeds' router after the server loses its in-memory audio state
 * (a restart) and the first controller connects, and after a change made through
 * the REST audio route.
 *
 * Drives the real controller plugin over a live socket (the connect-time reset
 * lives there) and the real REST route via inject, against a throwaway Strom that
 * records writes. CouchDB is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const SOURCES: Record<string, Record<string, unknown>> = {
  'cam-a': { _id: 'cam-a', name: 'Camera A', streamType: 'srt', address: 'srt://10.0.0.1:9000?mode=caller' },
  'cam-b': { _id: 'cam-b', name: 'Camera B', streamType: 'srt', address: 'srt://10.0.0.2:9000?mode=caller' },
  'cam-c': { _id: 'cam-c', name: 'Camera C', streamType: 'srt', address: 'srt://10.0.0.3:9000?mode=caller' },
};
const productionDocs = new Map<string, Record<string, unknown>>();

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = productionDocs.get(id);
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return structuredClone(doc);
    }),
    insert: vi.fn().mockResolvedValue({ ok: true }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getSourcesDb: () => ({
    get: vi.fn(async (id: string) => {
      if (!SOURCES[id]) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return { ...SOURCES[id] };
    }),
    insert: vi.fn(),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));
vi.mock('../lib/flow-generator.js', () => ({ activateStromFlow: vi.fn(), deactivateStromFlow: vi.fn() }));
vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue(undefined) }));

const FLOW_ID = 'flow-program';
const MIXER_ID = 'b-mixer';
const CONV_FLOW_ID = 'flow-conv';
const ROUTER_ID = 'b-fast-router';
const ROUTER_PATH = `/api/flows/${CONV_FLOW_ID}/blocks/${ROUTER_ID}/properties`;
const MIXER_PATH = `/api/flows/${FLOW_ID}/blocks/${MIXER_ID}/properties`;

const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
let mixerFails = false;
/** Refuse writes through the REST audio route (element properties). */
let elementFails = false;
/** Answer the next reset write (the first connect's) this late (ms); Strom applies it on arrival. */
let slowNextResetReplyMs = 0;
/** Answer the next REST audio write this late (ms); Strom applies it on arrival. */
let slowNextElementReplyMs = 0;
/** What a read of the mixer's properties returns. */
let mixerReadProps: Record<string, unknown> = {};
/** Refuse only the first connect's reset. */
let refuseReset = false;
/** Answer the next mixer read this late (ms), with the values it had on arrival. */
let slowNextReadMs = 0;
/** Answer REST audio writes as a gateway that lost Strom's reply, without Strom applying them. */
let elementGateway = false;
/** Refuse the next router write. */
let failNextRouterWrite = false;
const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (req.method === 'PATCH' || (req.method === 'POST' && req.url?.includes('/elements/'))) {
      patches.push({ path: req.url ?? '', body });
    }
    const isElementWrite = req.method === 'PATCH' && (req.url ?? '').includes('/elements/');
    const isReset = req.method === 'PATCH' && req.url === MIXER_PATH && (body['properties'] as Record<string, unknown>)?.['main_fader'] !== undefined;
    if (refuseReset && isReset) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'refused' }));
      return;
    }
    if (elementGateway && isElementWrite) {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
      return;
    }
    if (failNextRouterWrite && req.url === ROUTER_PATH) {
      failNextRouterWrite = false;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'pipeline not running' }));
      return;
    }
    if ((mixerFails && req.method === 'PATCH' && req.url === MIXER_PATH) || (elementFails && isElementWrite)) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'block gone' }));
      return;
    }
    let delay = 0;
    const props = body['properties'] as Record<string, unknown> | undefined;
    if (req.url === MIXER_PATH && props?.['main_fader'] !== undefined) { delay = slowNextResetReplyMs; slowNextResetReplyMs = 0; }
    if (isElementWrite) { delay = slowNextElementReplyMs; slowNextElementReplyMs = 0; }
    if (delay > 0) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }, delay);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url === `/api/flows/${FLOW_ID}`) {
      res.end(JSON.stringify({ flow: { id: FLOW_ID, name: 'p', elements: [], links: [], blocks: [
        { id: MIXER_ID, block_definition_id: 'builtin.mixer', name: 'Mixer', properties: { num_channels: 3 }, position: { x: 0, y: 0 } },
      ] } }));
      return;
    }
    if (req.method === 'GET' && req.url === MIXER_PATH) {
      const read = JSON.stringify({ properties: mixerReadProps });
      const ms = slowNextReadMs;
      slowNextReadMs = 0;
      setTimeout(() => res.end(read), ms);
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});
await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { buildServer } = await import('../server.js');
const { handleMessage, clearAudioState } = await import('../ws/controller.js');
const { confirmFastFeedState, whenFastFeedRouterIdle } = await import('../services/fast-feed-state.js');
const { fastRoutingMatrix } = await import('../lib/fast-returns.js');

const PROD = 'prod-fast-connect';
function makeProduction() {
  return {
    _id: PROD, _rev: '1-abc', type: 'production', name: 'Fast connect', status: 'active',
    stromFlowId: FLOW_ID, audioMixerBlockId: MIXER_ID,
    sources: [
      { sourceId: 'cam-a', mixerInput: 'video_in_1' },
      { sourceId: 'cam-b', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus', lowLatency: true } },
      { sourceId: 'cam-c', mixerInput: 'video_in_3' },
    ],
    returnBuses: [{ mixerInput: 'video_in_2', auxBus: 1, ownChannel: 1, mode: 'program-minus' }],
    fastFeedRouter: { flowId: CONV_FLOW_ID, blockId: ROUTER_ID, numInputs: 3, ownChannels: [1] },
    graphicAssignments: [], values: {}, pipeline: { stromConfig: null, status: 'running' },
    graphics: [], macros: [], tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let app: FastifyInstance;
const fakeWs = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;
// Router writes go out in the background; each helper waits for them.
const send = async (msg: Record<string, unknown>) => {
  await handleMessage(PROD, fakeWs, JSON.stringify(msg), { audioBlockId: MIXER_ID });
  await whenFastFeedRouterIdle(PROD);
};
const routerMatrices = () =>
  patches.filter((p) => p.path === ROUTER_PATH).map((p) => (p.body['properties'] as Record<string, unknown>)['routing_matrix']);

async function connectOnce(): Promise<void> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${PROD}/controller`);
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (d) => {
      try { if ((JSON.parse(d.toString()) as { type?: string }).type === 'SNAPSHOT_END') resolve(); } catch { /* ignore */ }
    });
    ws.on('open', () => setTimeout(resolve, 800));
  });
  ws.close();
  await whenFastFeedRouterIdle(PROD);
}

async function patchAudio(elementId: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PATCH', url: `/api/v1/productions/${PROD}/audio/${elementId}`, payload });
  await whenFastFeedRouterIdle(PROD);
  return res;
}

/** A full read of the three-channel mixer: every channel on program, unmuted, at unity unless overridden. */
function mixerProps(overrides: Record<number, { toMain?: boolean; muted?: boolean; fader?: number }>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (let ch = 1; ch <= 3; ch++) {
    const o = overrides[ch] ?? {};
    props[`ch${ch}_to_main`] = o.toMain ?? true;
    props[`ch${ch}_mute`] = o.muted ?? false;
    props[`ch${ch}_fader`] = o.fader ?? 1;
  }
  return props;
}

beforeEach(async () => {
  patches.length = 0;
  mixerFails = false;
  elementFails = false;
  slowNextResetReplyMs = 0;
  slowNextElementReplyMs = 0;
  mixerReadProps = {};
  refuseReset = false;
  slowNextReadMs = 0;
  elementGateway = false;
  failNextRouterWrite = false;
  productionDocs.clear();
  productionDocs.set(PROD, makeProduction());
  clearAudioState(PROD);
  // As after a controller's first connect: the router may follow the mixer.
  confirmFastFeedState(PROD);
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(async () => { await app.close(); });

describe('fast feeds after a server restart', () => {
  it('reopens a channel muted before the restart once the first connect puts it back on program', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0])));

    // A restart loses every in-memory registry; the router keeps its matrix.
    clearAudioState(PROD);
    patches.length = 0;

    await connectOnce();
    const init = patches.find((p) => p.path === MIXER_PATH && (p.body['properties'] as Record<string, unknown>)['ch1_to_main'] !== undefined);
    expect((init!.body['properties'] as Record<string, unknown>)['ch1_to_main']).toBe(true);
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1])]);
  });

  it('reopens a channel muted through the REST route before anyone connected', async () => {
    await patchAudio('ch1', { property: 'mute', value: true });
    patches.length = 0;
    // The first connect sets every ch<N>_mute back to false on the mixer.
    await connectOnce();
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1])]);
  });

  it('holds a REST change made after a restart until the first connect resets the mixer', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    clearAudioState(PROD);
    patches.length = 0;

    // The mixer still has ch3 off; a router write from empty state would reopen it.
    await patchAudio('ch1', { property: 'volume', value: 0.5 });
    expect(routerMatrices()).toEqual([]);

    await connectOnce();
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1])]);
  });

  it('leaves the router alone when the first connect could not reset the mixer', async () => {
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    clearAudioState(PROD);
    patches.length = 0;
    mixerFails = true;
    await connectOnce();
    expect(patches.some((p) => p.path === MIXER_PATH)).toBe(true);
    expect(routerMatrices()).toEqual([]);
  });

  it('takes the fast feeds from the mixer when the first connect\'s reset is refused, and follows the crew from there', async () => {
    clearAudioState(PROD);
    patches.length = 0;
    // The mixer still has ch3 off program and ch1 at half level from before the restart.
    mixerReadProps = mixerProps({ 1: { fader: 0.5 }, 3: { toMain: false } });
    mixerFails = true;
    await connectOnce();
    mixerFails = false;
    const gains = new Map([[0, 0.5], [1, 1], [2, 1]]);
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([2]), gains)]);

    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0, 2]), gains));
  });

  it('takes the fast feeds from the mixer on a later connect when the refused reset\'s connect could not read it', async () => {
    clearAudioState(PROD);
    patches.length = 0;
    mixerFails = true;
    await connectOnce(); // the pipeline reads as empty
    mixerFails = false;
    expect(routerMatrices()).toEqual([]);

    mixerReadProps = mixerProps({ 2: { muted: true } });
    await connectOnce();
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([1]), new Map([[0, 1], [1, 1], [2, 1]]))]);
  });

  it('keeps a mute on its way to the mixer when a later connect reads the mixer from before it', async () => {
    clearAudioState(PROD);
    mixerFails = true;
    await connectOnce(); // the pipeline reads as empty
    mixerFails = false;
    patches.length = 0;

    // The read reaches Strom before the mute does, so ch1 reads as open.
    mixerReadProps = mixerProps({});
    slowNextElementReplyMs = 1500;
    const muting = patchAudio('ch1', { property: 'mute', value: true });
    await vi.waitFor(() => expect(patches.some((p) => p.path.includes('/elements/'))).toBe(true), { timeout: 3000 });
    await connectOnce();
    expect((await muting).statusCode).toBe(200);
    await whenFastFeedRouterIdle(PROD);
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0]), new Map([[0, 1], [1, 1], [2, 1]])));
  }, 15_000);

  it('keeps a mute the mixer accepted while a connect\'s read of the mixer was on its way', async () => {
    clearAudioState(PROD);
    patches.length = 0;
    refuseReset = true;
    // The read reaches the mixer before the mute does, and is answered after it.
    mixerReadProps = mixerProps({});
    slowNextReadMs = 400;
    const connecting = connectOnce();
    await vi.waitFor(() => expect(patches.some((p) => p.path === MIXER_PATH)).toBe(true), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 100));
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    mixerReadProps = mixerProps({ 1: { toMain: false } });
    await connecting;
    await whenFastFeedRouterIdle(PROD);
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0]), new Map([[0, 1], [1, 1], [2, 1]])));
  }, 15_000);

  it('keeps a crew change made while the first connect\'s reset is on its way', async () => {
    clearAudioState(PROD);
    patches.length = 0;
    slowNextResetReplyMs = 300;
    const connecting = connectOnce();
    await vi.waitFor(() => expect(patches.some((p) => p.path === MIXER_PATH)).toBe(true), { timeout: 3000 });
    // Another operator mutes ch1 after the reset reached the mixer, before its reply.
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await connecting;
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0])));
  });

  it('keeps the fast feeds following the crew when the first connect\'s reset is refused', async () => {
    mixerFails = true;
    await connectOnce();
    mixerFails = false;
    patches.length = 0;
    await send({ type: 'AUDIO_SET', elementId: 'ch3', property: 'mute', value: true });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([2]))]);
  });

  it('leaves the router alone on a later connect', async () => {
    await connectOnce();
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    patches.length = 0;
    await connectOnce();
    expect(routerMatrices()).toEqual([]);
  });
});

describe('fast feeds and the REST audio route', () => {
  it('a mute takes the channel out of the fast feeds, and unmuting brings it back', async () => {
    expect((await patchAudio('ch1', { property: 'mute', value: true })).statusCode).toBe(200);
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([0]))]);
    expect((await patchAudio('ch1', { property: 'mute', value: false })).statusCode).toBe(200);
    expect(routerMatrices()[1]).toBe(fastRoutingMatrix(3, [1]));
  });

  it('a mute Strom refused leaves the fast feeds alone', async () => {
    elementFails = true;
    expect((await patchAudio('ch1', { property: 'mute', value: true })).statusCode).toBe(500);
    elementFails = false;
    await patchAudio('ch3', { property: 'mute', value: true });
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set([2]))]);
  });

  it('a mute whose write timed out stays in the fast feeds, since Strom may have applied it', async () => {
    slowNextElementReplyMs = 5500;
    expect((await patchAudio('ch1', { property: 'mute', value: true })).statusCode).toBe(500);
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0])));
  }, 10_000);

  it('a volume becomes the channel\'s level in the fast feeds', async () => {
    expect((await patchAudio('ch3', { property: 'volume', value: 0.25 })).statusCode).toBe(200);
    expect(routerMatrices()).toEqual([fastRoutingMatrix(3, [1], new Set(), new Map([[2, 0.25]]))]);
  });

  it('a REST mute and a crew mute of the same channel both have to lift before it returns', async () => {
    await patchAudio('ch1', { property: 'mute', value: true });
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0])));
  });
});

describe('checks that put the fast feeds right from the mixer', () => {
  it('opens a channel again when a mute whose reply was lost never reached the mixer', async () => {
    elementGateway = true;
    expect((await patchAudio('ch1', { property: 'mute', value: true })).statusCode).toBe(500);
    // Strom may have applied it, so the fast feeds keep the mute for now.
    expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set([0])));
    mixerReadProps = mixerProps({});
    await vi.waitFor(() => expect(routerMatrices().at(-1)).toBe(fastRoutingMatrix(3, [1], new Set(), new Map([[0, 1], [1, 1], [2, 1]]))), { timeout: 5000 });
  }, 10_000);

  it('writes the router again after a router write failed', async () => {
    failNextRouterWrite = true;
    mixerReadProps = mixerProps({ 1: { toMain: false } });
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(routerMatrices()).toHaveLength(1);
    await vi.waitFor(() => expect(routerMatrices()).toHaveLength(2), { timeout: 5000 });
    expect(routerMatrices()[1]).toBe(fastRoutingMatrix(3, [1], new Set([0]), new Map([[0, 1], [1, 1], [2, 1]])));
  }, 10_000);
});
