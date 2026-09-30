/**
 * Router writes for the fast return feeds against a Strom that answers late, and
 * across a production stop and start. Drives the real state service with a fake
 * Strom client and fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordFastFeedChanges,
  confirmFastFeedState,
  clearFastFeedState,
  syncFastFeedRouter,
} from '../services/fast-feed-state.js';
import { fastRoutingMatrix } from '../lib/fast-returns.js';

const ROUTER = { flowId: 'conv-1', blockId: 'router', numInputs: 3, ownChannels: [1] };
const NEW_ROUTER = { ...ROUTER, flowId: 'conv-2' };

/** A Strom that answers every router write after `replyMs`, or never when null. */
function slowStrom(replyMs: number | null) {
  const writes: Array<{ at: number; flowId: string; matrix: string }> = [];
  const strom = {
    flows: {
      updateBlockProperties: vi.fn((flowId: string, _blockId: string, body: { properties: { routing_matrix: string } }) => {
        writes.push({ at: Date.now(), flowId, matrix: body.properties.routing_matrix });
        return replyMs === null ? new Promise(() => undefined) : new Promise((resolve) => setTimeout(resolve, replyMs));
      }),
    },
  };
  return { strom: strom as unknown as Parameters<typeof syncFastFeedRouter>[2], writes };
}

let n = 0;
let PROD = '';
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  PROD = `prod-fast-feed-state-${++n}`;
  confirmFastFeedState(PROD);
});
afterEach(() => {
  clearFastFeedState(PROD);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('router writes on a slow Strom', () => {
  it('writes once when Strom answers after the timeout and nothing has changed since', async () => {
    const { strom, writes } = slowStrom(6000);
    recordFastFeedChanges(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(writes).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('router writes across a stop and start', () => {
  it('sends the new run\'s first write without waiting behind the old run\'s hung write', async () => {
    const { strom, writes } = slowStrom(null);
    recordFastFeedChanges(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);

    clearFastFeedState(PROD);
    confirmFastFeedState(PROD);
    recordFastFeedChanges(PROD, [{ channel: 2, muted: true }]);
    void syncFastFeedRouter(PROD, NEW_ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.map((w) => w.flowId)).toEqual(['conv-1', 'conv-2']);
    expect(writes[1].matrix).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('drops the old run\'s unsent write', async () => {
    const { strom, writes } = slowStrom(null);
    recordFastFeedChanges(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);
    recordFastFeedChanges(PROD, [{ channel: 2, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom); // waits behind the hung one

    clearFastFeedState(PROD);
    confirmFastFeedState(PROD);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes.map((w) => w.flowId)).toEqual(['conv-1']);
  });

  it('does not write to the old router when an old write that timed out is answered after a later one', async () => {
    let reply = 8000;
    const writes: string[] = [];
    const strom = {
      flows: {
        updateBlockProperties: vi.fn((flowId: string) => {
          writes.push(flowId);
          const ms = reply;
          reply = 0;
          return new Promise((resolve) => setTimeout(resolve, ms));
        }),
      },
    } as unknown as Parameters<typeof syncFastFeedRouter>[2];
    recordFastFeedChanges(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);
    recordFastFeedChanges(PROD, [{ channel: 2, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom); // goes out at the timeout, answered at once
    await vi.advanceTimersByTimeAsync(5100);
    expect(writes).toEqual(['conv-1', 'conv-1']);

    clearFastFeedState(PROD);
    confirmFastFeedState(PROD);
    await vi.advanceTimersByTimeAsync(5000); // the first write is answered now
    expect(writes).toEqual(['conv-1', 'conv-1']);
  });
});
