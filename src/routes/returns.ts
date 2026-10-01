import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, getGuestInvitesDb, getGuestSessionsDb } from '../db/index.js';
import type { GuestInviteDoc, ProductionDoc } from '../db/types.js';
import { getStromToken } from '../lib/strom-token.js';
import { assertSameStromOrigin } from '../lib/url-validation.js';
import { config, isGuestCallingEnabled } from '../config.js';
import { getGuestSigningKey } from '../lib/guest-signing-key.js';
import { verifyGuestInviteToken, hashGuestInviteToken } from '../lib/guest-invite-token.js';
import { applyReturnMode } from '../ws/controller.js';
import { returnModesFor } from './guests.js';

/**
 * Per-guest return feed routes (epic #208, issue #300,
 * `docs/specs/guest-calling-intercom.md` §"Return feeds").
 *
 * A return feed is on-air program audio minus the guest (mix-minus). The picture
 * feed is program video over WHEP with exactly one audio track — that guest's
 * return aux bus. The Strom WHEP target is derived SERVER-SIDE from the
 * production doc's `returnWhepUrls` (scoped to the guest's mixerInput), never
 * `/whep-proxy?target=` which would forward to any Strom URL and so could not be
 * guest-scoped (spec §"Return feeds", §Scoping).
 */

// Only `program` / `program-minus` change the mix. `low-latency-minus` is a
// client-side feed choice (play the fast feed) and returns 400 (spec §"Mode changes").
const ModeBody = z.object({
  mode: z.enum(['program', 'program-minus', 'low-latency-minus']),
});

/** Extract a Bearer token from the Authorization header, if present. */
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

type FeedId = 'picture' | 'fast';

/** Resolve the internal Strom WHEP URL for one of a production's return feeds on a mixerInput. */
function returnStromUrl(doc: ProductionDoc, mixerInput: string, feed: FeedId = 'picture'): string | undefined {
  const urls = feed === 'fast' ? doc.fastWhepUrls : doc.returnWhepUrls;
  return (urls ?? []).find((r) => r.mixerInput === mixerInput)?.url;
}

/** Guest-session field that binds the guest's WHEP session id for a feed. */
const SESSION_FIELD = { picture: 'returnWhepSessionId', fast: 'fastWhepSessionId' } as const;

const MAX_BIND_ATTEMPTS = 3;

/**
 * Writes one feed's WHEP session id onto the guest session. Re-reads the doc on
 * every attempt and retries a 409: a client opens the picture and fast feeds
 * together, and a write from a stale snapshot would drop the other feed's binding.
 */
async function bindGuestWhepSession(sessionDocId: string, feed: FeedId, whepSessionId: string): Promise<void> {
  const db = getGuestSessionsDb();
  for (let attempt = 1; ; attempt++) {
    try {
      const current = await db.get(sessionDocId);
      await db.insert({ ...current, [SESSION_FIELD[feed]]: whepSessionId, updatedAt: new Date().toISOString() });
      return;
    } catch (err) {
      const conflict = (err as { statusCode?: number }).statusCode === 409;
      if (!conflict || attempt >= MAX_BIND_ATTEMPTS) throw err;
    }
  }
}

/** Builds the crew/guest join-shape view of a return on an input. */
function returnView(doc: ProductionDoc, mixerInput: string) {
  const assignment = doc.sources.find((s) => s.mixerInput === mixerInput);
  const returnFeed = assignment?.returnFeed;
  const active = doc.status === 'active' && !!doc.stromFlowId;
  const base = `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(mixerInput)}`;
  const feeds: Array<{ id: FeedId; url: string; video: boolean }> = [];
  if (active && returnStromUrl(doc, mixerInput)) feeds.push({ id: 'picture', url: `${base}/picture/whep`, video: true });
  const fast = active && !!returnStromUrl(doc, mixerInput, 'fast');
  if (fast) feeds.push({ id: 'fast', url: `${base}/fast/whep`, video: false });
  return {
    publish: mixerInput,
    modes: returnModesFor(mixerInput, fast),
    defaultMode: 'program-minus' as const,
    returnMode: (returnFeed?.synced ?? 'program-minus') as 'program' | 'program-minus',
    feeds,
  };
}

const returnsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  // -------------------------------------------------------------------------
  // Crew — GET join shape for an input (contributor pages before invites land)
  // -------------------------------------------------------------------------
  fastify.get<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput',
    async (req, reply) => {
      let doc: ProductionDoc;
      try {
        doc = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const assignment = doc.sources.find((s) => s.mixerInput === req.params.mixerInput);
      if (!assignment) {
        return reply.status(404).send({ error: 'No assignment on that input', statusCode: 404 });
      }
      return reply.send(returnView(doc, req.params.mixerInput));
    },
  );

  // -------------------------------------------------------------------------
  // Crew — PUT mode (persist + apply live + broadcast RETURN_STATE)
  // -------------------------------------------------------------------------
  fastify.put<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput/mode',
    async (req, reply) => {
      const body = ModeBody.parse(req.body);
      // low-latency-minus is a client-side feed choice, not built in v1.
      if (body.mode === 'low-latency-minus') {
        return reply.status(400).send({ error: 'low-latency-minus is not available in v1', statusCode: 400 });
      }
      const result = await applyReturnMode(req.params.id, req.params.mixerInput, body.mode);
      if (!result.ok) {
        if (result.code === 'not_found') {
          return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
        }
        return reply.status(400).send({ error: 'Invalid mode', statusCode: 400 });
      }
      return reply.send({ mixerInput: result.mixerInput, mode: result.mode });
    },
  );

  // -------------------------------------------------------------------------
  // Crew — POST/DELETE the picture and fast WHEP feeds (signaling proxy, server-scoped)
  // -------------------------------------------------------------------------
  for (const feed of ['picture', 'fast'] as const) {
    fastify.post<{ Params: { id: string; mixerInput: string } }>(
      `/api/v1/productions/:id/returns/:mixerInput/${feed}/whep`,
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        let doc: ProductionDoc;
        try {
          doc = await getDb().get(req.params.id);
        } catch {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        if (doc.status !== 'active' || !doc.stromFlowId) {
          return reply.status(409).send({ error: 'production_inactive', statusCode: 409 });
        }
        const target = returnStromUrl(doc, req.params.mixerInput, feed);
        if (!target) {
          return reply.status(404).send({ error: 'feed_unavailable', statusCode: 404 });
        }
        // Defence in depth: the derived target must be on the Strom host.
        try {
          assertSameStromOrigin(target, config.stromUrl, 'Return target');
        } catch {
          return reply.status(404).send({ error: 'feed_unavailable', statusCode: 404 });
        }

        const token = await getStromToken(config.stromToken).catch(() => undefined);
        const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        let upstream: Response;
        try {
          upstream = await fetch(target, { method: 'POST', headers, body: req.body as string });
        } catch (err) {
          fastify.log.warn({ err, feed }, 'return WHEP: upstream unreachable');
          return reply.status(503).send({ error: 'feed_unavailable', statusCode: 503 });
        }
        if (!upstream.ok) {
          return reply.status(upstream.status).send(await upstream.text());
        }
        const answerSdp = await upstream.text();
        // Scope teardown back through THIS route's session subpath (not a raw target
        // param) so a guest cannot tear down another endpoint (spec §Scoping).
        const stromLocation = upstream.headers.get('Location');
        let sessionId = '';
        if (stromLocation) {
          sessionId = stromLocation.split('/').pop() ?? '';
          reply.header(
            'Location',
            `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(req.params.mixerInput)}/${feed}/whep/${encodeURIComponent(sessionId)}`,
          );
        }
        // Bind this WHEP session id to the guest's live session (issue #380) so
        // the matching DELETE can verify a guest caller only tears down their
        // OWN return session — never another guest's :sessionId. Best-effort: a
        // persist failure here does not fail the (already-established) upstream
        // session; the guest just fails closed on their next DELETE instead of
        // silently trusting an unbound id (see the DELETE handler below).
        if (req.guestScope && sessionId) {
          try {
            await bindGuestWhepSession(req.guestScope.session._id, feed, sessionId);
          } catch (err) {
            fastify.log.warn({ err, feed }, 'return WHEP: guest session-id bind failed');
          }
        }
        reply.header('Content-Type', 'application/sdp');
        return reply.status(201).send(answerSdp);
      },
    );

    fastify.delete<{ Params: { id: string; mixerInput: string; sessionId: string } }>(
      `/api/v1/productions/:id/returns/:mixerInput/${feed}/whep/:sessionId`,
      async (req, reply) => {
        // Guest callers may only tear down the WHEP session bound to THEIR OWN
        // live session (issue #380) — the crew/API_KEY path below (unbound,
        // origin + :sessionId) is unchanged and still available to full-access
        // callers, who are trusted operators scoped by the shared API_KEY.
        if (req.guestScope) {
          if (req.guestScope.session[SESSION_FIELD[feed]] !== req.params.sessionId) {
            return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
          }
        }
        let doc: ProductionDoc;
        try {
          doc = await getDb().get(req.params.id);
        } catch {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        const base = returnStromUrl(doc, req.params.mixerInput, feed);
        if (!base) return reply.status(204).send();
        // Rebuild the Strom resource URL from the endpoint origin + session id — the
        // session is tied to THIS return's endpoint path, not an arbitrary target.
        const origin = new URL(base).origin;
        const target = `${origin}/whep/${encodeURIComponent(req.params.sessionId)}`;
        const token = await getStromToken(config.stromToken).catch(() => undefined);
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        await fetch(target, { method: 'DELETE', headers }).catch(() => {/* ignore teardown errors */});
        return reply.status(204).send();
      },
    );
  }

  // -------------------------------------------------------------------------
  // Guest — PUT session/return (token-authed; same shared mode handler)
  // -------------------------------------------------------------------------
  fastify.put<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session/return',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) {
        return reply.status(503).send({ error: 'Guest calling is disabled', statusCode: 503 });
      }
      const body = ModeBody.parse(req.body);
      if (body.mode === 'low-latency-minus') {
        return reply.status(400).send({ error: 'low-latency-minus is not available in v1', statusCode: 400 });
      }
      const secret = getGuestSigningKey()!;
      const token = bearerToken(req);
      if (!token) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      const verified = verifyGuestInviteToken(token, secret);
      if (!verified.ok || verified.claims.inviteId !== req.params.inviteId) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      let invite: GuestInviteDoc;
      try {
        invite = await getGuestInvitesDb().get(req.params.inviteId);
      } catch {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      if (invite.tokenHash !== hashGuestInviteToken(token)) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }

      // The guest's live session pins its mixerInput — the token is scoped to it.
      let production: ProductionDoc;
      try {
        production = await getDb().get(invite.productionId);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const assignment = production.sources.find(
        (s) => s.mixerInput === invite.mixerInput,
      );
      if (!invite.mixerInput || !assignment?.returnFeed) {
        return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
      }
      const result = await applyReturnMode(invite.productionId, invite.mixerInput, body.mode);
      if (!result.ok) {
        return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
      }
      return reply.send({ mixerInput: result.mixerInput, mode: result.mode });
    },
  );
};

export default returnsRoutes;
