import type { AsyncDataLayer } from "../postgres/data-layer.js";
import type { ConfigKind, ConfigurationRevision, ConfigurationTarget } from "../types.js";
import {
  appendConfigurationRevision,
  createConfigurationRevision,
  getConfigurationRevision,
  listConfigurationRevisions,
} from "../async-stores/async-configuration-revision-store.js";

/**
 * Small project-bound facade for consumers that only need immutable history.
 * Exact target replacement remains owned by the persistence seam that knows
 * each configuration resource's stable-ID/delete semantics.
 */
export class ConfigurationRevisionStore {
  constructor(private readonly layer: AsyncDataLayer, private readonly ownerProjectId: string = layer.projectId ?? "") {}

  async append(input: Omit<Parameters<typeof createConfigurationRevision>[0], "projectId">): Promise<ConfigurationRevision | null> {
    const revision = createConfigurationRevision({ ...input, projectId: this.ownerProjectId });
    if (revision) await appendConfigurationRevision(this.layer.db, revision);
    return revision;
  }

  list(configKind: ConfigKind, configTarget: ConfigurationTarget, limit?: number): Promise<ConfigurationRevision[]> {
    return listConfigurationRevisions(this.layer.db, { projectId: this.ownerProjectId, configKind, configTarget, limit });
  }

  get(id: string): Promise<ConfigurationRevision | null> {
    return getConfigurationRevision(this.layer.db, this.ownerProjectId, id);
  }
}

export { GLOBAL_CONFIGURATION_OWNER_ID } from "../async-stores/async-configuration-revision-store.js";
