/**
 * What the crew has done to each audio channel, as the fast return feeds need it,
 * and the write that puts it into the fast feeds' router (`ProductionDoc.fastFeedRouter`).
 *
 * The fast feed taps each channel's source before the mixer, so the router has to
 * copy the crew's routing (mute / audio-follow-video via `to_main`), the channel
 * mute set through the REST audio route, and the fader level.
 *
 * Callers record a change when they decide it, before the mixer write, so the
 * state follows the order changes were sent in rather than the order Strom
 * answered; a change the mixer rejected is undone. Router writes go out one at a
 * time per production, in the background, and each carries the state current
 * when it is sent.
 *
 * State is only written to a router once it is known to match the mixer: after
 * the first controller connect (which resets every channel) or after activation
 * (a new router and a new mixer both start with every channel open). Until then,
 * changes are recorded but not sent.
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
  /** Version of the last change per `<kind>:<channel>`, so an undo never reverts a newer change. */
  versions: Map<string, number>;
  nextVersion: number;
}

const stateByProduction = new Map<string, ChannelState>();
const confirmedProductions = new Set<string>();
const pendingWrite = new Map<string, Promise<void>>();
/** A write queued behind another and not yet sent, with the router it is for. */
const waitingWrite = new Map<string, { flowId: string; blockId: string; write: Promise<void> }>();

function stateFor(productionId: string): ChannelState {
  let s = stateByProduction.get(productionId);
  if (!s) {
    s = { offProgram: new Set(), muted: new Set(), gains: new Map(), versions: new Map(), nextVersion: 1 };
    stateByProduction.set(productionId, s);
  }
  return s;
}

type Kind = 'toMain' | 'muted' | 'gain';
type Value = boolean | number | undefined;

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

/**
 * Records `changes` and returns a function that undoes them, for when the mixer
 * write they belong to fails. The undo skips any channel changed again since.
 * The router is written by `syncFastFeedRouter`.
 */
export function recordFastFeedChanges(productionId: string, changes: Iterable<FastFeedChange>): () => void {
  const s = stateFor(productionId);
  const undo: Array<{ key: string; kind: Kind; channel: number; previous: Value; version: number }> = [];
  for (const change of changes) {
    const kind = kindOf(change);
    const key = `${kind}:${change.channel}`;
    const version = s.nextVersion++;
    undo.push({ key, kind, channel: change.channel, previous: read(s, kind, change.channel), version });
    const value = 'toMain' in change ? change.toMain : 'muted' in change ? change.muted : change.gain;
    write(s, kind, change.channel, value);
    s.versions.set(key, version);
  }
  return () => {
    for (const u of undo.reverse()) {
      if (s.versions.get(u.key) !== u.version) continue;
      write(s, u.kind, u.channel, u.previous);
      s.versions.delete(u.key);
    }
  };
}

/** Forgets the production's channel state (every channel open at unity) and that it matched the mixer. */
export function clearFastFeedState(productionId: string): void {
  stateByProduction.delete(productionId);
  confirmedProductions.delete(productionId);
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
 * is logged and costs only the fast feeds' copy of the change.
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

  const previous = pendingWrite.get(productionId) ?? Promise.resolve();
  const next: Promise<void> = previous.then(async () => {
    if (waitingWrite.get(productionId)?.write === next) waitingWrite.delete(productionId);
    const routing_matrix = fastFeedMatrix(productionId, router);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ROUTER_WRITE_TIMEOUT_MS} ms`)), ROUTER_WRITE_TIMEOUT_MS);
    });
    await Promise.race([
      strom.flows.updateBlockProperties(router.flowId, router.blockId, { properties: { routing_matrix } }),
      timeout,
    ])
      .catch((err) => console.warn('[fast-feed] router update error:', String(err)))
      .finally(() => clearTimeout(timer));
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
