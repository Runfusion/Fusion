# Demo scripts

## Seed a sample board

```bash
node_modules/.bin/tsx demo/seed.ts /absolute/path/to/demo-project
```

The seeded board now includes a custom **Browser Demo Lifecycle** workflow with cards staged across:

- Todo
- In Progress
- In Review
- QA
- Publish

This makes it easy to verify browser board rendering for a simple end-to-end lifecycle walkthrough.

## Simulate live activity

```bash
node_modules/.bin/tsx demo/simulate.ts /absolute/path/to/demo-project
```

When the seeded workflow is present, the simulator advances demo cards from **In Review → QA → Publish** while keeping legacy tasks flowing through the standard board lifecycle.
