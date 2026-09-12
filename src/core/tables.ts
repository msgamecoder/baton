const isRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line ?? '');

const splitCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

const isSeparator = (line: string): boolean => {
  if (!isRow(line)) return false;
  const parts = splitCells(line);
  return parts.length > 0 && parts.every((part) => /^:?-{2,}:?$/.test(part));
};

/** Markdown inline syntax adds characters the renderer hides — strip it so widths line up. */
const stripInline = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
    .trim();

const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - text.length));

export function wrapCell(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    let rest = word;
    while (rest.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/** Wrap plain text to `width` columns, line by line, so a renderer does not have to guess. */
export function wrapLines(text: string, width: number): string {
  return text
    .split('\n')
    .flatMap((line) => (line ? wrapCell(line, Math.max(8, width)) : ['']))
    .join('\n');
}

/**
 * Render markdown pipe tables as aligned box-drawing tables. Cell text wraps inside
 * its column and columns shrink to fit `maxWidth`, so rows never run off the pane.
 */
export function formatTables(text: string, maxWidth = 100): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!isRow(lines[i]) || !isSeparator(lines[i + 1] ?? '')) {
      out.push(lines[i]);
      i += 1;
      continue;
    }

    const rows: string[][] = [splitCells(lines[i]).map(stripInline)];
    i += 2;
    while (i < lines.length && isRow(lines[i])) {
      rows.push(splitCells(lines[i]).map(stripInline));
      i += 1;
    }

    let columns = Math.max(...rows.map((row) => row.length));
    while (columns > 1 && rows.every((row) => !(row[columns - 1] ?? '').trim())) columns -= 1;

    const widths: number[] = [];
    for (let column = 0; column < columns; column++) {
      widths.push(Math.max(3, ...rows.map((row) => (row[column] ?? '').length)));
    }

    // each column costs width + 3 (a space either side and a │ separator)
    const budget = Math.max(columns * 3, Math.max(20, maxWidth) - 3 * columns - 1);
    while (widths.reduce((sum, width) => sum + width, 0) > budget) {
      let widest = -1;
      for (let column = 0; column < columns; column++) {
        if (widths[column] > 3 && (widest < 0 || widths[column] > widths[widest])) widest = column;
      }
      if (widest < 0) break;
      widths[widest] -= 1;
    }

    const renderRow = (row: string[]): void => {
      const wrapped = widths.map((width, column) => wrapCell(row[column] ?? '', width));
      const height = Math.max(...wrapped.map((cell) => cell.length), 1);
      for (let line = 0; line < height; line++) {
        const body = widths.map((width, column) => ` ${pad(wrapped[column][line] ?? '', width)} `).join('│');
        out.push(`│${body}│`);
      }
    };

    renderRow(rows[0]);
    out.push(`├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`);
    for (let r = 1; r < rows.length; r++) renderRow(rows[r]);
    out.push('');
  }

  return out.join('\n');
}
