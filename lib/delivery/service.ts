import { browser, type Browser } from 'wxt/browser';
import { EXTENSION_PAGE, STORAGE_ACCESS } from '../constants/browser';
import { DESTINATION_ISSUE } from '../constants/destination';
import {
  DELIVERY_FAILURE, DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_RETRY_ALARM, DELIVERY_SCHEDULE_KEY, DELIVERY_STATE,
  DELIVERY_TEXT, DELIVERY_THROTTLE_KEY, DISCARDED_DELIVERY_KEY,
} from '../constants/delivery';
import { PROGRESS_KEY } from '../constants/progress';
import { AUTH_ISSUE } from '../constants/github';
import { attemptListSchema, hashSource, readAttempts, type Attempt } from '../progress';
import { AuthFault } from '../github/schemas';
import type { GithubService } from '../github/service';
import { DestinationFault, sameDestination, type DestinationTarget } from '../destination/schemas';
import type { DestinationService } from '../destination/service';
import { githubResponseStatus, GithubWriteRejected } from '../github/errors';
import { publishAttempt, reconcileAttempt } from './api';
import { classifyDeliveryFailure, nextDeliveryAttempt, rateLimitNotBefore, resumeAfterReservation } from './retry';
import {
  acceptedSnapshotSchema, DeliveryBlocked, DeliveryFault, deliveryJobsSchema, deliveryRequestSchema,
  deliveryThrottleSchema, discardedDeliveryIdsSchema, parseDelivery, scheduleHealthSchema, type DeliveryJob,
  type DeliveryReply, type PublicationCandidate, type PublishRequest, type ScheduleHealth,
} from './schemas';

interface DeliveryAttempt {
  expectedConnectionId: string;
  expectedSelectionId: string;
  reconcile: boolean;
  automatic: boolean;
  reservation?: string;
}

export function createDeliveryService(
  github: GithubService, destination: DestinationService,
  discardCapture: (id: string, persist: (remaining: Attempt[]) => Promise<void>) => Promise<void>,
) {
  const ready = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });
  let intakeQueue: Promise<unknown> = ready;
  let publicationQueue: Promise<unknown> = ready;
  let storageQueue: Promise<unknown> = ready;
  let scheduleQueue: Promise<unknown> = ready;
  const active = new Set<string>();
  const discarding = new Set<string>();
  const queued = new Map<string, number>();
  const floors = new Map<string, number>();
  let unscheduled: ScheduleHealth | null = null;

  function busy(jobId: string): boolean {
    return active.has(jobId) || discarding.has(jobId) || queued.has(jobId);
  }
  function hold(jobId: string): void {
    queued.set(jobId, (queued.get(jobId) ?? 0) + 1);
  }
  function release(jobId: string): void {
    const remaining = (queued.get(jobId) ?? 1) - 1;
    if (remaining > 0) queued.set(jobId, remaining);
    else queued.delete(jobId);
  }
  async function discardedIds(): Promise<string[]> {
    const stored: unknown = (await browser.storage.local.get(DISCARDED_DELIVERY_KEY))[DISCARDED_DELIVERY_KEY];
    return parseDelivery(stored === undefined ? [] : stored, discardedDeliveryIdsSchema, DELIVERY_TEXT.invalidData);
  }
  async function storedJobs(): Promise<DeliveryJob[]> {
    await ready;
    const value: unknown = (await browser.storage.local.get(DELIVERY_KEY))[DELIVERY_KEY];
    return value === undefined ? [] : parseDelivery(value, deliveryJobsSchema, DELIVERY_TEXT.invalidData);
  }
  function interrupted(job: DeliveryJob): boolean {
    return (job.state === DELIVERY_STATE.publishing || job.state === DELIVERY_STATE.reconciling) && !active.has(job.id);
  }
  async function jobs(): Promise<DeliveryJob[]> {
    return (await storedJobs()).map(job => interrupted(job)
      ? { ...job, state: DELIVERY_STATE.uncertain, detail: DELIVERY_TEXT.interrupted } : job);
  }
  function save(job: DeliveryJob): Promise<void> {
    const operation = storageQueue.then(async () => {
      if ((await discardedIds()).includes(job.id)) throw new DeliveryFault(DELIVERY_TEXT.discarded);
      const current = await storedJobs();
      const index = current.findIndex(item => item.id === job.id);
      if (index < 0) current.push(job);
      else current[index] = job;
      await browser.storage.local.set({
        [DELIVERY_KEY]: parseDelivery(current, deliveryJobsSchema, DELIVERY_TEXT.invalidData),
      });
    });
    storageQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function unchanged(stored: DeliveryJob, before: DeliveryJob): boolean {
    return stored.state === before.state && stored.receipt === null
      && (stored.retry?.attempts ?? null) === (before.retry?.attempts ?? null)
      && (stored.retry?.nextAttemptAt ?? null) === (before.retry?.nextAttemptAt ?? null)
      && (stored.retry?.reservedAt ?? null) === (before.retry?.reservedAt ?? null);
  }
  function authority(target: DestinationTarget): string {
    return `${target.clientId} ${target.userId}`;
  }
  async function throttles(): Promise<Record<string, string>> {
    await ready;
    const stored: unknown = (await browser.storage.local.get(DELIVERY_THROTTLE_KEY))[DELIVERY_THROTTLE_KEY];
    return parseDelivery(stored === undefined ? {} : stored, deliveryThrottleSchema, DELIVERY_TEXT.invalidData);
  }
  function throttleUntil(current: Record<string, string>, target: DestinationTarget): number {
    const key = authority(target);
    const stored = current[key];
    return Math.max(stored ? Date.parse(stored) : 0, floors.get(key) ?? 0);
  }
  function holdAuthority(target: DestinationTarget, notBefore: number): void {
    const key = authority(target);
    floors.set(key, Math.max(floors.get(key) ?? 0, notBefore));
  }
  function extendedThrottles(current: Record<string, string>, target: DestinationTarget, notBefore: number) {
    const now = Date.now();
    const key = authority(target);
    if (Date.parse(current[key] ?? '') >= notBefore) return null;
    const retained = Object.fromEntries(Object.entries(current)
      .filter(([entry, at]) => entry !== key && Date.parse(at) > now));
    return parseDelivery(
      { ...retained, [key]: new Date(notBefore).toISOString() }, deliveryThrottleSchema, DELIVERY_TEXT.invalidData,
    );
  }
  function saveOutcome(job: DeliveryJob, notBefore: number | null): Promise<void> {
    const operation = storageQueue.then(async () => {
      if ((await discardedIds()).includes(job.id)) throw new DeliveryFault(DELIVERY_TEXT.discarded);
      const current = await storedJobs();
      const index = current.findIndex(item => item.id === job.id);
      if (index < 0) current.push(job);
      else current[index] = job;
      const extended = notBefore === null ? null : extendedThrottles(await throttles(), job.target, notBefore);
      await browser.storage.local.set({
        [DELIVERY_KEY]: parseDelivery(current, deliveryJobsSchema, DELIVERY_TEXT.invalidData),
        ...(extended === null ? {} : { [DELIVERY_THROTTLE_KEY]: extended }),
      });
    });
    storageQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function reschedule(before: DeliveryJob, after: DeliveryJob): Promise<boolean> {
    const operation = storageQueue.then(async () => {
      if ((await discardedIds()).includes(before.id)) return false;
      const current = await storedJobs();
      const index = current.findIndex(item => item.id === before.id);
      const stored = current[index];
      if (!stored || !unchanged(stored, before)) return false;
      current[index] = after;
      await browser.storage.local.set({
        [DELIVERY_KEY]: parseDelivery(current, deliveryJobsSchema, DELIVERY_TEXT.invalidData),
      });
      return true;
    });
    storageQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async function assign(attemptId: string, confirmation?: PublishRequest): Promise<DeliveryJob | null> {
    if (discarding.has(attemptId) || (await discardedIds()).includes(attemptId)) {
      throw new DeliveryFault(DELIVERY_TEXT.discarded);
    }
    if ((await storedJobs()).some(job => job.id === attemptId)) return null;
    const snapshot = parseDelivery(
      (await readAttempts()).find(attempt => attempt.id === attemptId), acceptedSnapshotSchema, DELIVERY_TEXT.invalidAttempt,
    );
    if (await hashSource(snapshot.source) !== snapshot.sourceHash) throw new DeliveryFault(DELIVERY_TEXT.invalidAttempt);
    try {
      return await github.withConnection(async (session, guard) => {
        const target = await destination.selection(session);
        if (confirmation) {
          if (confirmation.expectedConnectionId !== target.connectionId
            || confirmation.expectedSelectionId !== target.operationId) {
            throw new DeliveryFault(DELIVERY_TEXT.sessionChanged);
          }
        } else if (Date.parse(target.selectedAt) > Date.parse(snapshot.submittedAt)) {
          return null;
        }
        const job: DeliveryJob = {
          schemaVersion: 1, id: snapshot.id, snapshot, target, createdAt: new Date().toISOString(),
          state: DELIVERY_STATE.pending, detail: null, receipt: null, candidate: null,
        };
        await guard();
        await save(job);
        return job;
      });
    } catch (error) {
      if (!confirmation && ((error instanceof AuthFault && error.issue === AUTH_ISSUE.notConnected)
        || (error instanceof DestinationFault && error.issue === DESTINATION_ISSUE.selectionRequired))) return null;
      throw error;
    }
  }
  async function publish(job: DeliveryJob, attempt?: DeliveryAttempt): Promise<void> {
    if (job.state === DELIVERY_STATE.saved) return;
    const discarded = await discardedIds();
    if (discarding.has(job.id) || discarded.includes(job.id)) {
      throw new DeliveryFault(DELIVERY_TEXT.discarded);
    }
    const notBefore = throttleUntil(await throttles(), job.target);
    if (notBefore > Date.now()) {
      const at = new Date(notBefore).toISOString();
      if (attempt && !attempt.automatic) throw new DeliveryFault(DELIVERY_TEXT.cooldown(at));
      job.retry = {
        attempts: attempt?.automatic ? Math.max((job.retry?.attempts ?? 1) - 1, 0) : job.retry?.attempts ?? 0,
        nextAttemptAt: at, failure: DELIVERY_FAILURE.rateLimited, reservedAt: null,
      };
      await save(job);
      return;
    }
    const wasUncertain = job.state === DELIVERY_STATE.uncertain;
    active.add(job.id);
    let publicationStarted = false;
    let selected: DestinationTarget | null = null;
    try {
      await github.withConnection(async (session, sessionGuard, signal) => {
        const current = attempt ? await destination.selection(session) : job.target;
        if (attempt && (attempt.expectedConnectionId !== current.connectionId
          || attempt.expectedSelectionId !== current.operationId || !sameDestination(current, job.target))) {
          throw new DeliveryBlocked(DELIVERY_TEXT.sessionChanged);
        }
        selected = current;
        async function guard() {
          await sessionGuard();
          await destination.guardSelection(session, current);
        }
        if (await hashSource(job.snapshot.source) !== job.snapshot.sourceHash) {
          throw new DeliveryBlocked(DELIVERY_TEXT.invalidAttempt);
        }
        const hooks = {
          async beforeWrite() {
            job.state = DELIVERY_STATE.publishing;
            job.detail = null;
            await save(job);
            publicationStarted = true;
          },
          async prepared(candidate: PublicationCandidate) {
            job.candidate = candidate;
            await save(job);
          },
        };
        job.detail = null;
        if (attempt?.reconcile) {
          job.state = DELIVERY_STATE.reconciling;
          await guard();
          await save(job);
          job.receipt = await reconcileAttempt(job, session, guard, signal, hooks);
        } else {
          job.receipt = await publishAttempt(job, session, guard, signal, hooks);
        }
        job.state = DELIVERY_STATE.saved;
        job.retry = null;
        await save(job);
      });
    } catch (error) {
      const rejected = error instanceof GithubWriteRejected;
      const headChanged = error instanceof DeliveryFault && error.message === DELIVERY_TEXT.headChanged;
      const uncertain = !(error instanceof DeliveryBlocked) && !headChanged
        && (wasUncertain || (publicationStarted && !rejected));
      const now = Date.now();
      const spent = attempt?.automatic ? job.retry?.attempts ?? 0 : 0;
      const failure = classifyDeliveryFailure(error, now);
      const deadline = rateLimitNotBefore(error, now);
      const unsupported = failure === DELIVERY_FAILURE.unsupportedDelay;
      job.receipt = null;
      job.state = uncertain ? DELIVERY_STATE.uncertain : DELIVERY_STATE.blocked;
      job.detail = uncertain ? attempt?.reconcile && !publicationStarted ? DELIVERY_TEXT.reconciliationFailed : DELIVERY_TEXT.uncertain
        : unsupported ? deadline === null
          ? DELIVERY_TEXT.unreadableDelay : DELIVERY_TEXT.unsupportedDelay(new Date(deadline).toISOString())
          : rejected ? DELIVERY_TEXT.rejected
            : error instanceof DeliveryFault || error instanceof DestinationFault ? error.message
              : githubResponseStatus(error) !== null ? DELIVERY_TEXT.requestFailed
                : error instanceof AuthFault ? DELIVERY_TEXT.sessionChanged : DELIVERY_TEXT.networkError;
      job.retry = nextDeliveryAttempt(failure, spent, error, now);
      if (deadline !== null) holdAuthority(job.target, deadline);
      try {
        await saveOutcome(job, deadline);
      } catch (unrecorded) {
        await markUnscheduled(deadline === null ? DELIVERY_TEXT.scheduleUnavailable : DELIVERY_TEXT.outcomeUnrecorded);
        throw unrecorded;
      }
      if (selected) await destination.pauseAfterFailure(selected, error);
    } finally {
      active.delete(job.id);
    }
  }
  function intake(attemptId: string, confirmation?: PublishRequest): Promise<DeliveryJob | null> {
    const operation = intakeQueue.then(() => assign(attemptId, confirmation));
    intakeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function enqueue(jobId: string, attempt?: DeliveryAttempt): Promise<void> {
    hold(jobId);
    const operation = publicationQueue.then(async () => {
      const job = (await jobs()).find(item => item.id === jobId);
      if (!job && (await discardedIds()).includes(jobId)) return;
      if (!job) throw new DeliveryFault(DELIVERY_TEXT.invalidInput);
      if (attempt?.automatic && job.retry?.reservedAt !== attempt.reservation) return;
      await publish(job, attempt);
    });
    const settled = operation.then(() => undefined, () => {
      console.error(DELIVERY_TEXT.operationFailed);
    }).then(() => { release(jobId); });
    publicationQueue = settled;
    void settled.then(() => schedule());
    return operation;
  }
  async function accepted(attemptId: string): Promise<string | null> {
    try {
      const job = await intake(attemptId);
      if (job) void enqueue(job.id);
      return null;
    } catch {
      console.error(DELIVERY_TEXT.operationFailed);
      return DELIVERY_TEXT.intakeFailed;
    }
  }
  async function selectedTarget(): Promise<DestinationTarget | null> {
    try {
      return await github.withConnection(async (session, guard) => {
        const current = await destination.selection(session);
        await guard();
        return current;
      });
    } catch (error) {
      if ((error instanceof AuthFault && error.issue === AUTH_ISSUE.notConnected)
        || (error instanceof DestinationFault && error.issue === DESTINATION_ISSUE.selectionRequired)) return null;
      throw error;
    }
  }
  async function adopt(job: DeliveryJob, now: number): Promise<DeliveryJob | null> {
    const abandoned = job.retry?.reservedAt != null;
    if (!abandoned && !(job.state === DELIVERY_STATE.pending || interrupted(job))) return job;
    if (!abandoned && job.retry?.nextAttemptAt) return job;
    const adopted: DeliveryJob = {
      ...job,
      ...(interrupted(job) ? { state: DELIVERY_STATE.uncertain, detail: DELIVERY_TEXT.interrupted } : {}),
      retry: job.retry && abandoned
        ? resumeAfterReservation(job.retry, now)
        : nextDeliveryAttempt(DELIVERY_FAILURE.transient, job.retry?.attempts ?? 0, null, now),
    };
    return await reschedule(job, adopted) ? adopted : null;
  }
  async function start(job: DeliveryJob, target: DestinationTarget): Promise<void> {
    const reservation = new Date().toISOString();
    const started: DeliveryJob = {
      ...job,
      retry: {
        attempts: (job.retry?.attempts ?? 0) + 1, nextAttemptAt: null,
        failure: job.retry?.failure ?? DELIVERY_FAILURE.transient, reservedAt: reservation,
      },
    };
    if (!await reschedule(job, started)) return;
    await enqueue(job.id, {
      expectedConnectionId: target.connectionId, expectedSelectionId: target.operationId,
      reconcile: job.state !== DELIVERY_STATE.pending, automatic: true, reservation,
    });
  }
  function attemptTime(job: DeliveryJob, waits: Record<string, string>): number | null {
    const at = job.state === DELIVERY_STATE.saved ? null : job.retry?.nextAttemptAt;
    return at === null || at === undefined ? null : Math.max(Date.parse(at), throttleUntil(waits, job.target));
  }
  function persistFloors(): Promise<Record<string, string>> {
    const operation = storageQueue.then(async () => {
      const now = Date.now();
      const current = await throttles();
      let repaired = current;
      for (const [key, at] of floors) {
        if (at <= now) floors.delete(key);
        else if (!(Date.parse(current[key] ?? '') >= at)) repaired = { ...repaired, [key]: new Date(at).toISOString() };
      }
      if (repaired === current) return current;
      const stored = parseDelivery(repaired, deliveryThrottleSchema, DELIVERY_TEXT.invalidData);
      await browser.storage.local.set({ [DELIVERY_THROTTLE_KEY]: stored });
      return stored;
    });
    storageQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async function sweep(): Promise<void> {
    const now = Date.now();
    const waits = await persistFloors();
    const due: DeliveryJob[] = [];
    for (const stored of await storedJobs()) {
      if (stored.state === DELIVERY_STATE.saved || busy(stored.id)) continue;
      const job = await adopt(stored, now);
      const when = job ? attemptTime(job, waits) : null;
      if (job && when !== null && when <= now) due.push(job);
    }
    const target = due.length > 0 ? await selectedTarget() : null;
    if (target) {
      for (const job of due) {
        if (busy(job.id) || !sameDestination(target, job.target)) continue;
        await start(job, target);
      }
    }
    const settled = due.length > 0 ? await throttles() : waits;
    let earliest: number | null = null;
    for (const job of await storedJobs()) {
      const when = busy(job.id) ? null : attemptTime(job, settled);
      if (when === null || when <= now) continue;
      earliest = earliest === null ? when : Math.min(earliest, when);
    }
    if (earliest === null) await browser.alarms.clear(DELIVERY_RETRY_ALARM);
    else await browser.alarms.create(DELIVERY_RETRY_ALARM, { when: earliest });
  }
  async function storeHealth(health: ScheduleHealth | null): Promise<void> {
    const current = await scheduleHealth();
    if ((current?.detail ?? null) === (health?.detail ?? null)) return;
    if (health) {
      await browser.storage.local.set({
        [DELIVERY_SCHEDULE_KEY]: parseDelivery(health, scheduleHealthSchema, DELIVERY_TEXT.invalidData),
      });
    } else await browser.storage.local.remove(DELIVERY_SCHEDULE_KEY);
  }
  async function scheduleHealth(): Promise<ScheduleHealth | null> {
    await ready;
    const stored: unknown = (await browser.storage.local.get(DELIVERY_SCHEDULE_KEY))[DELIVERY_SCHEDULE_KEY];
    if (stored === undefined) return null;
    const parsed = scheduleHealthSchema.safeParse(stored);
    return parsed.success ? parsed.data : { schemaVersion: 1, failedAt: new Date().toISOString(), detail: DELIVERY_TEXT.invalidData };
  }
  async function markUnscheduled(detail: string): Promise<void> {
    console.error(DELIVERY_TEXT.scheduleFailed);
    unscheduled = { schemaVersion: 1, failedAt: new Date().toISOString(), detail };
    await storeHealth(unscheduled).catch(() => console.error(DELIVERY_TEXT.scheduleFailed));
  }
  function schedule(): Promise<void> {
    const operation = scheduleQueue.then(async () => {
      await sweep();
      unscheduled = null;
      await storeHealth(null);
    });
    scheduleQueue = operation.then(() => undefined, () => undefined);
    return operation.catch(() => markUnscheduled(DELIVERY_TEXT.scheduleUnavailable));
  }
  function resume(): void {
    void schedule();
  }
  function alarm(name: string): void {
    if (name === DELIVERY_RETRY_ALARM) resume();
  }
  async function view(): Promise<DeliveryReply> {
    let health: ScheduleHealth | null = unscheduled;
    try {
      health ??= await scheduleHealth();
    } catch {
      health = { schemaVersion: 1, failedAt: new Date().toISOString(), detail: DELIVERY_TEXT.scheduleUnavailable };
    }
    return { ok: true, jobs: await jobs(), selection: await selectedTarget(), scheduling: health };
  }
  async function discard(jobId: string): Promise<void> {
    if (active.has(jobId) || discarding.has(jobId)) throw new DeliveryFault(DELIVERY_TEXT.discardActive);
    discarding.add(jobId);
    try {
      await discardCapture(jobId, remaining => {
        const operation = storageQueue.then(async () => {
          if (active.has(jobId)) throw new DeliveryFault(DELIVERY_TEXT.discardActive);
          const current = await storedJobs();
          const job = current.find(item => item.id === jobId);
          if (!job) throw new DeliveryFault(DELIVERY_TEXT.invalidInput);
          if (job.state === DELIVERY_STATE.saved) throw new DeliveryFault(DELIVERY_TEXT.discardSaved);
          const discarded = await discardedIds();
          await browser.storage.local.set({
            [PROGRESS_KEY]: attemptListSchema.parse(remaining),
            [DELIVERY_KEY]: deliveryJobsSchema.parse(current.filter(item => item.id !== jobId)),
            [DISCARDED_DELIVERY_KEY]: discardedDeliveryIdsSchema.parse([...discarded, jobId]),
          });
        });
        storageQueue = operation.then(() => undefined, () => undefined);
        return operation;
      });
    } finally {
      discarding.delete(jobId);
    }
  }
  async function message(value: unknown, sender: Browser.runtime.MessageSender): Promise<DeliveryReply> {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL(EXTENSION_PAGE.options)
      || sender.frameId !== 0 || !sender.documentId || sender.tab?.id === undefined) {
      return { ok: false, error: DELIVERY_TEXT.invalidInput };
    }
    const parsed = deliveryRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: DELIVERY_TEXT.invalidInput };
    try {
      const input = parsed.data;
      switch (input.type) {
        case DELIVERY_MESSAGE.list:
          return await view();
        case DELIVERY_MESSAGE.publish: {
          const job = await intake(input.attemptId, input);
          if (job) {
            await enqueue(job.id, {
              expectedConnectionId: input.expectedConnectionId, expectedSelectionId: input.expectedSelectionId,
              reconcile: false, automatic: false,
            });
          }
          return await view();
        }
        case DELIVERY_MESSAGE.retry:
          await enqueue(input.jobId, {
            expectedConnectionId: input.expectedConnectionId, expectedSelectionId: input.expectedSelectionId,
            reconcile: true, automatic: false,
          });
          return await view();
        case DELIVERY_MESSAGE.discard:
          await discard(input.jobId);
          return await view();
      }
    } catch (error) {
      return { ok: false, error: error instanceof DeliveryFault || error instanceof DestinationFault ? error.message
        : error instanceof AuthFault ? DELIVERY_TEXT.sessionChanged : DELIVERY_TEXT.operationFailed };
    }
  }
  return { accepted, message, alarm, resume };
}
