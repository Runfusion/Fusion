/*
 * FNXC:PostgresBackup 2026-07-16-12:40:
 * Embedded PostgreSQL learns its credential-bearing runtime URL asynchronously,
 * while backup construction resolves synchronously. This process-local registry
 * bridges that gap without logging credentials. Leases represent individual
 * lifecycles within a physical cluster generation: a joiner's release cannot
 * clear a newer generation, and owner shutdown invalidates every lease because
 * it is the only lifecycle that actually stops the postmaster.
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
  // FNXC:PostgresBackup 2026-07-16-12:40: An owner started a new postmaster,
  // so URL reuse must create a new generation rather than retain stale leases.
  if (!generation || options.ownsProcess) {
    const id = (nextGenerationByUrl.get(url) ?? 0) + 1;
    nextGenerationByUrl.set(url, id);
    generation = { url, epoch: registryEpoch, id, leases: new Set(), latestRegistration: 0 };
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

/** Release exactly one lifecycle lease; stale generation handles are inert. */
export function releaseEmbeddedRuntimeLease(lease: EmbeddedRuntimeLease): void {
  const metadata = leaseMetadata.get(lease);
  if (!metadata) return;
  const generation = generationsByUrl.get(metadata.url);
  if (
    !generation
    || generation.epoch !== metadata.epoch
    || generation.id !== metadata.generation
  ) return;

  generation.leases.delete(lease);
  if (generation.leases.size === 0) {
    generationsByUrl.delete(metadata.url);
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
    if (generation.leases.size > 0 && (!latest || generation.latestRegistration > latest.latestRegistration)) {
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
