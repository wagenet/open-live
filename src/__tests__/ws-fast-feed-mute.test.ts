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

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (req.method === 'PATCH') patches.push({ path: req.url ?? '', body });
    if (routerFails && req.url === ROUTER_PATH) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'router gone' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
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
const ctx = { audioBlockId: MIXER_ID };
const send = (msg: Record<string, unknown>) => handleMessage(PROD, ws, JSON.stringify(msg), ctx);
const routerMatrices = () =>
  patches.filter((p) => p.path === ROUTER_PATH).map((p) => (p.body['properties'] as Record<string, unknown>)['routing_matrix']);

beforeEach(() => {
  patches.length = 0;
  routerFails = false;
  mockBroadcast.mockReset();
  clearAudioState(PROD);
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

  it('sends nothing to a conversation flow when the production has no fast feed', async () => {
    mockProductionGet.mockResolvedValue(makeProduction(false));
    await send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    expect(patches.map((p) => p.path)).toEqual([MIXER_PATH]);
  });
});
