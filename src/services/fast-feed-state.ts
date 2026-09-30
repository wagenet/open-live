/**
 * What the crew has done to each audio channel, as the fast return feeds need it,
 * and the write that puts it into the fast feeds' router (`ProductionDoc.fastFeedRouter`).
 *
 * The fast feed taps each channel's source before the mixer, so the router has to
 * copy the crew's routing (mute / audio-follow-video via `to_main`), the channel
 * mute set through the REST audio route, and the fader level.
 *
 * Callers record a change when they decide it, before the mixer write, and
 * settle or undo it when the mixer answers. Each channel's value is that of its
 * newest change the mixer has not refused, so the state follows the order changes
 * were sent in rather than the order Strom answered. Router writes go out one at
 * a time per production, in the background, and each carries the state current
 * when it is sent.
 *
 * State is only written to a router once it is known to match the mixer: after
 * the first controller connect (which resets every channel) or after activation
 * (a new router and a new mixer both start with every channel open). Until then,
 * changes are recorded but not sent.
 *
 * Whatever the order of answers, a check puts the router right: after a refused
 * or unanswered mixer write, or a failed router write, it reads the mixer a
 * moment later and writes what the mixer holds to the router.
 */

import { fastRoutingMatrix, type FastFeedRouter } from '../lib/fast-returns.js';
import { StromClientError, type StromClient } from '../lib/strom.js';

/** One change to a 0-based channel. */
export type FastFeedChange =
  | { channel: number; toMain: boolean }
  | { channel: number; muted: boolean }
  | { channel: number; gain: number };

type Kind = 'toMain' | 'muted' | 'gain';
type Value = boolean | number | undefined;
interface Change { version: number; value: Value }

interface ChannelState {
  offProgram: Set<number>;
  muted: Set<number>;
  gains: Map<number, number>;
  /**
   * Per `<kind>:<channel>`: the newest change the mixer accepted, and the changes
   * it has not answered yet. The channel's value is the newest of these.
   */
  changes: Map<string, { settled: Change; unanswered: Change[] }>;
  nextVersion: number;
  /** Router writes sent so far, so an undo knows whether one carried the change. */
  routerWrites: number;
}

/** A recorded change, to settle once the mixer accepts it or undo if it refuses. */
export interface FastFeedRecord {
  settle(): void;
  /**
   * Undoes the change after a failed mixer write, or keeps it when `err` leaves
   * open whether the mixer applied it (see `mixerRefused`). Either way a check
   * follows. Returns whether the router needs writing again.
   */
  undo(err?: unknown): boolean;
}

/**
 * Whether a failed mixer write was refused by Strom itself (4xx, or a 500 it
 * answered). A lost reply (no connection, a gateway 502-504, a timeout) may
 * follow a write Strom applied.
 */
export function mixerRefused(err: unknown): boolean {
  return err instanceof StromClientError && err.status >= 400 && err.status <= 500;
}

const stateByProduction = new Map<string, ChannelState>();
const confirmedProductions = new Set<string>();
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

function writeRunFor(productionId: string): WriteRun {
  let run = writeRuns.get(productionId);
  if (!run) {
    run = { sent: 0, landed: 0 };
    writeRuns.set(productionId, run);
  }
  return run;
}

function stateFor(productionId: string): ChannelState {
  let s = stateByProduction.get(productionId);
  if (!s) {
    s = { offProgram: new Set(), muted: new Set(), gains: new Map(), changes: new Map(), nextVersion: 1, routerWrites: 0 };
    stateByProduction.set(productionId, s);
  }
  return s;
}

function kindOf(change: FastFeedChange): Kind {
  return 'toMain' in change ? 'toMain' : 'muted' in change ? 'muted' : 'gain';
}

function read(s: ChannelState, kind: Kind, ch: number): Value {
  if (kind === 'toMain') return !s.offProgram.has(ch);
  if (kind === 'muted') return s.muted.has(ch);
  return s.gains.get(ch);
}

function write(s: ChannelState, kind: Kind, ch: number, value: Value): void {
  if (kind === 'toMain') {
    if (value) s.offProgram.delete(ch);
    else s.offProgram.add(ch);
  } else if (kind === 'muted') {
    if (value) s.muted.add(ch);
    else s.muted.delete(ch);
  } else if (value === undefined) {
    s.gains.delete(ch);
  } else {
    s.gains.set(ch, value as number);
  }
}

function newest(c: { settled: Change; unanswered: Change[] }): Change {
  return c.unanswered.reduce((a, b) => (b.version > a.version ? b : a), c.settled);
}

const NOTHING_RECORDED: FastFeedRecord = { settle: () => undefined, undo: () => false };

/**
 * Records `changes` for a mixer write. Settle the record when the mixer accepts
 * the write, and undo it when the mixer refuses; a change neither settled nor
 * undone still counts. The router is written by `syncFastFeedRouter`.
 */
export function recordFastFeedChanges(productionId: string, changes: Iterable<FastFeedChange>): FastFeedRecord {
  const list = [...changes];
  if (list.length === 0) return NOTHING_RECORDED;
  const s = stateFor(productionId);
  const recorded: Array<{ kind: Kind; channel: number; key: string; change: Change }> = [];
  for (const c of list) {
    const kind = kindOf(c);
    const key = `${kind}:${c.channel}`;
    let entry = s.changes.get(key);
    if (!entry) {
      entry = { settled: { version: 0, value: read(s, kind, c.channel) }, unanswered: [] };
      s.changes.set(key, entry);
    }
    const change = { version: s.nextVersion++, value: 'toMain' in c ? c.toMain : 'muted' in c ? c.muted : c.gain };
    entry.unanswered.push(change);
    write(s, kind, c.channel, newest(entry).value);
    recorded.push({ kind, channel: c.channel, key, change });
  }
  const routerWritesBefore = s.routerWrites;
  let answered = false;
  const answer = (accepted: boolean): void => {
    answered = true;
    for (const r of recorded) {
      const entry = s.changes.get(r.key)!;
      entry.unanswered = entry.unanswered.filter((c) => c !== r.change);
      if (accepted) {
        if (r.change.version > entry.settled.version) entry.settled = r.change;
      } else {
        write(s, r.kind, r.channel, newest(entry).value);
      }
    }
  };
  return {
    settle: () => { if (!answered) answer(true); },
    undo: (err) => {
      if (answered || stateByProduction.get(productionId) !== s) return false;
      requestFastFeedCheck(productionId);
      if (err !== undefined && !mixerRefused(err)) {
        answer(true);
        return true;
      }
      answer(false);
      // A router write sent since the change was recorded may have carried it.
      return s.routerWrites > routerWritesBefore && routerIsBehind(productionId);
    },
  };
}

/** Whether the router may not hold the production's current state. */
function routerIsBehind(productionId: string): boolean {
  const last = lastSent.get(productionId);
  return !last || fastFeedMatrix(productionId, last.router) !== last.matrix;
}

/** Marks the start of a mixer read, for `fillFastFeedFromMixer`. */
export function fastFeedReadMark(productionId: string): number {
  return stateByProduction.get(productionId)?.nextVersion ?? 1;
}

/**
 * Takes the production's channel state from a read of the mixer that started at
 * `mark`. A change recorded since then, or still waiting on the mixer's answer,
 * stays newer than the read, since the read may have reached Strom before it.
 */
export function fillFastFeedFromMixer(productionId: string, changes: Iterable<FastFeedChange>, mark: number): void {
  const s = stateFor(productionId);
  for (const c of changes) {
    const kind = kindOf(c);
    const key = `${kind}:${c.channel}`;
    const value = 'toMain' in c ? c.toMain : 'muted' in c ? c.muted : c.gain;
    let entry = s.changes.get(key);
    if (!entry) {
      entry = { settled: { version: 0, value }, unanswered: [] };
      s.changes.set(key, entry);
    } else if (entry.settled.version < mark) {
      entry.settled = { version: 0, value };
    }
    write(s, kind, c.channel, newest(entry).value);
  }
}

/** What a check reads: the mixer's channel state, or null when the read is incomplete, and where to write it. */
export interface FastFeedCheckRead {
  changes: FastFeedChange[] | null;
  router: FastFeedRouter | undefined;
  strom: Pick<StromClient, 'flows'>;
}

type FastFeedChecker = (productionId: string) => Promise<FastFeedCheckRead | null>;
let checker: FastFeedChecker | undefined;
const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Checks in a row that could not put the router right, per production. */
const checkFailures = new Map<string, number>();
/** Bumped when a production's state is cleared, so a check from before the clear stops. */
const generations = new Map<string, number>();

/** How long after a failure the check reads the mixer, and how many checks in a row may fail. */
const CHECK_DELAY_MS = 2000;
const CHECK_ATTEMPTS = 5;

/** Sets how a check reads a production's mixer and finds its router. */
export function setFastFeedChecker(fn: FastFeedChecker | undefined): void {
  checker = fn;
}

/** Reads the mixer shortly and writes what it holds to the router, unless a check is already due. */
export function requestFastFeedCheck(productionId: string): void {
  if (!checker || checkTimers.has(productionId)) return;
  const timer = setTimeout(() => {
    checkTimers.delete(productionId);
    void runCheck(productionId);
  }, CHECK_DELAY_MS);
  timer.unref?.();
  checkTimers.set(productionId, timer);
}

function checkFailed(productionId: string): void {
  const failures = (checkFailures.get(productionId) ?? 0) + 1;
  checkFailures.set(productionId, failures);
  if (failures < CHECK_ATTEMPTS) requestFastFeedCheck(productionId);
  else console.warn(`[fast-feed] gave up putting the router right after ${failures} checks`);
}

async function runCheck(productionId: string): Promise<void> {
  const generation = generations.get(productionId);
  const mark = fastFeedReadMark(productionId);
  const found = await checker!(productionId).catch((err) => {
    console.warn('[fast-feed] mixer read error:', String(err));
    return null;
  });
  if (generations.get(productionId) !== generation) return;
  if (!found?.changes || !found.router) {
    checkFailed(productionId);
    return;
  }
  fillFastFeedFromMixer(productionId, found.changes, mark);
  confirmFastFeedState(productionId);
  if (!routerIsBehind(productionId) && lastSent.get(productionId)?.router.flowId === found.router.flowId) {
    checkFailures.delete(productionId);
    return;
  }
  await syncFastFeedRouter(productionId, found.router, found.strom);
}

/**
 * Forgets the production's channel state (every channel open at unity), that it
 * matched the mixer, and its router writes: one still on its way is not waited
 * for, and one not yet sent is dropped.
 */
export function clearFastFeedState(productionId: string): void {
  stateByProduction.delete(productionId);
  confirmedProductions.delete(productionId);
  pendingWrite.delete(productionId);
  waitingWrite.delete(productionId);
  writeRuns.delete(productionId);
  lastSent.delete(productionId);
  clearTimeout(checkTimers.get(productionId));
  checkTimers.delete(productionId);
  checkFailures.delete(productionId);
  generations.set(productionId, (generations.get(productionId) ?? 0) + 1);
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

/** How long a router write may take before the next one goes out. */
const ROUTER_WRITE_TIMEOUT_MS = 5000;

/**
 * Writes the production's channel state into its fast feeds' router, after any
 * write already on its way. Callers do not wait for it: the crew's own feedback
 * never waits on the fast feeds. A write still waiting its turn picks up later
 * changes, so a slow router gets one write, not a backlog. A failure or timeout
 * is logged and followed by a check. A timed-out write that lands after a later
 * write is followed by a fresh one.
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
    const s = stateByProduction.get(productionId);
    if (s) s.routerWrites++;
    const sent = ++run.sent;
    lastSent.set(productionId, { router, matrix: routing_matrix });
    const request = strom.flows.updateBlockProperties(router.flowId, router.blockId, { properties: { routing_matrix } });
    // Strom may answer writes out of order. One answered after a later write
    // has put an older matrix back, so the current state goes out again.
    void request.then(() => {
      const overtaken = run.landed > sent;
      run.landed = Math.max(run.landed, sent);
      if (writeRuns.get(productionId) !== run) return;
      if (sent === run.sent) checkFailures.delete(productionId);
      if (overtaken) void syncFastFeedRouter(productionId, router, strom);
    }, () => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, ROUTER_WRITE_TIMEOUT_MS);
    });
    const failed = await Promise.race([request, timeout]).then(
      () => timedOut,
      (err) => { console.warn('[fast-feed] router update error:', String(err)); return true; },
    ).finally(() => clearTimeout(timer));
    if (timedOut) console.warn(`[fast-feed] router update timed out after ${ROUTER_WRITE_TIMEOUT_MS} ms`);
    if (failed && writeRuns.get(productionId) === run) {
      if (lastSent.get(productionId)?.matrix === routing_matrix) lastSent.delete(productionId);
      checkFailed(productionId);
    }
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
