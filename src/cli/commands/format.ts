export interface Table {
  columns: string[];
  rows: string[][];
}

export function printTable(table: Table): void {
  const widths = table.columns.map((column, index) =>
    Math.max(column.length, ...table.rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  console.log(line(table.columns));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of table.rows) {
    console.log(line(row));
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null || timestamp <= 0) return "-";
  return new Date(timestamp).toISOString();
}
