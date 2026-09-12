/** A renderable that can report the text selected inside it. */
interface SelectableLike {
  getSelectedText?: () => string;
}

/** OpenTUI's Selection: it does not expose text itself, only the renderables it covers. */
interface SelectionLike {
  selectedRenderables?: SelectableLike[];
}

/**
 * Read the text of a renderer selection. OpenTUI attaches the selected
 * renderables to the selection; each one reports its own slice, so join them.
 */
export function selectionText(selection: unknown): string {
  const renderables = (selection as SelectionLike | null | undefined)?.selectedRenderables;
  if (!Array.isArray(renderables)) return '';
  const parts: string[] = [];
  for (const renderable of renderables) {
    try {
      const text = renderable?.getSelectedText?.();
      if (text) parts.push(text);
    } catch {
      // the renderable may have been destroyed by the time the mouse is released
    }
  }
  return parts.join('\n');
}
