import type { StromClient } from './strom.js';

/**
 * Low-latency ("fast") return feeds — `returnFeed.lowLatency`
 * (`docs/specs/guest-calling-intercom.md` §"Low-latency mode").
 *
 * A picture feed's audio is held to the program flow's latency plus the WHIP
 * jitterbuffer, because Strom runs every sink in a flow at one latency. The fast
 * feed therefore lives in a second Strom flow (the conversation flow) with its own
 * latency:
 *
 *   program flow:      <channel's audio source> → builtin.audio_bridge_output
 *   conversation flow: builtin.audio_bridge_input → builtin.liveaudiorouter
 *                      → builtin.whep_output (audio only), one per fast return
 *
 * The bridge restamps on arrival and time-stretches to hold a small target
 * latency, so a publisher's jitterbuffer does not add to the fast feed. The
 * router sums every channel except the guest's own (mix-minus). Nothing here
 * feeds program output or a recording: time-stretched audio never airs.
 */

/** Router settings verified with five simultaneous WHIP seats (latency / min upstream / output buffer, ms). */
export const FAST_ROUTER_LATENCY_MS = 15;
export const FAST_ROUTER_MIN_UPSTREAM_LATENCY_MS = 10;
export const FAST_ROUTER_OUTPUT_BUFFER_MS = 5;

type Block = Record<string, unknown>;
type Link = { from: string; to: string };

export interface FastReturnRequest {
  mixerInput: string;
  /** N of the guest's `video_in_N` — names the endpoint like the picture feed. */
  padIndex: number;
  /** Guest's own 0-based audio channel, left out of their fast feed. */
  ownChannel: number;
}

export interface FastReturnPlan {
  /** Blocks and links to add to the program flow (one bridge output per channel). */
  programBlocks: Block[];
  programLinks: Link[];
  /** The conversation flow's topology. */
  conversation: { blocks: Block[]; elements: Block[]; links: Link[] };
  /** Fast WHEP endpoint per guest. */
  entries: Array<{ mixerInput: string; endpointId: string }>;
  /** The router block id and its output layout; the flow id is known once created. */
  router: Omit<FastFeedRouter, 'flowId'>;
}

/**
 * Plans the fast return feeds for a production.
 *
 * @param suffix          per-production suffix (keeps bridge channels and endpoints unique across productions)
 * @param channelSources  0-based audio channel → the `block:pad` feeding that mixer channel
 * @param returns         guests that get a fast feed
 * @param targetLatencyMs bridge target latency; Strom's default when undefined
 */
export function planFastReturns(
  suffix: string,
  channelSources: readonly string[],
  returns: readonly FastReturnRequest[],
  targetLatencyMs?: number,
): FastReturnPlan | null {
  if (returns.length === 0 || channelSources.length === 0) return null;
  const programBlocks: Block[] = [];
  const programLinks: Link[] = [];
  const blocks: Block[] = [];
  const elements: Block[] = [];
  const links: Link[] = [];
  const routerId = `b-fast-router-${suffix}`;

  channelSources.forEach((sourcePad, ch) => {
    const channel = `fast-${suffix}-${ch}`;
    const outId = `b-fast-bridge-out-${ch}-${suffix}`;
    const inId = `b-fast-bridge-in-${ch}-${suffix}`;
    programBlocks.push({
      id: outId,
      block_definition_id: 'builtin.audio_bridge_output',
      name: `Fast feed bridge ch${ch + 1}`,
      properties: { channel },
      position: { x: 0, y: 0 },
    });
    programLinks.push({ from: sourcePad, to: `${outId}:audio_in` });
    blocks.push({
      id: inId,
      block_definition_id: 'builtin.audio_bridge_input',
      name: `Bridge ch${ch + 1}`,
      properties: { channel, ...(targetLatencyMs !== undefined ? { target_latency_ms: targetLatencyMs } : {}) },
      position: { x: 0, y: ch * 150 },
    });
    // The router's buses pick their own format; the bridge carries F32LE 48 kHz.
    const convId = `e-fast-conv-${ch}-${suffix}`;
    const resId = `e-fast-res-${ch}-${suffix}`;
    elements.push(
      { id: convId, element_type: 'audioconvert', properties: {}, position: [250, ch * 150] },
      { id: resId, element_type: 'audioresample', properties: {}, position: [400, ch * 150] },
    );
    links.push(
      { from: `${inId}:audio_out`, to: `${convId}:sink` },
      { from: `${convId}:src`, to: `${resId}:sink` },
      { from: `${resId}:src`, to: `${routerId}:audio_in_${ch}` },
    );
  });

  blocks.push({
    id: routerId,
    block_definition_id: 'builtin.liveaudiorouter',
    name: 'Fast feed router',
    properties: {
      num_inputs: channelSources.length,
      num_outputs: returns.length,
      latency: FAST_ROUTER_LATENCY_MS,
      min_upstream_latency: FAST_ROUTER_MIN_UPSTREAM_LATENCY_MS,
      output_buffer_duration: FAST_ROUTER_OUTPUT_BUFFER_MS,
      routing_matrix: fastRoutingMatrix(channelSources.length, returns.map((r) => r.ownChannel)),
    },
    position: { x: 600, y: 0 },
  });

  const entries: FastReturnPlan['entries'] = [];
  returns.forEach((r, out) => {
    const endpointId = `whep-fast-${r.padIndex}-${suffix}`;
    const whepId = `b-fast-${r.padIndex}-${suffix}`;
    blocks.push({
      id: whepId,
      block_definition_id: 'builtin.whep_output',
      name: `Fast return (${r.mixerInput})`,
      properties: { endpoint_id: endpointId, low_latency: true, num_audio_tracks: 1, num_video_tracks: 0 },
      position: { x: 900, y: out * 150 },
    });
    links.push({ from: `${routerId}:audio_out_${out}`, to: `${whepId}:audio_in` });
    entries.push({ mixerInput: r.mixerInput, endpointId });
  });

  return {
    programBlocks,
    programLinks,
    conversation: { blocks, elements, links },
    entries,
    router: { blockId: routerId, numInputs: channelSources.length, ownChannels: returns.map((r) => r.ownChannel) },
  };
}

/**
 * The router's `routing_matrix`: output N sums every channel except
 * `ownChannels[N]` and the channels the crew has taken off program.
 * Crosspoint keys are `i<input>c<channel>` → [`o<output>c<channel>`], stereo.
 *
 * @param numInputs   audio channels on the router
 * @param ownChannels 0-based own channel per router output
 * @param offProgram  0-based channels whose `to_main` is currently off
 */
export function fastRoutingMatrix(
  numInputs: number,
  ownChannels: readonly number[],
  offProgram: ReadonlySet<number> = new Set(),
): string {
  const matrix: Record<string, string[]> = {};
  ownChannels.forEach((own, out) => {
    for (let ch = 0; ch < numInputs; ch++) {
      if (ch === own || offProgram.has(ch)) continue;
      for (const c of [0, 1]) {
        (matrix[`i${ch}c${c}`] ??= []).push(`o${out}c${c}`);
      }
    }
  });
  return JSON.stringify(matrix);
}

/** Where a running fast-feed router lives, persisted as `ProductionDoc.fastFeedRouter`. */
export interface FastFeedRouter {
  /** Conversation flow id. */
  flowId: string;
  /** The `builtin.liveaudiorouter` block id in that flow. */
  blockId: string;
  numInputs: number;
  /** 0-based own channel per router output. */
  ownChannels: number[];
}

/** `properties.description` of a production's conversation flow; ties it to the program flow. */
export function conversationFlowDescription(programFlowId: string): string {
  return `conv:${programFlowId}`;
}

/** Program flow id a conversation flow belongs to, or null for any other flow. */
export function conversationFlowOwner(description: string | undefined): string | null {
  const m = /^conv:(.+)$/.exec(description ?? '');
  return m ? m[1]! : null;
}

/**
 * Stops and deletes every conversation flow whose program flow is not among
 * `flows` (Strom's current flow list). Returns the ids it removed.
 */
export async function removeOrphanConversationFlows(
  strom: Pick<StromClient, 'flows'>,
  flows: ReadonlyArray<{ id: string; properties?: unknown }>,
): Promise<string[]> {
  const live = new Set(flows.map((f) => f.id));
  const removed: string[] = [];
  for (const f of flows) {
    const owner = conversationFlowOwner((f.properties as { description?: string } | undefined)?.description);
    if (!owner || live.has(owner)) continue;
    await strom.flows.stop(f.id).catch(() => undefined);
    await strom.flows.delete(f.id).catch(() => undefined);
    removed.push(f.id);
  }
  return removed;
}
