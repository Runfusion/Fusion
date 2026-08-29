## ReportRecord input shape

```ts
interface ReportRecord {
  id: string;
  title: string;
  cadence: "daily" | "weekly" | "monthly" | "quarterly" | "manual";
  period: { start: string; end: string };
  generatedAt: string;
  status: string;
  settings: {
    sections?: string[];
    sectionOrder?: string[];
    branding?: {
      accentColor?: string;
      logoDataUri?: string;
    };
  };
  sections: {
    summary?: string;
    system?: {
      wins?: string[];
      highlights?: string[];
      lowlights?: string[];
      proposals?: string[];
      deepDives?: string[];
    };
    perAgent?: Array<{
      agentId: string;
      agentName?: string;
      wins?: string[];
      highlights?: string[];
      lowlights?: string[];
      proposals?: string[];
      deepDives?: string[];
    }>;
    dataCoverage?: string[];
  };
  reviewPanel?: {
    overallVerdict: string;
    consensusSummary: string;
    individual: Array<{ memberName: string; verdict: string }>;
  };
}
```

## Section identifiers

- `data-section="summary"`
- `data-section="system-wins"`
- `data-section="system-highlights"`
- `data-section="system-lowlights"`
- `data-section="system-proposals"`
- `data-section="system-deep-dives"`
- `data-section="agent-card"`
- `data-section="data-coverage"`
- `data-section="review-panel"`

## Theme tokens

- `--space-xs`, `--space-sm`, `--space-md`, `--space-lg`, `--space-xl`
- `--radius-sm`, `--radius-md`, `--radius-lg`
- `--bg`, `--surface`, `--card`, `--text`, `--text-muted`, `--border`
- `--triage`, `--todo`, `--in-progress`, `--in-review`, `--done`
- `--color-success`, `--color-error`, `--color-warning`, `--color-info`
- `--report-accent`

## HTTP endpoints

- `GET /api/plugins/reports/reports/:id/export.html`
  - `200 text/html; charset=utf-8` + `Content-Disposition: attachment; filename="<slug>.html"`
  - `404` when report ID does not exist
  - `409` when report is not yet generated
- `GET /api/plugins/reports/reports/:id/preview.html`
  - `200 text/html; charset=utf-8` body-only fragment (`<article>...</article>`)
  - `404` when report ID does not exist
  - `409` when report is not yet generated

## Stability

This rendering contract is shared with downstream dashboard/share integrations (FN-3786 / FN-3787). Any breaking change to markers, token names, or endpoint contract requires coordinated updates across those tasks.
