

## FN-1426: Vite Alias for @fusion/core

The dashboard's vite.config.ts has an alias that maps @fusion/core to ../core/src/types.ts directly. When adding new exports from @fusion/core (like PROMPT_KEY_CATALOG), you must either:
1. Re-export the new export from types.ts to make it available via the alias, OR
2. Change the alias to point to ../core/src/index.ts

The alias approach was intentional (to avoid circular dependencies), so option 1 is preferred. Add the re-export at the end of types.ts:

```typescript
export { PROMPT_KEY_CATALOG } from "./prompt-overrides.js";
```

Then rebuild core: pnpm --filter @fusion/core build before running dashboard tests or build.
