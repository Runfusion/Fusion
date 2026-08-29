import { COLUMN_LABELS, type ColumnId } from "@fusion/core";
import { useTranslation } from "react-i18next";

/**
 * Returns a translator for board column labels, backed by the `common:columns.*`
 * keys with the English `COLUMN_LABELS` as the fallback. This is the migration
 * pattern for the centralized core label constants: import the hook, call it,
 * and replace `COLUMN_LABELS[col]` with `columnLabel(col)`.
 *
 * #1403: accepts a {@link ColumnId}; workflow-defined custom columns that have
 * no legacy label or i18n key fall back to displaying the raw id.
 */
export function useColumnLabel(): (column: ColumnId) => string {
  const { t } = useTranslation("common");
  return (column: ColumnId) =>
    t(`columns.${column}`, (COLUMN_LABELS as Record<string, string>)[column] ?? column);
}
