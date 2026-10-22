import { history, isolateHistory, undo } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { describe, expect, test } from "@jest/globals";
import {
  COMPLETION_USER_EVENT,
  undoIsolationAnnotation,
} from "./editor-insertion";

function advanceTime(now: number): number {
  return now + 100; // stay well inside the 500 ms merge window
}

function update(state: EditorState, spec: object): EditorState {
  return state.update(spec as any).state;
}

function typeAt(
  state: EditorState,
  pos: number,
  text: string,
  now: number,
): EditorState {
  return update(state, {
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.type",
    annotations: Transaction.time.of(now),
  });
}

function completeAt(
  state: EditorState,
  from: number,
  text: string,
  now: number,
  userEvent?: string,
): EditorState {
  return update(state, {
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
    userEvent,
    annotations: Transaction.time.of(now),
  });
}

function isolateStep(state: EditorState, now: number): EditorState {
  return update(state, {
    annotations: [Transaction.time.of(now), undoIsolationAnnotation()],
  });
}

function moveCursor(
  state: EditorState,
  anchor: number,
  now: number,
): EditorState {
  return update(state, {
    selection: { anchor },
    annotations: Transaction.time.of(now),
  });
}

function undoAll(state: EditorState): string[] {
  const docs: string[] = [];
  let current = state;
  for (;;) {
    let next = current;
    const ok = undo({
      state: current,
      dispatch: (tr) => {
        next = current.update(tr).state;
      },
    });
    if (!ok) {
      return docs;
    }
    current = next;
    docs.push(current.doc.toString());
  }
}

describe("editor-insertion undo isolation", () => {
  test("input.complete + isolateHistory gives the completion its own undo step and prevents the next keystroke from merging in", () => {
    let now = 1000;
    let state = EditorState.create({ doc: "", extensions: [history()] });

    state = typeAt(state, 0, "h", now);
    now = advanceTime(now);
    state = typeAt(state, 1, "e", now);
    now = advanceTime(now);
    state = typeAt(state, 2, "l", now);
    now = advanceTime(now);

    // Simulates editor.replaceRange(text, from, to, "input.complete") – Obsidian forwards origin to CM6 userEvent.
    state = completeAt(state, 3, "lo", now, COMPLETION_USER_EVENT);
    now = advanceTime(now);
    state = isolateStep(state, now);
    now = advanceTime(now);
    state = typeAt(state, 5, "!", now);

    expect(state.doc.toString()).toBe("hello!");
    expect(undoAll(state)).toEqual(["hello", "hel", ""]);
  });

  test("plain replaceRange-style insert (no userEvent, no isolate) merges with surrounding typing into one undo event", () => {
    let now = 1000;
    let state = EditorState.create({ doc: "", extensions: [history()] });

    state = typeAt(state, 0, "h", now);
    now = advanceTime(now);
    state = typeAt(state, 1, "e", now);
    now = advanceTime(now);
    state = typeAt(state, 2, "l", now);
    now = advanceTime(now);

    // Simulates editor.replaceRange(..., undefined origin) – no userEvent annotation.
    state = completeAt(state, 3, "lo", now, undefined);
    now = advanceTime(now);
    state = typeAt(state, 5, "!", now);

    expect(state.doc.toString()).toBe("hello!");
    expect(undoAll(state)).toEqual([""]);
  });

  test("a selection-only update between completion and typing still leaves the completion as its own undo step", () => {
    let now = 1000;
    let state = EditorState.create({ doc: "", extensions: [history()] });

    state = typeAt(state, 0, "h", now);
    now = advanceTime(now);
    state = typeAt(state, 1, "e", now);
    now = advanceTime(now);
    state = typeAt(state, 2, "l", now);
    now = advanceTime(now);

    // Simulates editor.replaceRange(text, from, to, "input.complete") – Obsidian forwards origin to CM6 userEvent.
    state = completeAt(state, 3, "lo", now, COMPLETION_USER_EVENT);
    now = advanceTime(now);
    state = isolateStep(state, now);
    now = advanceTime(now);
    // Simulate the setCursor caret repositioning Obsidian does after insertion.
    state = moveCursor(state, 3, now);
    now = advanceTime(now);
    state = typeAt(state, 5, "!", now);

    expect(state.doc.toString()).toBe("hello!");
    expect(undoAll(state)).toEqual(["hello", "hel", ""]);
  });

  test("undoIsolationAnnotation produces the same annotation as isolateHistory.of('full')", () => {
    expect(undoIsolationAnnotation()).toEqual(isolateHistory.of("full"));
  });
});
