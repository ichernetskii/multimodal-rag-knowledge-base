import { tenantUrl } from '../../shared/api/client';
import { makeAutoObservable, observableShallow, runInAction } from 'mobx';
import type { Job, Turn } from '../../shared/api/contracts.generated';
import { terminal } from '../../shared/api/contracts.generated';
import { acquireStreamCapacity } from './stream-capacity';
export interface JobSnapshot {
  job: Job;
  turn?: Turn;
}
interface Starting {
  job: Job;
  controller: AbortController;
}
interface Connection extends Starting {
  stream: EventSource;
  releaseCapacity: () => void;
}
export class JobStreamStore {
  items: Job[] = [];
  documentEpoch = 0;
  disconnected: string[] = [];
  private streams = new Map<string, Connection>();
  private starting = new Map<string, Starting>();
  private pending = new Map<string, Job>();
  private rejected = new Set<string>();
  private readonly limit = typeof window !== 'undefined' && !navigator.locks ? 2 : 4;
  constructor(
    private readonly onSnapshot: (value: JobSnapshot) => void,
    private readonly onError: (error: unknown) => void,
  ) {
    makeAutoObservable<
      this,
      'streams' | 'starting' | 'pending' | 'rejected' | 'onSnapshot' | 'onError' | 'limit'
    >(
      this,
      {
        items: observableShallow,
        streams: false,
        starting: false,
        pending: false,
        rejected: false,
        onSnapshot: false,
        onError: false,
        limit: false,
      },
      { autoBind: true },
    );
  }
  replaceChat(jobs: Job[]) {
    this.items = [...this.items.filter((job) => job.kind !== 'answer'), ...jobs].slice(-128);
  }
  closeChatConnections() {
    for (const [id, job] of this.pending) if (job.kind === 'answer') this.pending.delete(id);
    for (const [id, value] of [...this.streams, ...this.starting])
      if (value.job.kind === 'answer') this.stop(id, false);
    this.fill();
  }
  upsert(job: Job) {
    const index = this.items.findIndex((value) => value.id === job.id);
    if (index < 0) {
      this.items.push(job);
      if (this.items.length > 128) {
        const old = this.items.findIndex((value) => terminal.has(value.status));
        this.items.splice(old < 0 ? 0 : old, 1);
      }
    } else if (this.items[index]!.updated <= job.updated) this.items[index] = job;
  }
  watch(job: Job) {
    const id = job.id;
    this.upsert(job);
    if (terminal.has(job.status)) {
      this.pending.delete(id);
      this.stop(id);
      return;
    }
    if (this.rejected.has(id) || this.streams.has(id) || this.starting.has(id)) return;
    if (job.kind !== 'document' && this.activeCount() >= this.limit) {
      const document = [...this.streams, ...this.starting].find(
        ([, value]) => value.job.kind === 'document',
      );
      if (document) {
        this.enqueue(document[1].job);
        this.stop(document[0], false);
      }
    }
    if (!this.canStart(job)) {
      this.enqueue(job);
      return;
    }
    this.pending.delete(id);
    const entry: Starting = { job, controller: new AbortController() };
    this.starting.set(id, entry);
    const capacity = acquireStreamCapacity(job.kind === 'document', entry.controller.signal);
    if (typeof capacity === 'function') this.connect(entry, capacity);
    else
      void capacity
        .then((release) => this.connect(entry, release))
        .catch((error) => {
          if (this.starting.get(id) === entry) this.starting.delete(id);
          if (!entry.controller.signal.aborted) this.onError(error);
          this.fill();
        });
  }
  private connect(entry: Starting, releaseCapacity: () => void) {
    const { job, controller } = entry,
      id = job.id;
    if (this.starting.get(id) !== entry || controller.signal.aborted) {
      releaseCapacity();
      return;
    }
    this.starting.delete(id);
    let stream: EventSource;
    try {
      stream = new EventSource(tenantUrl('/api/events/' + encodeURIComponent(id)));
    } catch (error) {
      releaseCapacity();
      controller.abort();
      this.onError(error);
      this.fill();
      return;
    }
    this.streams.set(id, { ...entry, stream, releaseCapacity });
    stream.addEventListener('open', () => {
      runInAction(() => {
        if (this.streams.get(id)?.stream === stream)
          this.disconnected = this.disconnected.filter((value) => value !== id);
      });
    });
    stream.addEventListener('snapshot', (event: MessageEvent<string>) => {
      if (this.streams.get(id)?.stream !== stream) return;
      try {
        const snapshot = JSON.parse(event.data) as JobSnapshot;
        runInAction(() => {
          this.upsert(snapshot.job);
          if (snapshot.job.kind === 'document') this.documentEpoch++;
        });
        this.onSnapshot(snapshot);
        if (terminal.has(snapshot.job.status)) this.stop(id);
      } catch (error) {
        this.onError(error);
      }
    });
    stream.addEventListener('error', (event) => {
      if (this.streams.get(id)?.stream !== stream) return;
      runInAction(() => {
        if (!this.disconnected.includes(id)) this.disconnected.push(id);
      });
      const data = (event as MessageEvent<string>).data;
      if (data) {
        let error: unknown;
        try {
          error = JSON.parse(data);
        } catch (cause) {
          error = cause;
        }
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['ACCESS_REVOKED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'SSE_LIMIT'].includes(
            String(error.code),
          )
        ) {
          if (this.rejected.size >= 128) this.rejected.delete(this.rejected.values().next().value!);
          this.rejected.add(id);
          this.pending.delete(id);
        }
        this.stop(id);
        this.onError(error);
      }
    });
  }
  private enqueue(job: Job) {
    if (this.pending.size >= 128 && !this.pending.has(job.id))
      this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(job.id, job);
  }
  private activeCount() {
    return this.streams.size + this.starting.size;
  }
  private canStart(job: Job) {
    return (
      this.activeCount() < this.limit &&
      (job.kind !== 'document' ||
        [...this.streams.values(), ...this.starting.values()].filter(
          (value) => value.job.kind === 'document',
        ).length <
          this.limit - 1)
    );
  }
  private fill() {
    while (this.activeCount() < this.limit) {
      const job = [...this.pending.values()]
        .sort((a, b) => Number(a.kind === 'document') - Number(b.kind === 'document'))
        .find((job) => this.canStart(job));
      if (!job) break;
      this.watch(job);
    }
  }
  private stop(id: string, fill = true) {
    this.disconnected = this.disconnected.filter((value) => value !== id);
    const connection = this.streams.get(id);
    if (connection) {
      connection.stream.close();
      connection.releaseCapacity();
      connection.controller.abort();
      this.streams.delete(id);
    }
    const starting = this.starting.get(id);
    if (starting) {
      starting.controller.abort();
      this.starting.delete(id);
    }
    if (fill) this.fill();
  }
  closeConnections() {
    this.pending.clear();
    for (const id of [...this.streams.keys(), ...this.starting.keys()]) this.stop(id, false);
    this.disconnected = [];
    this.rejected.clear();
  }
  reset() {
    this.closeConnections();
    this.items = [];
    this.documentEpoch++;
  }
}
