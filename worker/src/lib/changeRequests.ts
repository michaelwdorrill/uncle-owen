import type { Env } from '../env';
import { occurrenceMoveStatement, type EventRow } from './events';
import { requireActiveGuildMember } from './db';
import { chunkIds, placeholders, queryInChunks, type SqlPredicate } from './d1';
import { buildEventUpdate, requestedInviteStatements } from './eventWrites';
import { newId } from './ids';
import {
  assertIsoDate,
  assertOneOf,
  assertOptionalString,
  assertSafeInt,
  assertString,
  assertTimeRange,
  ConflictError,
  LIMITS,
  ValidationError,
} from './validate';

// Invitee change requests (docs/specs/0003-event-change-requests.md).
//
// The load-bearing idea: an accepted request is translated into the *same*
// write the organizer's own edit uses -- updateEvent for a non-recurring
// time_change (with its existing revision guard doing double duty as the
// concurrency control here too), an occurrence override for a recurring one,
// addInvitesToEvent for add_invitee. This module never writes an event's own
// fields directly.

export interface ChangeRequestRow {
  id: string;
  event_id: string;
  requester_id: string;
  kind: 'time_change' | 'add_invitee';
  proposed_start_at: number | null;
  proposed_end_at: number | null;
  occurrence_date: string;
  target_user_id: string | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  decision_note: string | null;
  event_revision: number;
  vote_threshold_count: number | null;
  vote_deadline_at: number | null;
  vote_resolution_failures: number;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

export interface ChangeRequestInput {
  kind: 'time_change' | 'add_invitee';
  proposedStartAt?: number;
  proposedEndAt?: number;
  occurrenceDate?: string;
  targetUserId?: string;
  message?: string | null;
}

export interface VoteTally {
  yes: number;
  no: number;
  maybe: number;
}

export interface ChangeRequestView {
  id: string;
  kind: 'time_change' | 'add_invitee';
  requesterId: string;
  requesterUsername: string;
  requesterGlobalName: string | null;
  proposedStartAt: number | null;
  proposedEndAt: number | null;
  occurrenceDate: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetGlobalName: string | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  decisionNote: string | null;
  eventRevision: number;
  voteThresholdCount: number | null;
  voteDeadlineAt: number | null;
  tally: VoteTally | null;
  myVote: 'yes' | 'no' | 'maybe' | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  // Advisory only -- see "Staleness" in the spec. Never computed for a
  // recurring time_change, whose accept path doesn't consult events.revision.
  stale: boolean;
  // A pending time change whose occurrence the organizer has cancelled since:
  // it can only be declined (P24-01), so the page says so up front.
  dateCancelled: boolean;
}

export async function loadChangeRequest(env: Env, eventId: string, requestId: string): Promise<ChangeRequestRow | null> {
  return env.DB.prepare(`SELECT * FROM event_change_requests WHERE id = ? AND event_id = ?`)
    .bind(requestId, eventId)
    .first<ChangeRequestRow>();
}

async function isCurrentInvitee(env: Env, eventId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?`)
    .bind(eventId, userId)
    .first();
  return !!row;
}

function validateChangeRequestInput(event: EventRow, input: ChangeRequestInput): void {
  assertOneOf(input.kind, 'kind', ['time_change', 'add_invitee'] as const);

  if (input.message !== undefined) assertOptionalString(input.message, 'message', LIMITS.CHANGE_REQUEST_MESSAGE);

  if (input.kind === 'time_change') {
    if (event.event_type === 'poll') {
      throw new ValidationError('A poll has no single time to move -- propose a new option instead');
    }
    if (input.targetUserId !== undefined) {
      throw new ValidationError('targetUserId is not valid for a time_change request');
    }
    const startAt = assertSafeInt(input.proposedStartAt, 'proposedStartAt');
    const endAt = assertSafeInt(input.proposedEndAt, 'proposedEndAt');
    assertTimeRange(startAt, endAt, 'proposed', LIMITS.MAX_EVENT_DURATION_MS);
    if (event.is_recurring) {
      assertIsoDate(input.occurrenceDate, 'occurrenceDate');
    } else if (input.occurrenceDate !== undefined) {
      throw new ValidationError('occurrenceDate is only valid for a recurring event');
    }
  } else {
    if (input.proposedStartAt !== undefined || input.proposedEndAt !== undefined || input.occurrenceDate !== undefined) {
      throw new ValidationError('proposedStartAt/proposedEndAt/occurrenceDate are not valid for an add_invitee request');
    }
    assertString(input.targetUserId, 'targetUserId', 64);
  }
}

// Filing a request. Bounds are enforced atomically in the same statement as
// the insert (guarded INSERT ... SELECT ... WHERE), the same shape
// eventWrites.ts's quota guards use, so a burst of concurrent requests can't
// all read "under the limit" and all write.
export async function createChangeRequest(
  env: Env,
  event: EventRow,
  requesterId: string,
  input: ChangeRequestInput,
): Promise<string> {
  validateChangeRequestInput(event, input);

  if (event.organizer_id === requesterId) {
    throw new ValidationError('The organizer cannot file a change request on their own event');
  }
  if (!(await isCurrentInvitee(env, event.id, requesterId))) {
    throw new ValidationError('Only a current invitee can file a change request');
  }

  const isTimeChange = input.kind === 'time_change';
  let targetUserId: string | null = null;
  let inviteeCount = 0;

  if (isTimeChange) {
    // Excludes the organizer, per the spec's "Who votes, and the threshold":
    // voters are the invitees, "not the organizer, who has the override
    // instead". Counting them would inflate the majority by one person who
    // cannot vote toward it.
    //
    // This was already wrong before idea 26, for group events whose organizer
    // was a member of an invited group -- they got a row through group
    // resolution and were counted. Idea 26 gives every organizer a row, which
    // would have made it uniformly wrong instead of intermittently.
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ? AND user_id != ?`,
    )
      .bind(event.id, event.organizer_id)
      .first<{ n: number }>();
    inviteeCount = countRow?.n ?? 0;
  } else {
    targetUserId = input.targetUserId!;
    if (!(await requireActiveGuildMember(env, targetUserId, event.guild_id))) {
      throw new ValidationError('That person is not a current member of this server');
    }
    if (await isCurrentInvitee(env, event.id, targetUserId)) {
      throw new ValidationError('That person is already invited');
    }
  }

  const id = newId();
  const now = Date.now();
  // A sole invitee's time change waits for the organizer -- decided 22 Oct
  // 2026, reversing the spec's original call.
  //
  // Spec 0003 said: if the requester is the only invitee, the threshold is 1,
  // their own implicit yes meets it, and the request applies the instant it is
  // filed -- "there's no one else to ask". There is: the organizer. Found on
  // the first browser walkthrough, where the alt moved Michael's event before
  // he saw a request at all. With one invitee, "the invitees agree" and "this
  // one person wants it" are the same statement, so majority voting decides
  // nothing and only removes the organizer's say.
  //
  // So no threshold and no deadline: the request waits for Accept or Decline,
  // exactly as an add_invitee request already does. tryAutoResolve returns on
  // a NULL threshold and the deadline sweep selects on vote_deadline_at <= now,
  // which NULL never satisfies -- so neither can apply it behind the
  // organizer's back. Frozen at filing like the threshold always was: inviting
  // someone afterwards does not turn it back into a vote.
  //
  // Two or more invitees vote exactly as before.
  const organizerDecides = isTimeChange && inviteeCount <= 1;
  // Simple majority of the invitee count read above, frozen on the row --
  // see "Who votes, and the threshold" in the spec for why this is
  // system-computed rather than something the requester supplies.
  const voteThreshold = isTimeChange && !organizerDecides ? Math.max(1, Math.floor(inviteeCount / 2) + 1) : null;
  const voteDeadline = isTimeChange && !organizerDecides ? now + LIMITS.CHANGE_REQUEST_VOTE_WINDOW_MS : null;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO event_change_requests
         (id, event_id, requester_id, kind, proposed_start_at, proposed_end_at, occurrence_date,
          target_user_id, message, status, event_revision, vote_threshold_count, vote_deadline_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM event_change_requests WHERE event_id = ? AND status = 'pending') < ?
         AND (SELECT COUNT(*) FROM event_change_requests WHERE event_id = ? AND requester_id = ? AND status = 'pending') < ?`,
    ).bind(
      id,
      event.id,
      requesterId,
      input.kind,
      isTimeChange ? (input.proposedStartAt ?? null) : null,
      isTimeChange ? (input.proposedEndAt ?? null) : null,
      isTimeChange ? (input.occurrenceDate ?? '') : '',
      targetUserId,
      input.message ?? null,
      event.revision ?? 0,
      voteThreshold,
      voteDeadline,
      now,
      event.id,
      LIMITS.MAX_OPEN_CHANGE_REQUESTS_PER_EVENT,
      event.id,
      requesterId,
      LIMITS.MAX_OPEN_CHANGE_REQUESTS_PER_USER_PER_EVENT,
    ),
  ];

  if (isTimeChange) {
    // The requester's own implicit yes vote (see the spec). Guarded on the
    // parent existing, same reasoning as eventWrites.ts's inviteStatements:
    // if the quota guard above wrote nothing, this must write nothing too
    // rather than hit a foreign-key error against a row that was never made.
    statements.push(
      env.DB.prepare(
        `INSERT INTO event_change_request_votes (request_id, user_id, vote, voted_at)
         SELECT ?, ?, 'yes', ? WHERE EXISTS (SELECT 1 FROM event_change_requests WHERE id = ?)`,
      ).bind(id, requesterId, now, id),
    );
  }

  const results = await env.DB.batch(statements);
  if (results[0].meta.changes === 0) {
    throw new ConflictError('This event already has too many open change requests -- resolve or withdraw one first');
  }

  // Skipped, not merely a no-op, for a request the organizer decides: there is
  // no threshold for it to read, and it would spend a query to find that out.
  if (isTimeChange && !organizerDecides) await tryAutoResolve(env, event, id);

  return id;
}

export async function getVoteTally(env: Env, requestId: string): Promise<VoteTally> {
  const { results } = await env.DB.prepare(
    `SELECT vote, COUNT(*) AS n FROM event_change_request_votes WHERE request_id = ? GROUP BY vote`,
  )
    .bind(requestId)
    .all<{ vote: string; n: number }>();
  const tally: VoteTally = { yes: 0, no: 0, maybe: 0 };
  for (const row of results) {
    if (row.vote === 'yes' || row.vote === 'no' || row.vote === 'maybe') tally[row.vote] = row.n;
  }
  return tally;
}

export async function voteOnChangeRequest(
  env: Env,
  event: EventRow,
  request: ChangeRequestRow,
  userId: string,
  vote: 'yes' | 'no' | 'maybe',
): Promise<void> {
  if (request.kind !== 'time_change') throw new ValidationError('Only a time_change request can be voted on');
  if (request.status !== 'pending') throw new ValidationError('Voting is closed for this request');
  // The organizer decides a request; they do not vote on it -- the spec's "not
  // the organizer, who has the override instead", which createChangeRequest
  // above already enforces for filing. isCurrentInvitee alone stopped being
  // enough when idea 26 gave every organizer an invite row: their vote then
  // counted toward a threshold computed WITHOUT them, so with three invitees
  // (threshold two) the requester's own yes plus the organizer's would carry a
  // request only one invitee had backed. No privilege was gained -- they can
  // accept outright -- but the tally invitees see counted someone the spec
  // excludes. Found on the first browser walkthrough, via the page offering
  // the organizer vote controls for the same reason.
  if (event.organizer_id === userId) {
    throw new ValidationError('The organizer accepts or declines a request rather than voting on it');
  }
  if (!(await isCurrentInvitee(env, event.id, userId))) {
    throw new ValidationError('Only a current invitee can vote');
  }

  await env.DB.prepare(
    `INSERT INTO event_change_request_votes (request_id, user_id, vote, voted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(request_id, user_id) DO UPDATE SET vote = excluded.vote, voted_at = excluded.voted_at`,
  )
    .bind(request.id, userId, vote, Date.now())
    .run();

  await tryAutoResolve(env, event, request.id);
}

// Called synchronously after a vote is cast (and once after filing, for the
// requester's own implicit vote). Mirrors checkThresholdAndResolve in
// lib/polls.ts: re-reads the request fresh rather than trusting the caller's
// copy, since a concurrent vote or an organizer's own accept/decline may have
// already resolved it.
async function tryAutoResolve(env: Env, event: EventRow, requestId: string): Promise<void> {
  const request = await env.DB.prepare(`SELECT * FROM event_change_requests WHERE id = ?`)
    .bind(requestId)
    .first<ChangeRequestRow>();
  if (!request || request.status !== 'pending' || request.kind !== 'time_change' || request.vote_threshold_count == null) {
    return;
  }

  const tally = await getVoteTally(env, requestId);
  if (tally.yes < request.vote_threshold_count) return;

  try {
    await applyAndAccept(env, event, request, null);
  } catch (err) {
    // Someone else (the organizer's own accept, or a concurrent vote that
    // crossed the threshold a moment earlier) already resolved this --
    // updateEvent's revision guard is what actually arbitrates the race, see
    // "Accepting a request" in the spec. Not a failure the voter caused.
    if (err instanceof ConflictError) return;
    throw err;
  }
}

// The one place an accepted request is actually applied, shared by the
// organizer's own accept endpoint and by threshold/deadline auto-resolution.
async function applyAndAccept(
  env: Env,
  event: EventRow,
  request: ChangeRequestRow,
  decidedBy: string | null,
): Promise<void> {
  // D1 serializes the batch. A decline that won before it started keeps
  // every effect out. A failed statement rolls back the entire batch.
  const pending: SqlPredicate = {
    sql: "EXISTS (SELECT 1 FROM event_change_requests WHERE id = ? AND status = 'pending')",
    binds: [request.id],
  };
  let statements: D1PreparedStatement[];
  let applied: SqlPredicate;
  if (request.kind === 'add_invitee') {
    const target = request.target_user_id!;
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM event_invites WHERE event_id = ?')
      .bind(event.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.MAX_INVITEES) throw new ValidationError('This event has reached its limit of invitees');
    statements = await requestedInviteStatements(env, event, target, pending);
    applied = { sql: 'EXISTS (SELECT 1 FROM event_invites WHERE event_id = ? AND user_id = ?)', binds: [event.id, target] };
  } else if (event.is_recurring) {
    const { occurrence_date: date, proposed_start_at: start, proposed_end_at: end } = request;
    statements = [occurrenceMoveStatement(env, event.id, date, start!, end!, { restoreCancelled: false }, pending)];
    applied = {
      sql: `EXISTS (SELECT 1 FROM event_occurrence_overrides WHERE event_id = ? AND occurrence_date = ?
               AND is_cancelled = 0 AND override_start_at = ? AND override_end_at = ?)`,
      binds: [event.id, date, start, end],
    };
  } else {
    const edit = await buildEventUpdate(env, event.id, event.guild_id, {
      isRecurring: false, startAt: request.proposed_start_at!, endAt: request.proposed_end_at!,
      revision: request.event_revision,
    }, event, pending);
    statements = edit.statements;
    applied = { sql: 'EXISTS (SELECT 1 FROM events WHERE id = ? AND mutation_token = ?)', binds: [event.id, edit.mutationToken] };
  }

  const now = Date.now();
  statements.push(env.DB.prepare(
    `UPDATE event_change_requests SET status = 'accepted', applied_at = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending' AND ${applied.sql}`,
  ).bind(now, now, decidedBy, request.id, ...applied.binds));
  const results = await env.DB.batch(statements);
  if (results[results.length - 1].meta.changes > 0) return;

  const current = await loadChangeRequest(env, event.id, request.id);
  if (current?.status !== 'pending') throw new ConflictError('This request has already been decided');
  if (request.kind === 'add_invitee') throw new ConflictError('This event filled up before the request could be accepted');
  if (event.is_recurring) {
    const cancelled = await env.DB.prepare(
      'SELECT 1 FROM event_occurrence_overrides WHERE event_id = ? AND occurrence_date = ? AND is_cancelled = 1',
    ).bind(event.id, request.occurrence_date).first();
    if (cancelled) throw new ConflictError('That date has been cancelled, so this request can no longer be accepted');
    throw new ConflictError(`This event has reached its limit of ${LIMITS.MAX_OVERRIDES_PER_EVENT} changed occurrences`);
  }
  throw new ConflictError();
}

export async function acceptChangeRequest(
  env: Env,
  event: EventRow,
  request: ChangeRequestRow,
  organizerId: string,
): Promise<void> {
  if (request.status !== 'pending') throw new ConflictError('This request has already been decided');
  await applyAndAccept(env, event, request, organizerId);
}

export async function declineChangeRequest(
  env: Env,
  request: ChangeRequestRow,
  organizerId: string,
  note: string | null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE event_change_requests SET status = 'declined', decision_note = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(note, Date.now(), organizerId, request.id)
    .run();
  if (result.meta.changes === 0) throw new ConflictError('This request has already been decided');
}

export async function withdrawChangeRequest(env: Env, request: ChangeRequestRow, requesterId: string): Promise<void> {
  if (request.requester_id !== requesterId) throw new ValidationError('Not your request');
  const result = await env.DB.prepare(
    `UPDATE event_change_requests SET status = 'withdrawn', decided_at = ? WHERE id = ? AND status = 'pending'`,
  )
    .bind(Date.now(), request.id)
    .run();
  if (result.meta.changes === 0) throw new ConflictError('This request has already been decided');
}

const CHANGE_REQUEST_LIST_LIMIT = 200;

async function loadUsersById(env: Env, ids: string[]): Promise<Map<string, { username: string; global_name: string | null }>> {
  const rows = await queryInChunks(ids, 0, async (chunk) => {
    const { results } = await env.DB.prepare(
      `SELECT id, username, global_name FROM users WHERE id IN (${placeholders(chunk.length)})`,
    )
      .bind(...chunk)
      .all<{ id: string; username: string; global_name: string | null }>();
    return results;
  });
  return new Map(rows.map((r) => [r.id, { username: r.username, global_name: r.global_name }]));
}

async function getVoteTalliesFor(env: Env, requestIds: string[]): Promise<Map<string, VoteTally>> {
  const map = new Map<string, VoteTally>();
  if (requestIds.length === 0) return map;
  for (const chunk of chunkIds(requestIds)) {
    const { results } = await env.DB.prepare(
      `SELECT request_id, vote, COUNT(*) AS n FROM event_change_request_votes
       WHERE request_id IN (${placeholders(chunk.length)}) GROUP BY request_id, vote`,
    )
      .bind(...chunk)
      .all<{ request_id: string; vote: string; n: number }>();
    for (const row of results) {
      let t = map.get(row.request_id);
      if (!t) {
        t = { yes: 0, no: 0, maybe: 0 };
        map.set(row.request_id, t);
      }
      if (row.vote === 'yes' || row.vote === 'no' || row.vote === 'maybe') t[row.vote] = row.n;
    }
  }
  return map;
}

async function getMyVotesFor(env: Env, requestIds: string[], userId: string): Promise<Map<string, 'yes' | 'no' | 'maybe'>> {
  const map = new Map<string, 'yes' | 'no' | 'maybe'>();
  if (requestIds.length === 0) return map;
  for (const chunk of chunkIds(requestIds, 1)) {
    const { results } = await env.DB.prepare(
      `SELECT request_id, vote FROM event_change_request_votes
       WHERE user_id = ? AND request_id IN (${placeholders(chunk.length)})`,
    )
      .bind(userId, ...chunk)
      .all<{ request_id: string; vote: 'yes' | 'no' | 'maybe' }>();
    for (const row of results) map.set(row.request_id, row.vote);
  }
  return map;
}

// GET is asymmetric on purpose (see the spec): the organizer sees every
// request on their event, an invitee sees only their own. Tallies are
// aggregate-only -- no per-voter breakdown -- mirroring getOptionTallies'
// shape in lib/polls.ts.
export async function listChangeRequests(
  env: Env,
  event: EventRow,
  viewerId: string,
  isOrganizer: boolean,
): Promise<ChangeRequestView[]> {
  const { results: rows } = await (isOrganizer
    ? env.DB.prepare(`SELECT * FROM event_change_requests WHERE event_id = ? ORDER BY created_at DESC LIMIT ?`).bind(
        event.id,
        CHANGE_REQUEST_LIST_LIMIT,
      )
    : // Own requests, any kind/status, plus -- the one exception to "own
      // requests only" -- every other invitee's *open* time_change request,
      // since voting on it requires seeing it. Once decided it reverts to
      // invisible for anyone but its own requester, same as an add_invitee
      // request always is.
      env.DB.prepare(
        `SELECT * FROM event_change_requests
         WHERE event_id = ? AND (requester_id = ? OR (kind = 'time_change' AND status = 'pending'))
         ORDER BY created_at DESC LIMIT ?`,
      ).bind(event.id, viewerId, CHANGE_REQUEST_LIST_LIMIT)
  ).all<ChangeRequestRow>();

  if (rows.length === 0) return [];

  const requesterIds = rows.map((r) => r.requester_id);
  const targetIds = rows.map((r) => r.target_user_id).filter((id): id is string => id != null);
  const users = await loadUsersById(env, [...requesterIds, ...targetIds]);

  const timeChangeIds = rows.filter((r) => r.kind === 'time_change').map((r) => r.id);
  const [tallies, myVotes] = await Promise.all([
    getVoteTalliesFor(env, timeChangeIds),
    getMyVotesFor(env, timeChangeIds, viewerId),
  ]);

  // Walkthrough 3.22 (10 Nov 2026): a pending request for a date the organizer
  // has since cancelled offered a plain Accept, and the page gave no sign the
  // date was gone until Accept was refused (P24-01). One read, and only for a
  // series with open time changes.
  const pendingDates = [
    ...new Set(rows.filter((r) => r.kind === 'time_change' && r.status === 'pending').map((r) => r.occurrence_date)),
  ].filter((d) => d !== '');
  const cancelledDates = new Set<string>();
  if (event.is_recurring && pendingDates.length > 0) {
    const { results: cancelled } = await env.DB.prepare(
      `SELECT occurrence_date FROM event_occurrence_overrides
       WHERE event_id = ? AND is_cancelled = 1 AND occurrence_date IN (${pendingDates.map(() => '?').join(', ')})`,
    )
      .bind(event.id, ...pendingDates)
      .all<{ occurrence_date: string }>();
    for (const row of cancelled) cancelledDates.add(row.occurrence_date);
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    requesterId: r.requester_id,
    requesterUsername: users.get(r.requester_id)?.username ?? '',
    requesterGlobalName: users.get(r.requester_id)?.global_name ?? null,
    proposedStartAt: r.proposed_start_at,
    proposedEndAt: r.proposed_end_at,
    occurrenceDate: r.occurrence_date,
    targetUserId: r.target_user_id,
    targetUsername: r.target_user_id ? (users.get(r.target_user_id)?.username ?? null) : null,
    targetGlobalName: r.target_user_id ? (users.get(r.target_user_id)?.global_name ?? null) : null,
    message: r.message,
    status: r.status,
    decisionNote: r.decision_note,
    eventRevision: r.event_revision,
    voteThresholdCount: r.vote_threshold_count,
    voteDeadlineAt: r.vote_deadline_at,
    tally: r.kind === 'time_change' ? (tallies.get(r.id) ?? { yes: 0, no: 0, maybe: 0 }) : null,
    myVote: r.kind === 'time_change' ? (myVotes.get(r.id) ?? null) : null,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    stale: r.kind === 'time_change' && !event.is_recurring && (event.revision ?? 0) !== r.event_revision,
    dateCancelled: r.kind === 'time_change' && r.status === 'pending' && cancelledDates.has(r.occurrence_date),
  }));
}

// Structural, so this module doesn't depend on the cron's budget type -- same
// pattern as lib/polls.ts's WorkBudget.
export interface WorkBudget {
  trySpend(queries: number): boolean;
}

// Pass-13 review (P13-05). Priced per branch rather than as one flat number,
// because the branches differ by a factor of five and the flat number was the
// cheap one.
//
// The old constant was 3. What an accepted, date-moving one-off actually
// costs: the tally, the event lookup, the acceptance claim P12-18 added, and
// updateEvent's own batch -- the event row, its attendance rows and its
// recurrence rule, three statements. Six, charged as three. Six such requests
// in one tick measured 65 real D1 statements against Cloudflare's documented
// Free-plan ceiling of 50, with the ledger reporting itself comfortably
// inside. P12-18's claim made an existing undercount worse by exactly one.
//
// Discovery is what every request pays before its branch is known.
const DISCOVERY_COST_PER_REQUEST = 2;

// Claim, updateEvent's three-statement batch, the compensating release, and
// (Pass-15 review, P15-08) the applied_at stamp.
// The release is reserved up front deliberately (P13-11): it is the statement
// that undoes a claim whose apply failed, and a release that cannot be paid
// for is how a request ends up permanently 'accepted' over an event that
// never moved.
//
// The sixth query is the stamp, and it is priced rather than absorbed: this
// pass's own P15-06 declined to add a query to this path for exactly this
// reason, and the difference is that the stamp is what makes the failure this
// number exists to prevent RECOVERABLE rather than merely less likely. Six
// healthy decisions reserve 48 against the Free plan's 50, which is the
// tightest this tick has ever been -- if it needs to grow again, the per-tick
// cap comes down first.
const ACCEPT_COST_PER_REQUEST = 6;



// The decline path is a single compare-and-set.
const DECLINE_COST_PER_REQUEST = 1;
const MAX_CHANGE_REQUESTS_RESOLVED_PER_INVOCATION = 25;
const CHANGE_REQUEST_RESOLUTION_DEAD_LETTER_AFTER = 3;

// Called from the cron sweep for time_change requests whose vote deadline has
// passed. Mirrors resolvePastDeadlinePolls in lib/polls.ts: ordered by
// failure count first so one persistently-failing row can't hold a place in
// the page ahead of healthy ones, bounded per invocation, per-row try/catch.
export async function resolvePastDeadlineChangeRequests(env: Env, budget?: WorkBudget): Promise<string[]> {
  const now = Date.now();
  // Pass-16 review (P16-01): this selects pending rows and ONLY pending rows.
  //
  // Pass 15 added a second disjunct for accepted rows with no `applied_at` and
  // re-ran their effects. That was wrong, and the way it was wrong belongs in
  // front of whoever reads this next: replaying an effect is not idempotent
  // against a world that has since changed its mind. An `add_invitee`
  // acceptance replayed after the organizer removed that person re-admitted
  // them -- to an event whose title and description had been edited in the
  // meantime, so it handed back access the organizer had deliberately revoked.
  // A recurring `time_change` replayed after the organizer cancelled that
  // occurrence set `is_cancelled` back to 0.
  //
  // "Re-applying an identical change is a no-op" was true and beside the
  // point. The test written for it proved idempotence against an UNCHANGED
  // world, and that was read as safety.
  const { results: requests } = await env.DB.prepare(
    `SELECT * FROM event_change_requests
     WHERE status = 'pending' AND kind = 'time_change' AND vote_deadline_at <= ?
     ORDER BY vote_resolution_failures, vote_deadline_at, id
     LIMIT ?`,
  )
    .bind(now, MAX_CHANGE_REQUESTS_RESOLVED_PER_INVOCATION)
    .all<ChangeRequestRow>();

  const resolvedIds: string[] = [];
  for (const request of requests) {
    if (budget && !budget.trySpend(DISCOVERY_COST_PER_REQUEST)) break;
    try {
      const tally = await getVoteTally(env, request.id);
      let accepted = tally.yes > tally.no;

      if (accepted) {
        const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(request.event_id).first<EventRow>();
        if (event) {
          // Reserved in full before the claim, never part-way through it. A
          // tick that cannot afford the whole acceptance leaves the request
          // pending for the next one, which is a state the resolver already
          // handles -- unlike a claim it could not finish (P13-11).
          if (budget && !budget.trySpend(ACCEPT_COST_PER_REQUEST)) break;
          try {
            await applyAndAccept(env, event, request, null);
          } catch (err) {
            if (!(err instanceof ConflictError)) throw err;
            // The event moved since this was filed -- the proposed time no
            // longer applies. Decline rather than retry forever.
            accepted = false;
          }
        } else {
          accepted = false;
        }
      }

      if (!accepted) {
        if (budget && !budget.trySpend(DECLINE_COST_PER_REQUEST)) break;
        await env.DB.prepare(
          `UPDATE event_change_requests SET status = 'declined', decided_at = ? WHERE id = ? AND status = 'pending'`,
        )
          .bind(now, request.id)
          .run();
      }
      resolvedIds.push(request.id);
    } catch (err) {
      console.error(`resolvePastDeadlineChangeRequests failed for request ${request.id}:`, err);
      try {
        const failures = (request.vote_resolution_failures ?? 0) + 1;
        await env.DB.prepare(
          `UPDATE event_change_requests SET vote_resolution_failures = vote_resolution_failures + 1 WHERE id = ?`,
        )
          .bind(request.id)
          .run();
        if (failures === CHANGE_REQUEST_RESOLUTION_DEAD_LETTER_AFTER) {
          console.error(
            `Change request ${request.id} has failed to resolve ${failures} times and is now deprioritised behind healthy ones. ` +
              `Investigate: SELECT * FROM event_change_requests WHERE vote_resolution_failures >= ${CHANGE_REQUEST_RESOLUTION_DEAD_LETTER_AFTER};`,
          );
        }
      } catch (countErr) {
        console.error(`Could not record resolution failure for change request ${request.id}:`, countErr);
      }
    }
  }
  return resolvedIds;
}
