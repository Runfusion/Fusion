/*
 * FNXC:PostgresBackup 2026-07-16-12:40:
 * Embedded PostgreSQL learns its credential-bearing runtime URL asynchronously,
 * while backup construction resolves synchronously. This process-local registry
 * bridges that gap without logging credentials. Leases represent individual
 * lifecycles within a physical cluster generation: a joiner's release cannot
 * clear a newer generation, and owner shutdown waits for every live lease
 * because physical process ownership is not exclusive logical usage.
 */

/** Opaque handle for one embedded-backend lifecycle registration. */
declare const embeddedRuntimeLeaseBrand: unique symbol;
export interface EmbeddedRuntimeLease {
  readonly [embeddedRuntimeLeaseBrand]: true;
}

interface Generation {
  readonly url: string;
  readonly epoch: number;
  readonly id: number;
  readonly leases: Set<EmbeddedRuntimeLease>;
  latestRegistration: number;
  pendingOwnerStop: (() => Promise<void>) | null;
  stopCompletion: Promise<void> | null;
  stopping: boolean;
}

export class EmbeddedRuntimeStoppingError extends Error {
  constructor(
    readonly url: string,
    readonly completion: Promise<void>,
  ) {
    super("Embedded PostgreSQL runtime is stopping");
    this.name = "EmbeddedRuntimeStoppingError";
  }
}

interface LeaseMetadata {
  readonly url: string;
  readonly epoch: number;
  readonly generation: number;
  readonly ownsProcess: boolean;
}

const generationsByUrl = new Map<string, Generation>();
const nextGenerationByUrl = new Map<string, number>();
const leaseMetadata = new WeakMap<EmbeddedRuntimeLease, LeaseMetadata>();
let registrationSequence = 0;
let registryEpoch = 0;

/** Register a booted embedded lifecycle and return its release-only lease. */
export function registerEmbeddedRuntimeUrl(
  url: string,
  options: { ownsProcess: boolean },
): EmbeddedRuntimeLease {
  let generation = generationsByUrl.get(url);
  if (generation?.stopping) {
    if (!generation.stopCompletion) {
      throw new Error("Embedded PostgreSQL runtime stop completion is missing");
    }
    throw new EmbeddedRuntimeStoppingError(url, generation.stopCompletion);
  }
  // FNXC:PostgresBackup 2026-07-16-12:40: An owner started a new postmaster,
  // so URL reuse must create a new generation rather than retain stale leases.
  if (!generation || options.ownsProcess) {
    const id = (nextGenerationByUrl.get(url) ?? 0) + 1;
    nextGenerationByUrl.set(url, id);
    generation = {
      url,
      epoch: registryEpoch,
      id,
      leases: new Set(),
      latestRegistration: 0,
      pendingOwnerStop: null,
      stopCompletion: null,
      stopping: false,
    };
    generationsByUrl.set(url, generation);
  }

  const lease = {} as EmbeddedRuntimeLease;
  generation.leases.add(lease);
  generation.latestRegistration = ++registrationSequence;
  leaseMetadata.set(lease, {
    url,
    epoch: generation.epoch,
    generation: generation.id,
    ownsProcess: options.ownsProcess,
  });
  return lease;
}

/**
 * Release exactly one lifecycle lease; stale generation handles are inert.
 *
 * FNXC:PostgresResourceLifecycle 2026-07-29-16:10:
 * An embedded-process owner may close before joined consumers. Record its stop callback and run it only after the final lease releases so short-lived central/CLI cleanup cannot terminate PostgreSQL beneath another live store.
 */
export async function releaseEmbeddedRuntimeLease(
  lease: EmbeddedRuntimeLease,
  options: { stopOwner?: () => Promise<void> } = {},
): Promise<void> {
  const metadata = leaseMetadata.get(lease);
  if (!metadata) return;
  const generation = generationsByUrl.get(metadata.url);
  if (
    !generation
    || generation.epoch !== metadata.epoch
    || generation.id !== metadata.generation
  ) return;

  generation.leases.delete(lease);
  if (metadata.ownsProcess && options.stopOwner) {
    generation.pendingOwnerStop = options.stopOwner;
  }
  if (generation.leases.size === 0) {
    const stopOwner = generation.pendingOwnerStop;
    generation.pendingOwnerStop = null;
    if (stopOwner) {
      /*
      FNXC:PostgresLifecycle 2026-07-29-16:26:
      Keep the generation visible as stopping until the owner callback completes. A concurrent bootstrap must retry rather than join a postmaster that is already committed to termination.

      FNXC:PostgresLifecycle 2026-07-29-17:43:
      Publish the actual stop completion to rejected registrants. Startup waits on lifecycle completion instead of exhausting a fixed retry window while an orderly shutdown is still in progress.
      */
      generation.stopping = true;
      const stopCompletion = Promise.resolve().then(stopOwner);
      generation.stopCompletion = stopCompletion;
      try {
        await stopCompletion;
      } finally {
        if (generationsByUrl.get(metadata.url) === generation) {
          generationsByUrl.delete(metadata.url);
        }
      }
    } else {
      generationsByUrl.delete(metadata.url);
    }
  }
}

/**
 * Invalidate all leases for a cluster generation after its owner stops it.
 * A lease-aware invalidation cannot remove a newer cluster that reused the URL.
 */
export function invalidateEmbeddedRuntimeUrl(url: string, lease?: EmbeddedRuntimeLease): void {
  if (!lease) {
    generationsByUrl.delete(url);
    return;
  }
  const metadata = leaseMetadata.get(lease);
  const generation = generationsByUrl.get(url);
  if (
    metadata?.url === url
    && generation?.epoch === metadata.epoch
    && generation.id === metadata.generation
  ) {
    generationsByUrl.delete(url);
  }
}

/** Return the most recently registered URL whose generation remains live. */
export function getActiveEmbeddedRuntimeUrl(): string | undefined {
  let latest: Generation | undefined;
  for (const generation of generationsByUrl.values()) {
    if (!generation.stopping && generation.leases.size > 0 && (!latest || generation.latestRegistration > latest.latestRegistration)) {
      latest = generation;
    }
  }
  return latest?.url;
}

/** Reset process-local state for isolated tests. */
export function clearActiveEmbeddedRuntimeUrl(): void {
  generationsByUrl.clear();
  nextGenerationByUrl.clear();
  registrationSequence = 0;
  registryEpoch += 1;
}
