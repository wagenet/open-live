/**
 * What the crew has done to each audio channel, as the fast return feeds need it,
 * and the write that puts it into the fast feeds' router (`ProductionDoc.fastFeedRouter`).
 *
 * The fast feed taps each channel's source before the mixer, so the router has to
 * copy the crew's routing (mute / audio-follow-video via `to_main`), the channel
 * mute set through the REST audio route, and the fader level. State is recorded
 * even while the production has no router yet, so a change made while the
 * production is still starting is applied once the router exists.
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

const stateByProduction = new Map<string, ChannelState>();

function stateFor(productionId: string): ChannelState {
  let s = stateByProduction.get(productionId);
  if (!s) stateByProduction.set(productionId, (s = { offProgram: new Set(), muted: new Set(), gains: new Map() }));
  return s;
}

/** Records `changes`; the router is written by `syncFastFeedRouter`. */
export function recordFastFeedChanges(productionId: string, changes: Iterable<FastFeedChange>): void {
  const s = stateFor(productionId);
  for (const change of changes) {
    if ('toMain' in change) {
      if (change.toMain) s.offProgram.delete(change.channel);
      else s.offProgram.add(change.channel);
    } else if ('muted' in change) {
      if (change.muted) s.muted.add(change.channel);
      else s.muted.delete(change.channel);
    } else {
      s.gains.set(change.channel, change.gain);
    }
  }
}

/** Forgets the production's channel state: every channel open at unity. */
export function clearFastFeedState(productionId: string): void {
  stateByProduction.delete(productionId);
}

/** The router's `routing_matrix` for the production's current channel state. */
export function fastFeedMatrix(productionId: string, router: Pick<FastFeedRouter, 'numInputs' | 'ownChannels'>): string {
  const s = stateByProduction.get(productionId);
  const closed = new Set([...(s?.offProgram ?? []), ...(s?.muted ?? [])]);
  return fastRoutingMatrix(router.numInputs, router.ownChannels, closed, s?.gains);
}

/**
 * Writes the production's channel state into its fast feeds' router. A failure
 * is logged and costs only the fast feeds' copy of the change.
 *
 * @param onlyIfChanged skip the write when nothing has been recorded (the router
 *   was built with every channel open at unity)
 */
export async function syncFastFeedRouter(
  productionId: string,
  router: FastFeedRouter | undefined,
  strom: Pick<StromClient, 'flows'>,
  { onlyIfChanged = false }: { onlyIfChanged?: boolean } = {},
): Promise<void> {
  if (!router) return;
  if (onlyIfChanged && !stateByProduction.has(productionId)) return;
  const routing_matrix = fastFeedMatrix(productionId, router);
  await strom.flows.updateBlockProperties(router.flowId, router.blockId, { properties: { routing_matrix } })
    .catch((err) => console.warn('[fast-feed] router update error:', String(err)));
}
