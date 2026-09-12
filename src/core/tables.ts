const isRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line ?? '');

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

const isSeparator = (line: string): boolean => {
  if (!isRow(line)) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((part) => /^:?-{2,}:?$/.test(part));
};

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - text.length));

export function formatTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isRow(lines[i]) || !isSeparator(lines[i + 1] ?? '')) {
      out.push(lines[i]);
      i += 1;
      continue;
    }

    const rows: string[][] = [cells(lines[i])];
    i += 2;
    while (i < lines.length && isRow(lines[i])) {
      rows.push(cells(lines[i]));
      i += 1;
    }

    const columns = Math.max(...rows.map((row) => row.length));
    const widths: number[] = [];
    for (let column = 0; column < columns; column++) {
      widths.push(Math.max(...rows.map((row) => (row[column] ?? '').length)));
    }

    const rule = `├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`;
    rows.forEach((row, index) => {
      const body = widths.map((width, column) => ` ${pad(row[column] ?? '', width)} `).join('│');
      out.push(`│${body}│`);
      if (index === 0) out.push(rule);
    });
    out.push('');
  }

  return out.join('\n');
}
