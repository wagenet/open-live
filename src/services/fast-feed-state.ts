/**
 * What the crew has done to each audio channel, as the fast return feeds need it,
 * and the write that puts it into the fast feeds' router (`ProductionDoc.fastFeedRouter`).
 *
 * The fast feed taps each channel's source before the mixer, so the router has to
 * copy the crew's routing (mute / audio-follow-video via `to_main`), the channel
 * mute set through the REST audio route, and the fader level.
 *
 * The mixer is the truth. A crew change goes into the router as soon as the mixer
 * accepts it. Once no mixer write from open-live is on its way and any ramp has
 * finished, the mixer is read and the router gets what it holds. That read puts
 * right whatever the quick path got wrong: a refused or lost write, answers out of
 * order, a failed router write.
 *
 * State is only written to a router once it is known to match the mixer: after a
 * read of the mixer, after the first controller connect's reset, or after
 * activation (a new router and a new mixer both start with every channel open).
 */

import { fastRoutingMatrix, type FastFeedRouter } from '../lib/fast-returns.js';
import type { StromClient } from '../lib/strom.js';

/** One change to a 0-based channel. */
export type FastFeedChange =
  | { channel: number; toMain: boolean }
  | { channel: number; muted: boolean }
  | { channel: number; gain: number };

interface ChannelState {
  offProgram: Set<number>;
  muted: Set<number>;
  gains: Map<number, number>;
}

/** A mixer write in progress. */
export interface FastFeedWrite {
  /** Call once the mixer has answered, either way. */
  done(): void;
}

/** What a read of the mixer finds: each channel's state, or null when the read is incomplete, and where to write it. */
export interface FastFeedMixerRead {
  changes: FastFeedChange[] | null;
  router: FastFeedRouter | undefined;
  strom: Pick<StromClient, 'flows'>;
}

/** Reads a production's mixer; null when the production has no fast feeds. */
type MixerReader = (productionId: string) => Promise<FastFeedMixerRead | null>;

/** The production's mixer writes from open-live, and the read that follows them. */
interface Activity {
  inFlight: number;
  /** Writes started so far, so a read that overlapped one is set aside. */
  begun: number;
  /** Until when a ramp may still be moving a channel. */
  rampUntil: number;
  /** Reads left to retry an incomplete read or a failed router write, renewed by each crew change. */
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
}

const stateByProduction = new Map<string, ChannelState>();
const confirmedProductions = new Set<string>();
const activity = new Map<string, Activity>();
const pendingWrite = new Map<string, Promise<void>>();
/** A write queued behind another and not yet sent, with the router it is for. */
const waitingWrite = new Map<string, { flowId: string; blockId: string; write: Promise<void> }>();
/**
 * The production's router writes since its state was last cleared: how many were
 * sent, and the newest one Strom has answered. A write from before a clear sees a
 * different object and neither writes nor resyncs.
 */
interface WriteRun { sent: number; landed: number }
const writeRuns = new Map<string, WriteRun>();
/** Per production: the router and matrix of the last write sent, while it is not known to have failed. */
const lastSent = new Map<string, { router: FastFeedRouter; matrix: string }>();
let mixerReader: MixerReader | undefined;

/** How long after the last mixer answer the mixer is read, and how long before a retry. */
const QUIET_MS = 250;
const RETRY_MS = 2000;
const RETRIES = 5;
/** A mixer write unanswered for this long no longer holds the read back. */
const WRITE_CAP_MS = 10_000;
/** How long a router write may take before the next one goes out. */
const ROUTER_WRITE_TIMEOUT_MS = 5000;

function stateFor(productionId: string): ChannelState {
  let s = stateByProduction.get(productionId);
  if (!s) {
    s = { offProgram: new Set(), muted: new Set(), gains: new Map() };
    stateByProduction.set(productionId, s);
  }
  return s;
}

function activityFor(productionId: string): Activity {
  let a = activity.get(productionId);
  if (!a) {
    a = { inFlight: 0, begun: 0, rampUntil: 0, retries: RETRIES };
    activity.set(productionId, a);
  }
  return a;
}

function writeRunFor(productionId: string): WriteRun {
  let run = writeRuns.get(productionId);
  if (!run) {
    run = { sent: 0, landed: 0 };
    writeRuns.set(productionId, run);
  }
  return run;
}

function apply(s: ChannelState, c: FastFeedChange): void {
  if ('toMain' in c) {
    if (c.toMain) s.offProgram.delete(c.channel);
    else s.offProgram.add(c.channel);
  } else if ('muted' in c) {
    if (c.muted) s.muted.add(c.channel);
    else s.muted.delete(c.channel);
  } else {
    s.gains.set(c.channel, c.gain);
  }
}

const NOTHING_WRITTEN: FastFeedWrite = { done: () => undefined };

/**
 * Applies `changes` for a mixer write about to go out, so the router can follow
 * as soon as the mixer accepts it (`syncFastFeedRouter`). Call `done` when the
 * mixer answers, accepted or not: the mixer is read once nothing is on its way.
 *
 * @param rampMs how long the mixer takes to move to the new values
 */
export function beginFastFeedWrite(
  productionId: string,
  changes: Iterable<FastFeedChange>,
  { rampMs = 0 }: { rampMs?: number } = {},
): FastFeedWrite {
  const list = [...changes];
  if (list.length === 0) return NOTHING_WRITTEN;
  const s = stateFor(productionId);
  for (const c of list) apply(s, c);
  const a = activityFor(productionId);
  a.inFlight++;
  a.begun++;
  a.retries = RETRIES;
  let open = true;
  const done = (): void => {
    if (!open) return;
    open = false;
    clearTimeout(cap);
    if (activity.get(productionId) !== a) return;
    a.inFlight--;
    a.rampUntil = Math.max(a.rampUntil, Date.now() + rampMs);
    scheduleRead(productionId, QUIET_MS);
  };
  const cap = setTimeout(done, WRITE_CAP_MS);
  cap.unref?.();
  return { done };
}

/** Sets how the mixer of a production is read. */
export function setFastFeedMixerReader(fn: MixerReader | undefined): void {
  mixerReader = fn;
}

/** Reads the production's mixer once it is quiet, and writes what it holds to the router. */
export function requestFastFeedRead(productionId: string): void {
  scheduleRead(productionId, QUIET_MS);
}

function scheduleRead(productionId: string, delayMs: number): void {
  if (!mixerReader) return;
  const a = activityFor(productionId);
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    a.timer = undefined;
    void readMixer(productionId, a);
  }, Math.max(delayMs, a.rampUntil - Date.now()));
  a.timer.unref?.();
}

function retryRead(productionId: string, a: Activity): void {
  if (activity.get(productionId) !== a) return;
  if (a.retries-- > 0) scheduleRead(productionId, RETRY_MS);
  else console.warn('[fast-feed] stopped retrying until the next crew change');
}

async function readMixer(productionId: string, a: Activity): Promise<void> {
  // A write still on its way reads the mixer again once answered.
  if (activity.get(productionId) !== a || a.inFlight > 0) return;
  const begun = a.begun;
  const found = await mixerReader!(productionId).catch((err: unknown) => {
    console.warn('[fast-feed] mixer read error:', String(err));
    return undefined;
  });
  if (activity.get(productionId) !== a || found === null) return;
  // A write started during the read may have landed after it; its answer reads again.
  if (a.begun !== begun || a.inFlight > 0) return;
  if (!found?.changes || !found.router) {
    retryRead(productionId, a);
    return;
  }
  const s: ChannelState = { offProgram: new Set(), muted: new Set(), gains: new Map() };
  for (const c of found.changes) apply(s, c);
  stateByProduction.set(productionId, s);
  confirmedProductions.add(productionId);
  const last = lastSent.get(productionId);
  const holds = last?.router.flowId === found.router.flowId && last.router.blockId === found.router.blockId
    && last.matrix === fastFeedMatrix(productionId, found.router);
  if (!holds) await syncFastFeedRouter(productionId, found.router, found.strom);
}

/**
 * Forgets the production's channel state (every channel open at unity), that it
 * matched the mixer, its pending read, and its router writes: one still on its
 * way is not waited for, and one not yet sent is dropped.
 */
export function clearFastFeedState(productionId: string): void {
  stateByProduction.delete(productionId);
  confirmedProductions.delete(productionId);
  clearTimeout(activity.get(productionId)?.timer);
  activity.delete(productionId);
  pendingWrite.delete(productionId);
  waitingWrite.delete(productionId);
  writeRuns.delete(productionId);
  lastSent.delete(productionId);
}

/** Marks the production's channel state as matching its mixer, so it may be written to the router. */
export function confirmFastFeedState(productionId: string): void {
  confirmedProductions.add(productionId);
}

/** The router's `routing_matrix` for the production's current channel state. */
export function fastFeedMatrix(productionId: string, router: Pick<FastFeedRouter, 'numInputs' | 'ownChannels'>): string {
  const s = stateByProduction.get(productionId);
  const closed = new Set([...(s?.offProgram ?? []), ...(s?.muted ?? [])]);
  return fastRoutingMatrix(router.numInputs, router.ownChannels, closed, s?.gains);
}

/**
 * Writes the production's channel state into its fast feeds' router, after any
 * write already on its way. Callers do not wait for it: the crew's own feedback
 * never waits on the fast feeds. A write still waiting its turn picks up later
 * changes, so a slow router gets one write, not a backlog. After a timeout the
 * next write goes out; a timed-out write that lands after a later one is
 * followed by a fresh one. A failed write is logged, and the mixer is read again
 * to retry it.
 *
 * @param onlyIfChanged skip the write when nothing has been recorded (the router
 *   was built with every channel open at unity)
 */
export function syncFastFeedRouter(
  productionId: string,
  router: FastFeedRouter | undefined,
  strom: Pick<StromClient, 'flows'>,
  { onlyIfChanged = false }: { onlyIfChanged?: boolean } = {},
): Promise<void> {
  if (!router || !confirmedProductions.has(productionId)) return Promise.resolve();
  if (onlyIfChanged && !stateByProduction.has(productionId)) return Promise.resolve();
  const waiting = waitingWrite.get(productionId);
  if (waiting && waiting.flowId === router.flowId && waiting.blockId === router.blockId) return waiting.write;

  const run = writeRunFor(productionId);
  const previous = pendingWrite.get(productionId) ?? Promise.resolve();
  const next: Promise<void> = previous.then(async () => {
    if (waitingWrite.get(productionId)?.write === next) waitingWrite.delete(productionId);
    if (writeRuns.get(productionId) !== run) return;
    const routing_matrix = fastFeedMatrix(productionId, router);
    const sent = ++run.sent;
    lastSent.set(productionId, { router, matrix: routing_matrix });
    const request = strom.flows.updateBlockProperties(router.flowId, router.blockId, { properties: { routing_matrix } });
    const answered = request.then(() => {
      // Strom may answer writes out of order. One answered after a later write
      // has put an older matrix back, so the current state goes out again.
      const overtaken = run.landed > sent;
      run.landed = Math.max(run.landed, sent);
      if (overtaken && writeRuns.get(productionId) === run) void syncFastFeedRouter(productionId, router, strom);
    }, (err: unknown) => {
      console.warn('[fast-feed] router update error:', String(err));
      if (writeRuns.get(productionId) !== run) return;
      if (lastSent.get(productionId)?.matrix === routing_matrix) lastSent.delete(productionId);
      retryRead(productionId, activityFor(productionId));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ROUTER_WRITE_TIMEOUT_MS);
    });
    const outcome = await Promise.race([answered, timeout]).finally(() => clearTimeout(timer));
    if (outcome === 'timeout') console.warn(`[fast-feed] router update timed out after ${ROUTER_WRITE_TIMEOUT_MS} ms`);
  }).finally(() => {
    if (pendingWrite.get(productionId) === next) pendingWrite.delete(productionId);
  });
  pendingWrite.set(productionId, next);
  waitingWrite.set(productionId, { flowId: router.flowId, blockId: router.blockId, write: next });
  return next;
}

/** Resolves once no router write is on its way for the production. */
export async function whenFastFeedRouterIdle(productionId: string): Promise<void> {
  for (let p = pendingWrite.get(productionId); p; p = pendingWrite.get(productionId)) await p;
}
