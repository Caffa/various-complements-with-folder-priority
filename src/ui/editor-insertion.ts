import { isolateHistory } from "@codemirror/commands";
import type { Editor, EditorPosition } from "obsidian";

// Canonical CM6 user event for autocompletion. Does NOT match history's joinableUserEvent
// regex (/^(input\.type|delete)($|\.)/), so it always starts a separate undo event.
// See research/codemirror6-undo-history-grouping-obsidian.md.
export const COMPLETION_USER_EVENT = "input.complete";

// Prevents the NEXT transaction (fast keystroke) from merging into the completion's undo event.
export function undoIsolationAnnotation() {
  return isolateHistory.of("full");
}

// docs: https://docs.obsidian.md/Plugins/Editor/Communicating+editor+extensions
function getCmView(
  editor: Editor,
): { dispatch(spec: { annotations?: unknown }): void } | undefined {
  return (editor as any).cm ?? undefined;
}

export function insertWithIsolatedUndoStep(
  editor: Editor,
  text: string,
  from: EditorPosition,
  to?: EditorPosition,
  origin: string = COMPLETION_USER_EVENT,
): void {
  // Obsidian's replaceRange forwards `origin` straight to the CM6 transaction's userEvent
  // (verified in Obsidian 1.13.7 bundle) -> the insert starts its own undo event.
  editor.replaceRange(text, from, to, origin);
  // Empty follow-up transaction: no undo event of its own, but resets history's merge tracking
  // so a fast following keystroke starts a new undo event instead of merging into the insert.
  const cm = getCmView(editor);
  if (cm?.dispatch) {
    cm.dispatch({ annotations: undoIsolationAnnotation() });
  }
}
