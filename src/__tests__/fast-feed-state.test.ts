/**
 * Router writes for the fast return feeds against a Strom that answers late,
 * across a production stop and start, and the read of the mixer that the router
 * follows. Drives the real state service with a fake Strom client, a fake mixer
 * read and fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beginFastFeedWrite,
  setFastFeedMixerReader,
  confirmFastFeedState,
  clearFastFeedState,
  syncFastFeedRouter,
  fastFeedMatrix,
  type FastFeedChange,
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
  setFastFeedMixerReader(undefined);
  clearFastFeedState(PROD);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('router writes on a slow Strom', () => {
  it('writes once when Strom answers after the timeout and nothing has changed since', async () => {
    const { strom, writes } = slowStrom(6000);
    beginFastFeedWrite(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(writes).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('router writes across a stop and start', () => {
  it('sends the new run\'s first write without waiting behind the old run\'s hung write', async () => {
    const { strom, writes } = slowStrom(null);
    beginFastFeedWrite(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);

    clearFastFeedState(PROD);
    confirmFastFeedState(PROD);
    beginFastFeedWrite(PROD, [{ channel: 2, muted: true }]);
    void syncFastFeedRouter(PROD, NEW_ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.map((w) => w.flowId)).toEqual(['conv-1', 'conv-2']);
    expect(writes[1].matrix).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('drops the old run\'s unsent write', async () => {
    const { strom, writes } = slowStrom(null);
    beginFastFeedWrite(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);
    beginFastFeedWrite(PROD, [{ channel: 2, toMain: false }]);
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
    beginFastFeedWrite(PROD, [{ channel: 0, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom);
    await vi.advanceTimersByTimeAsync(10);
    beginFastFeedWrite(PROD, [{ channel: 2, toMain: false }]);
    void syncFastFeedRouter(PROD, ROUTER, strom); // goes out at the timeout, answered at once
    await vi.advanceTimersByTimeAsync(5100);
    expect(writes).toEqual(['conv-1', 'conv-1']);

    clearFastFeedState(PROD);
    confirmFastFeedState(PROD);
    await vi.advanceTimersByTimeAsync(5000); // the first write is answered now
    expect(writes).toEqual(['conv-1', 'conv-1']);
  });
});

type Strom = Parameters<typeof syncFastFeedRouter>[2];

/** Every channel of the three-channel mixer: on program, unmuted, at unity unless `closed` says off program. */
function mixerHolds(closed: number[] = []): FastFeedChange[] {
  return [0, 1, 2].flatMap((channel) => [
    { channel, toMain: !closed.includes(channel) }, { channel, muted: false }, { channel, gain: 1 },
  ]);
}

/** A mixer read that returns what `holds` says at the moment it is made, `readMs` later. */
function fakeMixer(strom: Strom, readMs = 0) {
  const mixer = { holds: mixerHolds() as FastFeedChange[] | null, reads: 0 };
  setFastFeedMixerReader(async () => {
    mixer.reads++;
    const changes = mixer.holds;
    if (readMs > 0) await new Promise((r) => setTimeout(r, readMs));
    return { changes, router: ROUTER, strom };
  });
  return mixer;
}

/** A crew change the mixer answers: applied, written to the router if accepted, then done. */
function crewChange(change: FastFeedChange, strom: Strom, accepted = true) {
  const write = beginFastFeedWrite(PROD, [change]);
  return () => {
    write.done();
    if (accepted) void syncFastFeedRouter(PROD, ROUTER, strom);
  };
}

describe('the router follows a read of the mixer', () => {
  it('writes nothing more when the router already holds what the mixer does', async () => {
    const { strom, writes } = slowStrom(0);
    const mixer = fakeMixer(strom);
    mixer.holds = mixerHolds([0]);
    crewChange({ channel: 0, toMain: false }, strom)();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mixer.reads).toBe(1);
    expect(writes.map((w) => w.matrix)).toEqual([fastRoutingMatrix(3, [1], new Set([0]))]);
  });

  it('takes a refused change back out of the router after another channel\'s write carried it', async () => {
    const { strom, writes } = slowStrom(0);
    const mixer = fakeMixer(strom);
    const refused = crewChange({ channel: 0, toMain: false }, strom, false);
    mixer.holds = mixerHolds([2]);
    crewChange({ channel: 2, toMain: false }, strom)();
    await vi.advanceTimersByTimeAsync(10);
    expect(writes.at(-1)?.matrix).toBe(fastRoutingMatrix(3, [1], new Set([0, 2])));
    refused();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.at(-1)?.matrix).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('reads only once every write is answered', async () => {
    const { strom } = slowStrom(0);
    const mixer = fakeMixer(strom);
    const first = crewChange({ channel: 0, toMain: false }, strom);
    const second = crewChange({ channel: 0, toMain: true }, strom);
    second();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mixer.reads).toBe(0);
    first();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mixer.reads).toBe(1);
  });

  it('stops waiting for a write that is never answered after ten seconds', async () => {
    const { strom } = slowStrom(0);
    const mixer = fakeMixer(strom);
    crewChange({ channel: 0, toMain: false }, strom);
    await vi.advanceTimersByTimeAsync(9000);
    expect(mixer.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mixer.reads).toBe(1);
  });

  it('sets aside a read that a crew write overlapped, and reads again after it', async () => {
    const { strom, writes } = slowStrom(0);
    const mixer = fakeMixer(strom, 500);
    crewChange({ channel: 0, toMain: false }, strom, false)();
    await vi.advanceTimersByTimeAsync(300); // the read is on its way, and sees ch0 open
    mixer.holds = mixerHolds([2]);
    crewChange({ channel: 2, toMain: false }, strom)();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mixer.reads).toBe(2);
    // The first read, from before ch2 went off, never reaches the router.
    expect(writes.map((w) => w.matrix)).not.toContain(fastRoutingMatrix(3, [1]));
    expect(writes.at(-1)?.matrix).toBe(fastRoutingMatrix(3, [1], new Set([2])));
  });

  it('waits for a ramp to finish before reading', async () => {
    const { strom } = slowStrom(0);
    const mixer = fakeMixer(strom);
    beginFastFeedWrite(PROD, [{ channel: 0, toMain: true }], { rampMs: 300 }).done();
    await vi.advanceTimersByTimeAsync(280);
    expect(mixer.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(mixer.reads).toBe(1);
  });

  it('reads once and logs nothing for a production with no fast feeds', async () => {
    const reader = vi.fn(async () => null);
    setFastFeedMixerReader(reader);
    beginFastFeedWrite(PROD, [{ channel: 0, toMain: false }]).done();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('retries a read that comes back incomplete five times, and again after the next crew change', async () => {
    const { strom } = slowStrom(0);
    const mixer = fakeMixer(strom);
    mixer.holds = null;
    crewChange({ channel: 0, toMain: false }, strom, false)();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mixer.reads).toBe(6);
    crewChange({ channel: 0, toMain: false }, strom, false)();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mixer.reads).toBe(12);
  });

  it('retries a failed router write through a read five times per crew change', async () => {
    const writes: string[] = [];
    const strom = {
      flows: {
        updateBlockProperties: vi.fn(async (_flowId: string, _blockId: string, body: { properties: { routing_matrix: string } }) => {
          writes.push(body.properties.routing_matrix);
          throw new Error('pipeline not running');
        }),
      },
    } as unknown as Strom;
    const mixer = fakeMixer(strom);
    mixer.holds = mixerHolds([0]);
    crewChange({ channel: 0, toMain: false }, strom)();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(writes).toHaveLength(6);
    expect(new Set(writes)).toEqual(new Set([fastRoutingMatrix(3, [1], new Set([0]))]));
  });

  it('writes a slow router once for one crew change', async () => {
    const { strom, writes } = slowStrom(6000);
    const mixer = fakeMixer(strom);
    mixer.holds = mixerHolds([0]);
    crewChange({ channel: 0, toMain: false }, strom)();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(writes).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('leaves the router alone for a read from before a stop and start', async () => {
    const { strom, writes } = slowStrom(0);
    const mixer = fakeMixer(strom, 500);
    mixer.holds = mixerHolds([0]);
    crewChange({ channel: 0, toMain: false }, strom, false)();
    await vi.advanceTimersByTimeAsync(300); // the read is on its way
    clearFastFeedState(PROD);
    confirmFastFeedState(PROD);
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toEqual([]);
    expect(fastFeedMatrix(PROD, ROUTER)).toBe(fastRoutingMatrix(3, [1]));
  });
});
