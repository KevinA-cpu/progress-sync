import { browser, type Browser } from 'wxt/browser';
import { EXTENSION_PAGE, STORAGE_ACCESS } from '../constants/browser';
import { DESTINATION_ISSUE } from '../constants/destination';
import { DELIVERY_KEY, DELIVERY_MESSAGE, DELIVERY_STATE, DELIVERY_TEXT } from '../constants/delivery';
import { AUTH_ISSUE } from '../constants/github';
import { hashSource, readAttempts } from '../progress';
import { AuthFault } from '../github/schemas';
import type { GithubService } from '../github/service';
import { DestinationFault, sameDestination, type DestinationTarget } from '../destination/schemas';
import type { DestinationService } from '../destination/service';
import { githubResponseStatus, GithubWriteRejected } from '../github/errors';
import { publishAttempt, reconcileAttempt } from './api';
import {
  acceptedSnapshotSchema, DeliveryBlocked, DeliveryFault, deliveryJobsSchema, deliveryRequestSchema,
  parseDelivery, type DeliveryJob, type DeliveryReply, type PublicationCandidate, type PublishRequest, type RetryRequest,
} from './schemas';

export function createDeliveryService(github: GithubService, destination: DestinationService) {
  const ready = browser.storage.local.setAccessLevel({ accessLevel: STORAGE_ACCESS.trustedContexts });
  let intakeQueue: Promise<unknown> = ready;
  let publicationQueue: Promise<unknown> = ready;
  let storageQueue: Promise<unknown> = ready;
  const active = new Set<string>();

  async function jobs(): Promise<DeliveryJob[]> {
    await ready;
    const value: unknown = (await browser.storage.local.get(DELIVERY_KEY))[DELIVERY_KEY];
    const stored = value === undefined ? [] : parseDelivery(value, deliveryJobsSchema, DELIVERY_TEXT.invalidData);
    return stored.map(job => (job.state === DELIVERY_STATE.publishing || job.state === DELIVERY_STATE.reconciling) && !active.has(job.id)
      ? { ...job, state: DELIVERY_STATE.uncertain, detail: DELIVERY_TEXT.interrupted } : job);
  }
  function save(job: DeliveryJob): Promise<void> {
    const operation = storageQueue.then(async () => {
      const current = await jobs();
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
  async function assign(attemptId: string, confirmation?: PublishRequest): Promise<DeliveryJob | null> {
    if ((await jobs()).some(job => job.id === attemptId)) return null;
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
  async function publish(job: DeliveryJob, retry?: RetryRequest): Promise<void> {
    if (job.state === DELIVERY_STATE.saved) return;
    const wasUncertain = job.state === DELIVERY_STATE.uncertain;
    active.add(job.id);
    let publicationStarted = false;
    try {
      await github.withConnection(async (session, sessionGuard, signal) => {
        const selected = retry ? await destination.selection(session) : job.target;
        if (retry && (retry.expectedConnectionId !== selected.connectionId
          || retry.expectedSelectionId !== selected.operationId || !sameDestination(selected, job.target))) {
          throw new DeliveryBlocked(DELIVERY_TEXT.sessionChanged);
        }
        async function guard() {
          await sessionGuard();
          await destination.guardSelection(session, selected);
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
        if (retry) {
          job.state = DELIVERY_STATE.reconciling;
          await guard();
          await save(job);
          job.receipt = await reconcileAttempt(job, session, guard, signal, hooks);
        } else {
          job.receipt = await publishAttempt(job, session, guard, signal, hooks);
        }
        job.state = DELIVERY_STATE.saved;
        await save(job);
      });
    } catch (error) {
      const rejected = error instanceof GithubWriteRejected;
      const headChanged = error instanceof DeliveryFault && error.message === DELIVERY_TEXT.headChanged;
      const uncertain = !(error instanceof DeliveryBlocked) && !headChanged
        && (wasUncertain || (publicationStarted && !rejected));
      job.receipt = null;
      job.state = uncertain ? DELIVERY_STATE.uncertain : DELIVERY_STATE.blocked;
      job.detail = uncertain ? retry && !publicationStarted ? DELIVERY_TEXT.reconciliationFailed : DELIVERY_TEXT.uncertain
        : rejected ? DELIVERY_TEXT.rejected
          : error instanceof DeliveryFault || error instanceof DestinationFault ? error.message
            : githubResponseStatus(error) !== null ? DELIVERY_TEXT.requestFailed
              : error instanceof AuthFault ? DELIVERY_TEXT.sessionChanged : DELIVERY_TEXT.networkError;
      await save(job);
    } finally {
      active.delete(job.id);
    }
  }
  function intake(attemptId: string, confirmation?: PublishRequest): Promise<DeliveryJob | null> {
    const operation = intakeQueue.then(() => assign(attemptId, confirmation));
    intakeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  function enqueue(jobId: string, retry?: RetryRequest): Promise<void> {
    const operation = publicationQueue.then(async () => {
      const job = (await jobs()).find(item => item.id === jobId);
      if (!job) throw new DeliveryFault(DELIVERY_TEXT.invalidInput);
      await publish(job, retry);
    });
    publicationQueue = operation.catch(() => {
      console.error(DELIVERY_TEXT.operationFailed);
    });
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
  async function view(): Promise<DeliveryReply> {
    let target: DestinationTarget | null = null;
    try {
      target = await github.withConnection(async (session, guard) => {
        const current = await destination.selection(session);
        await guard();
        return current;
      });
    } catch (error) {
      if (!(error instanceof AuthFault && error.issue === AUTH_ISSUE.notConnected)
        && !(error instanceof DestinationFault && error.issue === DESTINATION_ISSUE.selectionRequired)) throw error;
    }
    return { ok: true, jobs: await jobs(), selection: target };
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
          if (job) await enqueue(job.id);
          return await view();
        }
        case DELIVERY_MESSAGE.retry:
          await enqueue(input.jobId, input);
          return await view();
      }
    } catch (error) {
      return { ok: false, error: error instanceof DeliveryFault || error instanceof DestinationFault ? error.message
        : error instanceof AuthFault ? DELIVERY_TEXT.sessionChanged : DELIVERY_TEXT.operationFailed };
    }
  }
  return { accepted, message };
}
