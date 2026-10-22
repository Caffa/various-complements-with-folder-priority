# CodeMirror 6 undo-history grouping in Obsidian plugins

Research date: 2026-10-21. Verified against live sources (GitHub raw, npm registry) **and** against the actual
Obsidian app bundle installed on this machine (`/Applications/Obsidian.app`, Obsidian **1.13.7**, `obsidian.asar`
build dated 2026-08-12), plus a runnable reproduction with the real libraries.

---

## TL;DR / verdict

**The fix works, and the timing (500 ms window) is irrelevant for `input.complete`.**

1. CodeMirror's history groups a new change into the previous undo event only if the new transaction's
   `userEvent` matches `/^(input\.type|delete)($|\.)/`. `"input.complete"` does **not** match, so a transaction
   annotated `input.complete` **always starts a new undo event**, even 0 ms after the last keystroke.
2. `isolateHistory` is an **`Annotation`, not a facet** (the premise in the question is slightly off), and it goes
   in `annotations:`, **not** `effects:`. `"full"` isolates on both sides. It is *not* needed for the reported bug,
   but it *is* needed if you also want to stop the user's *next* keystroke from being absorbed into the completion event.
3. Obsidian **shares its `@codemirror/*` module instances with plugins**: its plugin loader has an explicit
   `require()` shim mapping `"@codemirror/state"` → the app's own state module, etc. So `Transaction.userEvent`
   identity matches — **provided the packages are marked `external` in your bundle**. If you bundle your own copy,
   the annotation is silently ignored and the bug remains.
4. completr does **nothing** special: it inserts with `editor.replaceRange(...)` (no `origin`/`userEvent`), and it
   accesses the view as `(editor as any).cm`. It therefore has the same undo-grouping behaviour as vanilla
   various-complements.
5. `view.dispatch({..., annotations: Transaction.userEvent.of("input.complete")})` gives a separate undo event.
   An even smaller change works too: Obsidian's `Editor.replaceRange(text, from, to, origin)` forwards `origin`
   straight to `userEvent` on the CM6 path — i.e. `editor.replaceRange(text, from, to, "input.complete")`.

---

## 1. GROUPING RULES — when does a transaction merge into the previous undo event?

Source: https://github.com/codemirror/commands/blob/main/src/history.ts
(raw: https://raw.githubusercontent.com/codemirror/commands/main/src/history.ts, retrieved 2026-10-21)

### 1a. The predicate (the whole decision, verbatim)

```ts
const joinableUserEvent = /^(input\.type|delete)($|\.)/

class HistoryState {
  ...
  addChanges(event: HistEvent, time: number, userEvent: string | undefined,
             config: Required<HistoryConfig>, tr: Transaction): HistoryState {
    let done = this.done, lastEvent = done[done.length - 1]
    if (lastEvent && lastEvent.changes && !lastEvent.changes.empty && event.changes &&
        (!userEvent || joinableUserEvent.test(userEvent)) &&
        ((!lastEvent.selectionsAfter.length &&
          time - this.prevTime < config.newGroupDelay &&
          config.joinToEvent(tr, isAdjacent(lastEvent.changes, event.changes))) ||
         // For compose (but not compose.start) events, always join with previous event
         userEvent == "input.type.compose")) {
      done = updateBranch(done, done.length - 1, config.minDepth,
                          new HistEvent(event.changes.compose(lastEvent.changes),
                                        conc(StateEffect.mapEffects(event.effects, lastEvent.changes), lastEvent.effects),
                                        lastEvent.mapped, lastEvent.startSelection, none))
    } else {
      done = updateBranch(done, done.length, config.minDepth, event)
    }
    return new HistoryState(done, none, time, userEvent)
  }
```

Read the `&&` chain in order. Four independent gates:

| Gate | Code | Meaning |
|---|---|---|
| previous event exists and has changes | `lastEvent && lastEvent.changes && !lastEvent.changes.empty` | a selection-only or empty event never absorbs changes |
| **userEvent is "joinable"** | `(!userEvent \|\| joinableUserEvent.test(userEvent))` | **this is the decisive gate for your case** |
| no selections recorded on the previous event | `!lastEvent.selectionsAfter.length` | if anything recorded a selection after the last change, no merge |
| within the group delay **and** ranges touch | `time - this.prevTime < config.newGroupDelay && config.joinToEvent(tr, isAdjacent(...))` | `isAdjacent` = the new change ranges **overlap/touch** the previous event's changed ranges |
| (escape hatch) | `\|\| userEvent == "input.type.compose"` | composition **always** joins, bypassing time + adjacency |

### 1b. The exact comparison type — regex, not string equality

- Merge gate: **regex** `joinableUserEvent.test(userEvent)` where
  `joinableUserEvent = /^(input\.type|delete)($|\.)/` — a *prefix* match anchored at both ends of the alternative,
  so `"input.type"`, `"input.type.compose"`, `"input.type.compose.start"`, `"delete"`, `"delete.backward"`,
  `"delete.cut"` all qualify, while `"input.complete"`, `"input.paste"`, `"input.drop"`, `"move.drop"` and
  `"select.pointer"` do **not**.
- Composition escape hatch: **exact string equality** `userEvent == "input.type.compose"`.
- Note the asymmetry: the gate inspects the **new** transaction's `userEvent`, never the previous event's. The
  previous `userEvent` is only remembered (`prevUserEvent`) for the *selection* path.

### 1c. Defaults

```ts
const historyConfig = Facet.define<HistoryConfig, Required<HistoryConfig>>({
  combine(configs) {
    return combineConfig(configs, {
      minDepth: 100,
      newGroupDelay: 500,
      joinToEvent: (_t, isAdjacent) => isAdjacent,
    }, { ... })
  }
})
```

- `newGroupDelay` default = **500 ms**; `minDepth` default = **100** events.
- Published docs: https://codemirror.net/docs/ref/#commands.history
  ("`newGroupDelay?: number` — The maximum time (in milliseconds) that adjacent events can be apart and still be
  grouped together. Defaults to 500.")
- Time comes from `Transaction.time`, "Annotation used to store transaction timestamps. Automatically added to
  every transaction, holding `Date.now()`"
  (https://github.com/codemirror/state/blob/main/src/transaction.ts).
- **Obsidian does not override it.** In the 1.13.7 bundle the history extension factory is called with no config
  (`function iB(e){return void 0===e&&(e={}),[nB,tB.of(e),...]}`, called as `iB()` in the main extension array),
  so 500 ms / 100 events are in force.

### 1d. `Transaction.userEvent` semantics

https://github.com/codemirror/state/blob/main/src/transaction.ts

```ts
/// Annotation used to associate a transaction with a user interface
/// event. Holds a string identifying the event, using a
/// dot-separated format to support attaching more specific information.
/// The events used by the core libraries are:
///
///  - `"input"` when content is entered
///    - `"input.type"` for typed input
///      - `"input.type.compose"` for composition
///    - `"input.paste"` for pasted input
///    - `"input.drop"` when adding content with drag-and-drop
///    - `"input.complete"` when autocompleting
...
static userEvent = Annotation.define<string>()

/// Annotation indicating whether a transaction should be added to
/// the undo history or not.
static addToHistory = Annotation.define<boolean>()
```

```ts
isUserEvent(event: string): boolean {
  let e = this.annotation(Transaction.userEvent)
  return !!(e && (e == event || e.length > event.length && e.slice(0, event.length) == event && e[event.length] == "."))
}
```
(`isUserEvent` is the *query* helper — equality or `prefix + "."`. The history merge gate does **not** use it; it
uses the regex above. Same practical result for `"input.complete"`.)

### 1e. Answer to "does `input.complete` ALWAYS form its own undo event?"

**Yes — it can never merge into a previous `input.type` event, regardless of how few milliseconds elapsed.**
The `(!userEvent || joinableUserEvent.test(userEvent))` conjunct is `false` for `"input.complete"`, which
short-circuits the entire `if`, so control always reaches `updateBranch(done, done.length, minDepth, event)`
(= push a *new* event). The 500 ms window is never even consulted.

Precise caveats (the "always" is bounded by these):

1. **`addToHistory: false`** — if the transaction is annotated `Transaction.addToHistory.of(false)` it is not added
   to history at all (it is *mapped onto* the existing events instead):
   `if (tr.annotation(Transaction.addToHistory) === false) return !tr.changes.empty ? state.addMapping(tr.changes.desc) : state`.
2. **Empty change set** — a transaction with no changes and no inverted effects produces no `HistEvent` at all
   (`if (!effects.length && tr.changes.empty) return null`), so a "completion" that inserts nothing and only moves
   the cursor creates no undo event.
3. **It only protects one side.** A *later* joinable transaction (e.g. the user types one more character 200 ms
   later, adjacent to the inserted text) **will** be merged *into* the completion event, because the gate looks at
   the new transaction's `userEvent` ("input.type" → joinable). Demonstrated in §5.
4. **IME composition still wins.** If the following transaction is exactly `"input.type.compose"`, the
   `|| userEvent == "input.type.compose"` branch joins it regardless of time/adjacency/`isolateHistory` (that
   branch does not test `prevTime`). Only relevant if a completion is accepted *during* an active IME composition.

### 1f. Upstream precedent: CodeMirror does exactly this for its own autocomplete

https://github.com/codemirror/autocomplete/blob/main/src/completion.ts

```ts
export function insertCompletionText(state: EditorState, text: string, from: number, to: number): TransactionSpec {
  ...
  return {
    ...state.changeByRange(range => { ... }),
    scrollIntoView: true,
    userEvent: "input.complete"
  }
}
```

and `applyCompletion` in https://github.com/codemirror/autocomplete/blob/main/src/state.ts dispatches it:

```ts
view.dispatch({
  ...insertCompletionText(view.state, apply, result.from, result.to),
  annotations: pickedCompletion.of(option.completion)
})
```

So `"input.complete"` is the *canonical* spelling for "this transaction is a completion insertion", and CM's own
design intent is that it forms a distinct undo step. (Marijn confirms the pairing of `userEvent: "input.complete"`
with `pickedCompletion` for `activateOnCompletion` on the forum:
https://discuss.codemirror.net/t/activateoncompletion-not-work-well/8529)

---

## 2. `isolateHistory` — annotation (not facet), and "before"/"after"/"full"

https://github.com/codemirror/commands/blob/main/src/history.ts

```ts
/// Transaction annotation that will prevent that transaction from
/// being combined with other transactions in the undo history. Given
/// `"before"`, it'll prevent merging with previous transactions. With
/// `"after"`, subsequent transactions won't be combined with this
/// one. With `"full"`, the transaction is isolated on both sides.
export const isolateHistory = Annotation.define<"before" | "after" | "full">()
```

Published reference (same wording): https://codemirror.net/docs/ref/#commands.isolateHistory — signature
`isolateHistory: AnnotationType<"before" | "after" | "full">`.

How a transaction uses it — **`annotations`, not `effects`**:

```ts
view.dispatch({
  changes: {from, to, insert: text},
  selection: {anchor: from + text.length},
  annotations: isolateHistory.of("full"),   // ✓
  // effects: isolateHistory.of("full")     // ✗ would be a different, inert annotation slot
})
```

(The `TransactionSpec` shorthand `{annotations: ...}` and `{annotations: [a, b]}` both work; `state.update()` also
accepts a bare `annotations` array. `effects` is a separate field and `isolateHistory` is *not* a `StateEffect`.)

Implementation, from `historyField_.update`:

```ts
let isolate = tr.annotation(isolateHistory)
if (isolate == "full" || isolate == "before") state = state.isolate()

if (tr.annotation(Transaction.addToHistory) === false) ...

let event = HistEvent.fromTransaction(tr)
let time = tr.annotation(Transaction.time)!, userEvent = tr.annotation(Transaction.userEvent)
if (event) state = state.addChanges(event, time, userEvent, config, tr)
else if (tr.selection) state = state.addSelection(...)

if (isolate == "full" || isolate == "after") state = state.isolate()
return state
```

```ts
isolate() {
  return this.prevTime ? new HistoryState(this.done, this.undone) : this
}
```
`HistoryState`'s constructor defaults `prevTime = 0` and `prevUserEvent = undefined`, so `isolate()` **forgets the
last-event timestamp**. `time - 0` is `Date.now()`, which is never `< 500`, hence "no merge".

Exact semantics:

- `"before"` → `state.isolate()` runs *before* `addChanges`, so this transaction cannot be appended to the previous
  event **even if its own `userEvent` is joinable** (e.g. plain typing).
- `"after"` → `state.isolate()` runs *after* the event is stored, so the *next* transaction cannot merge into it.
- `"full"` → both. Note `"full"` does **not** defeat the `userEvent == "input.type.compose"` escape hatch, since that
  branch ignores `prevTime`.
- It is a per-transaction annotation: nothing global, no extension to register.

---

## 3. OBSIDIAN MODULE SHARING — same instances, if you mark them external

### 3a. Official answer: the sample plugin marks every `@codemirror/*` package `external`

https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs

```js
external: [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  ...builtinModules,
],
```

Note the sample's `package.json` has **no** `@codemirror/*` dependency at all — it marks them external and lets
Obsidian resolve them at runtime.

### 3b. Proof that Obsidian resolves those specifiers to *its own* module instances

Extracted from the installed app (`npx @electron/asar extract
/Applications/Obsidian.app/Contents/Resources/obsidian.asar ./obsasar` → `app.js`), inside
`PluginManager.loadPlugin`. The plugin's `main.js` is evaluated with a custom `require` shim:

```js
c4 = {"obsidian": d, "@codemirror/autocomplete": l, "@codemirror/collab": h, "@codemirror/commands": a,
      "@codemirror/language": o, "@codemirror/lint": p, "@codemirror/search": s, "@codemirror/state": e,
      "@codemirror/text": e, "@codemirror/view": t, "@lezer/common": i, "@lezer/lr": c, "@lezer/highlight": r},
u4 = {"@codemirror/closebrackets": l, "@codemirror/comment": a, "@codemirror/fold": o, "@codemirror/gutter": t,
      "@codemirror/highlight": o, "@codemirror/history": a, "@codemirror/matchbrackets": o, "@codemirror/panel": t,
      "@codemirror/rangeset": e, "@codemirror/rectangular-selection": t, "@codemirror/stream-parser": o,
      "@codemirror/tooltip": t}
...
s = function(e) {
  return u4.hasOwnProperty(e)
    ? (console.error(new Error("[CM6][" + o + '] Using a deprecated package: "' + e + '".\n' + o4)), u4[e])
    : c4.hasOwnProperty(e)
      ? c4[e]
      : a ? (new Aw(o + ' attempted to load NodeJS package: "' + e + '"'), console.error(...), null) : sf(e)
}
```

`c4` maps module specifier → the *app's already-imported module object*. `require("@codemirror/state")` in a plugin
returns the very module instance Obsidian's editor uses; likewise `view`, `commands`, `language`, `autocomplete`,
`search`, `lint`, `lezer`. (`u4` is the obsolete CM 0.19 → 6.0 rename map; requiring those logs a deprecation
error but still resolves. There is no entry for `@codemirror/theme-*`, etc.)

**Consequence for annotations:** `Transaction.userEvent`, `isolateHistory`, `Transaction.time` all live in these
shared modules, so identical identity is guaranteed **only if you don't bundle your own copy**. Silent failure mode
if you do (measured, §5c): the annotation object is a different `AnnotationType`, `tr.annotation(...)` returns
`undefined`, and the merge happens as if you had passed nothing — **no error is thrown**.

Mobile caveat from the same shim: on mobile (`emulate-mobile` body class) requiring a *non*-allowlisted Node module
raises `… attempted to load NodeJS package`. `@codemirror/*` are allowlisted, so they are fine on iOS/Android.

### 3c. `(editor as any).cm` — officially documented, with a caveat about typing

https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions ("Communicating with editor extensions")

```ts
import { EditorView } from '@codemirror/view';

// @ts-expect-error, not typed
const editorView = view.editor.cm as EditorView;
```

```ts
this.addCommand({
	id: 'example-editor-command',
	name: 'Example editor command',
	editorCallback: (editor, view) => {
		// @ts-expect-error, not typed
		const editorView = view.editor.cm as EditorView;

		editorView.dispatch({
			effects: [
				// ...
			],
		});
	},
});
```

So: **documented** (the docs page exists precisely to show `editor.cm`), but **untyped** — `Editor` in
`obsidian.d.ts` has no `cm` member, hence `@ts-expect-error`. It is community-standard: completr ships
`export function editorToCodeMirrorView(editor: Editor): EditorView { return (editor as any).cm; }`
(https://github.com/tth05/obsidian-completr/blob/master/src/editor_helpers.ts), and the forum answer
(https://forum.obsidian.md/t/how-get-codemirror-in-plugin/55197) gives the same one-liner.

Obsidian *itself* uses `.cm` internally — e.g. the table editor's keymap does
`{key:"Mod-z", run:function(){return aB(t.table.editor.cm),!0}}` where `aB` is CM's `undo`. Also documented as a
state-level alternative: `editorInfoField` (a `StateField<MarkdownFileInfo>`), and
`editorViewField` is deprecated ("use editorInfoField instead")
(https://docs.obsidian.md/Reference/TypeScript+API/editorInfoField).

Since the CM5 legacy editor is gone — the 1.13.7 bundle contains no CM5 core and no `legacyEditor` flag at all (the
`getMode(` / `CodeMirror` strings in it come from CM6's own error messages and Obsidian's HTML/latex stream parsers)
— `.cm` is an `EditorView`. For defensive code, guard with `cm && cm.state` before use.

### 3d. Versions: what Obsidian ships / what to pin

The `obsidian` npm package declares the CM versions it builds its API against as **exact peer dependencies**:

| `obsidian` npm | published | `peerDependencies` |
|---|---|---|
| 1.10.3 – 1.13.1 | 2025-11-11 … 2026-06-09 | `@codemirror/view: 6.38.6`, `@codemirror/state: 6.5.0` |
| **1.14.4** (latest) | 2026-10-08 | `@codemirror/view: 6.43.13`, `@codemirror/state: 6.7.6` |

`@codemirror/view@6.38.6` was published 2025-10-13; `state@6.5.0` 2024-12-09; `view@6.43.13` and `state@6.7.6` were
both published **2026-09-22**.

Caveat on reading that table as "the bundled version": the app bundle on this machine (1.13.7) contains
`EditorView.cursorScrollMargin`, a facet introduced in `@codemirror/view` **6.41.0 (2026-04-01)** — newer than the
6.38.6 peer pin of `obsidian@1.13.1`. So peer deps are best treated as *the minimum/compile target Obsidian
guarantees*, not an exact runtime version. What can be stated with certainty:

- the bundled `@codemirror/view` in Obsidian 1.13.7 is **≥ 6.41.0**, and Obsidian's newest API package pins
  **6.43.13 / 6.7.6** as of October 2026;
- the bundled `@codemirror/commands` is **≥ 6.2.0** (it supports the `joinToEvent` config and `isolateHistory`), and
  the grouping predicate is the current one (verified byte-for-byte below).

**Practical pinning advice:** put the CM packages in `devDependencies` only, at the version the `obsidian` peer
range names, and keep them `external`:

```jsonc
"devDependencies": {
  "obsidian": "1.14.4",
  "@codemirror/state": "6.7.6",   // or 6.5.0 if minAppVersion targets Obsidian <= 1.13.x
  "@codemirror/view": "6.43.13"   // or 6.38.6
}
```
Use exact pins (not `^`), because a caret range can drag in a newer minor whose types differ from what the app
actually runs; runtime identity comes from the host anyway. `@codemirror/commands` is only needed if you use
`isolateHistory`; it has no peer pin, so any 6.x ≥ 6.2 is fine (`isolateHistory` exists since 6.0.0).

### 3e. The 500 ms rule is confirmed present in Obsidian's own bundle

Deobfuscated from `app.js` (1.13.7): same regex, same predicate, defaults untouched.

```js
var CB=/^(input\.type|delete)($|\.)/
...
e.prototype.addChanges=function(t,n,i,r,o){var a=this.done,s=a[a.length-1];
  return a = s && s.changes && !s.changes.empty && t.changes && (!i||CB.test(i)) &&
    (!s.selectionsAfter.length && n-this.prevTime<r.newGroupDelay &&
     r.joinToEvent(o, /* isAdjacent */(s.changes,t.changes)))
    ? updateBranch(...) : updateBranch(...), new EB(done, none, n, i)}
```

and the defaults are intact: `combineConfig(configs,{minDepth:100,newGroupDelay:500,joinToEvent:...})`
(minified as `newGroupDelay:500`, `newGroupDelay:Math.min`), with `history()` invoked as `iB()` — no arguments.

---

## 4. COMPLETR PRECEDENT — no undo handling at all

Repo: https://github.com/tth05/obsidian-completr (author `tth05` = Thomas Koppelaar; 396 ★, last push 2024-06-03,
v3.2.0).

**Getting the view** — https://github.com/tth05/obsidian-completr/blob/master/src/editor_helpers.ts

```ts
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function editorToCodeMirrorState(editor: Editor): EditorState {
    return (editor as any).cm.state;
}

export function editorToCodeMirrorView(editor: Editor): EditorView {
    return (editor as any).cm;
}
```

**Inserting the accepted completion** — https://github.com/tth05/obsidian-completr/blob/master/src/popup.ts

```ts
selectSuggestion(value: Suggestion, evt: MouseEvent | KeyboardEvent): void {
    const replacement = value.replacement;
    const start = typeof value !== "string" && value.overrideStart ? value.overrideStart : this.context.start;

    const endPos = value.overrideEnd ?? this.context.end;
    this.context.editor.replaceRange(replacement, start, {
        ...endPos,
        ch: Math.min(endPos.ch, this.context.editor.getLine(endPos.line).length)
    });
    ...
    this.context.editor.setCursor({ ...start, ch: start.ch + replacement.length });
    this.close();
    this.justClosed = true;
}
```

and after applying, an optional trailing space is inserted with a *second* `editor.replaceRange(" ", cursor)`.

Observations:

- Insertion goes through **Obsidian's `Editor` API** (`replaceRange` + `setCursor`), **not** a `view.dispatch`.
- **No annotation, no `userEvent`, no `isolateHistory`, no `Transaction` import** anywhere in the insertion path —
  `@codemirror/state` is imported only for the `EditorState`/`Text` types in `editor_helpers.ts`.
- **Nothing special for undo**, so a completed word merges with the preceding typing exactly like vanilla
  various-complements. (If you were hoping for a working precedent, there isn't one here.)
- Build config: all `@codemirror/*` in `external`; `"@codemirror/state": "^6.1.2"` in `devDependencies` only
  (https://github.com/tth05/obsidian-completr/blob/master/package.json,
  https://github.com/tth05/obsidian-completr/blob/master/esbuild.config.mjs).

Comparison, other plugins:

- **various-complements** (upstream of this fork, v11.4.2, 941 ★): also `editor.replaceRange(...)` +
  `editor.setCursor(...)`, no annotation — see
  https://github.com/tadashi-aikawa/obsidian-various-complements-plugin/blob/main/src/ui/AutoCompleteSuggest.ts.
  `obsidian: 1.11.4` devDependency, all `@codemirror/*` external, **no** `@codemirror/*` devDependencies.
- **editing-toolbar** (PKM-er, 1.5k ★): `devDependencies` `{"@codemirror/language":"^6.11.0",
  "@codemirror/state":"^6.5.2","@codemirror/view":"^6.36.3"}` and a rollup `external` list containing all
  `@codemirror/*` + `@lezer/*`.
- **obsidian-vimrc-support**: not a CM6 data point (still depends on `codemirror@^5`), skip it.

---

## 5. CONFIRMING THE FIX (measured, not just read)

Harness: `@codemirror/state@6.7.6`, `@codemirror/view@6.43.13`, `@codemirror/commands@6.11.1` (= the versions
pinned by `obsidian@1.14.4`), Node ESM, no DOM. Each scenario: dispatch `insert "hel"` as `input.type` with the
cursor at 3, then **immediately** (same millisecond — worst case, far inside the 500 ms window) dispatch the
completion, then run `undo()` once.

| # | completion transaction | `undoDepth` after | one undo → doc |
|---|---|---|---|
| A | no annotation at all (what `editor.replaceRange` does today) | **1** | `""` ← **the bug** |
| B | `userEvent: "input.complete"` | **2** | `"hel"` ✅ |
| C | `annotations: Transaction.userEvent.of("input.complete")` | **2** | `"hel"` ✅ |
| D | `annotations: isolateHistory.of("full")` only | **2** | `"hel"` ✅ |
| E | B + `isolateHistory.of("full")` | **2** | `"hel"` ✅ |
| F | B, then one more adjacent `input.type` 0 ms later | 2 | `"hel"` ← typing absorbed into the completion event |
| G | E, then one more adjacent `input.type` 0 ms later | **3** | `"hello"` ✅ |
| H | baseline: two adjacent `input.type` transactions | 1 | `""` (typing legitimately groups) |

### 5a. Verdict: yes, the proposed dispatch gives a separate undo event

```ts
const view = (editor as any).cm;            // EditorView
view.dispatch({
  changes: { from, to, insert: text },
  selection: { anchor: from + text.length }, // or EditorSelection.cursor(...)
  annotations: Transaction.userEvent.of("input.complete"),
  scrollIntoView: true,
});
```
Row B/C: separate event, one `Cmd+Z` restores the typed prefix, not the empty line. ✅

You can also write `userEvent: "input.complete"` directly in the `TransactionSpec` (B) — `state.update` turns it into
`Transaction.userEvent.of(...)` internally (`t.userEvent && (r = r.concat(_e.userEvent.of(t.userEvent)))`, visible in
Obsidian's bundle too). The `annotations:` form is what you need if you *also* want `isolateHistory` in the same
array.

### 5b. Even smaller change: Obsidian's `replaceRange` already forwards `origin` → `userEvent`

`obsidian.d.ts` (1.14.4) declares the 4th parameter:

```ts
/**
 * Replace the text between two positions.
 * @param replacement The replacement text.
 * @param from The start position.
 * @param to The end position. If omitted, the text is inserted at `from`.
 * @param origin The user event that triggered the replacement.
 * @public
 */
abstract replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void;
```
(`replaceSelection(replacement: string, origin?: string)` has the same `origin` parameter.) And the CM6
implementation in the 1.13.7 bundle is:

```js
t.prototype.replaceRange = function(e, t, n, i) {
  var r = this.cm, o = r.state.doc, a = AL(o, t), s = n ? AL(o, n) : a;
  r.dispatch({changes: {from: a, to: s, insert: e}, scrollIntoView: true, userEvent: i})
}
```

So **`editor.replaceRange(text, from, to, "input.complete")` is sufficient** — no `(editor as any).cm` needed, no
new dependencies. That is the lowest-risk patch for this fork. (`userEvent: undefined` when omitted ⇒ no annotation ⇒
row A = the bug.)

Downside: it cannot also carry `isolateHistory`, `pickedCompletion`, or an explicit `selection` in the same
transaction — for those you need the `view.dispatch` form (or you keep the follow-up `editor.setCursor`, which is a
selection-only transaction and creates no extra undo event: it is appended to the last event's `selectionsAfter`).

Where this fork inserts (all sites should get the event, or they'll behave inconsistently):
`src/ui/AutoCompleteSuggest.ts:1459` (main insert), `:310`, `:351` (predictable-cycle), `:1469`/`:1480` (`setCursor`
cleanup — leave as-is), `src/ui/popup-commands.ts:186`, `:277` (custom-alias insert). The fork already has
`getCmView(editor)` in `src/app-helper.ts:15`, but no `@codemirror/*` devDependencies yet (`obsidian: 1.11.4`,
externals already listed in `esbuild.config.mjs`).

### 5c. Caveats that actually matter

1. **Module identity is mandatory.** With a *bundled duplicate* of `@codemirror/state`, the annotation is silently
   dropped. Measured with two real copies (6.7.6 driving history, 6.5.0 supplying the annotation):
   ```
   same Transaction class? false | same userEvent annotation? false
   app's own Transaction.userEvent.of('input.complete')      : undoDepth=2 -> undo gives "hel"
   foreign (bundled dup) Transaction.userEvent.of('input.complete'): undoDepth=1 -> undo gives ""
   ```
   No exception, no console warning — it just doesn't work. So: keep `@codemirror/*` in esbuild `external` (this
   fork already does) and **import only for types/runtime-from-host**, never bundle.
2. **One-sided isolation.** Row F: the user's next keystroke (adjacent, < 500 ms) is absorbed *into* the completion
   event, so the *second* `Cmd+Z` jumps past both. If you care, add `isolateHistory.of("full")` (row G) — same
   transaction, `annotations: [Transaction.userEvent.of("input.complete"), isolateHistory.of("full")]`. Costs
   nothing, needs `@codemirror/commands` import.
3. **IME.** If a completion is accepted while an IME composition is active, the following
   `"input.type.compose"` transaction joins the completion event unconditionally (that branch ignores `prevTime`,
   so `isolateHistory` won't stop it). Mitigation if you care: skip the special-casing while
   `view.composing`/composing is true, or dispatch after `compositionend`. Low priority, but real for CJK input.
4. **Obsidian's undo is stock CM undo.** The main extension array pushes CM's `historyKeymap`
   (`FJ.push(sa.of(k(k(k([...],sJ,!0),MB,!0),[...])))`, `MB` = `[{key:"Mod-z",run:aB,...}]`, `aB` = CM `undo`), so
   `Cmd+Z` goes through `historyState.pop` — i.e. exactly the logic analysed here. Obsidian does not strip or
   rewrite annotations on dispatch (no `dispatchTransactions` wrapper in the bundle), so the annotation survives.
   Consequence: the grouping rules are the *only* thing deciding what `Cmd+Z` removes — there is no Obsidian-level
   undo to override.
5. **`scrollIntoView` / selection.** `view.dispatch` with an explicit `selection` is one transaction; the current
   `replaceRange` + `setCursor` pair relies on CM's selection mapping (plus the fork's "cursor doesn't move" 
   workaround comment at `AutoCompleteSuggest.ts:1478`). If you switch to `view.dispatch`, set the caret explicitly
   (`anchor: from + text.length + positionToMove`) and drop the follow-up `setCursor` to keep one atomic change.
6. **Multi-cursor / `.cm` availability.** `Editor.replaceRange` goes through `editor.cm` too, so multi-cursor
   behaviour is unchanged by either approach. Guard `const cm = (editor as any).cm; if (cm?.state) {...}` in case a
   non-CM6 editor (e.g. a future table/canvas editor) is ever handed to the code path; Obsidian's own table editor
   keymap assumes `.cm` exists, so this is defensive only.
7. **Optional extra:** add `pickedCompletion.of(completion)` (from `@codemirror/autocomplete`) if you ever want
   CM-level tooling (`activateOnCompletion`) to recognize the pick. Not needed for undo.

---

## Appendix — how this was verified

- Source of truth read directly from GitHub raw at `main` on 2026-10-21, and cross-checked against tags 6.0.0 …
  6.9.0/6.11.1 (`joinableUserEvent` regex has been present since **6.0.0**; `joinToEvent` was added in 6.2.0;
  `isolateHistory` since 6.0.0).
- Obsidian internals: `npx @electron/asar extract /Applications/Obsidian.app/Contents/Resources/obsidian.asar`,
  then string/JSON inspection of `app.js` (3.8 MB minified). Obsidian 1.13.7, `obsidian.asar` mtime 2026-08-12.
- Runtime behaviour: real `@codemirror/{state,view,commands}` at the versions pinned by `obsidian@1.14.4`, driven
  through `EditorState.create({extensions:[history()]})` + `undo({state, dispatch})` — no DOM, no mocks.
- Version data: `https://registry.npmjs.org/obsidian`, `https://registry.npmjs.org/@codemirror/{view,state,commands}`.

### Link list

- CM history source: https://github.com/codemirror/commands/blob/main/src/history.ts
- CM reference — `isolateHistory`: https://codemirror.net/docs/ref/#commands.isolateHistory
- CM reference — `history` config: https://codemirror.net/docs/ref/#commands.history
- CM reference — `Transaction.userEvent`: https://codemirror.net/docs/ref/#state.Transaction^userEvent
- CM state source: https://github.com/codemirror/state/blob/main/src/transaction.ts
- CM autocomplete source: https://github.com/codemirror/autocomplete/blob/main/src/completion.ts
- Obsidian docs — editor extensions: https://docs.obsidian.md/Plugins/Editor/Editor+extensions
- Obsidian docs — communicating with editor extensions (`editor.cm`): https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions
- Obsidian docs — `editorInfoField`: https://docs.obsidian.md/Reference/TypeScript+API/editorInfoField
- Obsidian sample plugin build config: https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs
- completr: https://github.com/tth05/obsidian-completr/blob/master/src/popup.ts · https://github.com/tth05/obsidian-completr/blob/master/src/editor_helpers.ts
- various-complements (this fork's upstream): https://github.com/tadashi-aikawa/obsidian-various-complements-plugin/blob/main/src/ui/AutoCompleteSuggest.ts
- CodeMirror forum — `input.complete` + `pickedCompletion`: https://discuss.codemirror.net/t/activateoncompletion-not-work-well/8529
- Obsidian forum — getting the CM6 view from a plugin: https://forum.obsidian.md/t/how-get-codemirror-in-plugin/55197
