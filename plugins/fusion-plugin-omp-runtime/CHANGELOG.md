# @fusion-plugin-examples/omp-runtime

## 0.1.5

### Patch Changes

- @fusion/core@0.72.0
- @fusion/plugin-sdk@0.72.0

## 0.1.4

### Patch Changes

- @fusion/core@0.71.0
- @fusion/plugin-sdk@0.71.0

## 0.1.3

### Patch Changes

- @fusion/core@0.70.2
- @fusion/plugin-sdk@0.70.2

## 0.1.2

### Patch Changes

- @fusion/core@0.70.1
- @fusion/plugin-sdk@0.70.1

## 0.1.1

### Patch Changes

- Updated dependencies [be55d0a]
  - @fusion/core@0.61.0
  - @fusion/plugin-sdk@0.61.0

## 0.1.0

### Minor Changes

- Initial OMP (Oh My Pi) runtime plugin over ACP (`omp acp`).
  - Runtime id `omp`, CLI provider `omp-cli`
  - Vendored ACP client (JSON-RPC/stdio)
  - Probe via `omp --version`; optional model list via `omp models`
  - Auth prefers omp `agent` method (reuses `~/.omp`)
