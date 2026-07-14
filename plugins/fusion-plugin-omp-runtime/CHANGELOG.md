# @fusion-plugin-examples/omp-runtime

## 0.1.0

### Minor Changes

- Initial OMP (Oh My Pi) runtime plugin over ACP (`omp acp`).
  - Runtime id `omp`, CLI provider `omp-cli`
  - Vendored ACP client (JSON-RPC/stdio)
  - Probe via `omp --version`; optional model list via `omp models`
  - Auth prefers omp `agent` method (reuses `~/.omp`)
