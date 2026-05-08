# Even Cards Plugin

Standalone Fusion plugin for the Even Realities on-device card flow focused on glanceable board/task status.

## Reading the board

All endpoints are mounted under `/api/plugins/fusion-plugin-even-cards`.

Authentication header (required):

```http
Authorization: Bearer <apiKey>
```

| Method | Path | Query params | Response |
|---|---|---|---|
| GET | `/board/cards` | `columns` (comma-separated columns), `max` (1-20 total cards) | `{ deck, generatedAt }` |
| GET | `/board` | `columns` (optional) | `{ summary, updatedAt }` |
| GET | `/tasks/:id/cards` | none | `{ deck, generatedAt }` or `404` |

`max` is **total deck size** (summary + tasks). Example: `max=20` returns 1 summary card and up to 19 task cards.

## Card data model

```ts
type GlassesCard = {
  id: string;
  kind: "summary" | "task";
  title: string;
  lines: string[];
  badge: { label: string; tone: "triage" | "todo" | "in-progress" | "in-review" | "done" | "neutral" };
  taskId?: string;
  updatedAt: string;
};

type CardDeck = {
  cards: GlassesCard[];
  summary: {
    counts: Record<string, number>;
    updatedAt: string | null;
  };
};
```

## Display defaults

Current defaults in `src/cards/format.ts`:
- `DEFAULT_MAX_CHARS_PER_LINE = 24`
- `DEFAULT_MAX_LINES_PER_CARD = 4`
- `DEFAULT_MAX_CARDS_PER_DECK = 8`

These are provisional fallback values because FN-3737 research artifacts were unavailable in this worktree; revisit task is tracked in FN-3754.
