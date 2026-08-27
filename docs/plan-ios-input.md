# Plan: iOS swipe/dictation input, and owning wterm/dom

Two bugs from on-device use, one decision about the dependency they live in.

## The bugs

- Words written with swipe typing (QuickPath) are inserted with no spaces between them.
- After swipe-typing, and after iOS dictation, the view is scrolled to the top of scrollback.

## Diagnosis

Both trace to `InputHandler` in `@wterm/dom` and where the app mounts it. The handler creates a hidden textarea styled `position: absolute; top: 0; left: -9999px` and appends it to the terminal element, which here is `#screen`, the scrollback scroller. Its input model is send-and-wipe: on every non-composing `input` event it sends the field's value and sets `value = ""`; on `compositionend` it sends `e.data` and wipes again. The field is empty at essentially all times. That emptiness is load-bearing for the iOS delete key: iOS natively edits the focused field despite keydown preventDefault, so an always-empty field is what keeps native deletion a no-op and backspace arriving only as clean keydowns. (It is also why the key bar's `⌫` implements its own repeat.)

**No spaces.** iOS inserts the separator space before a swiped word only when the field is non-empty at that moment, i.e. the previous word is still in it. Since wterm wipes the field after every commit, each swipe starts an empty field and inserts bare. Nothing is desynced; the separator simply is never due. No event carries "a space was owed", so this is unfixable at the app layer without changing the wipe behavior.

**Scroll to top.** Plain key taps are preventDefaulted at keydown, so no text ever lands in the DOM. Swipe and dictation perform real insertions into the field, after which WebKit reveals the caret/focused editable by scrolling it into view. The caret sits at the top of `#screen`'s content, so the reveal sets `scrollTop ≈ 0`. The app's own scroll machinery then faithfully preserves that imposed position.

Related actor: wterm calls `_scrollToBottom()` before forwarding every `onData`. Typing while parked in scrollback snaps to the bottom today, and swiped words will keep doing that once the reveal is fixed. Decision: accept it. It matches tapped-key behavior, and the reported bug is the jump to the top.

## Decision: vendor @wterm/dom

The input fix rewrites `InputHandler`'s event wiring and DOM ownership. Doing that through runtime surgery in app.js (removing its listeners, wrapping private bound methods) is maintaining a fork with worse tooling. The surrounding inventory points the same way: the `_renderedScrollbackCount` workaround for the scrollback ring bug, the `r.render` / `_doRender` rebinds, a guard block that exists to throw when internals move, and known core bugs (column-shrink data loss; `research/ghostty-vt-core` evaluates a future core swap).

Form: `git subtree` of the upstream TS repository, pinned to a recorded SHA, imported by path; drop the npm dependency. Not a copy of `dist` or TS reconstructed from sourcemaps -- the merge path is the point, so every upstream release can be a three-way merge. PRs go upstream in parallel; if a release lands the fixes, retire the vendor.

Scope: `@wterm/core` stays on npm, pinned exact. Its real defects live in the compiled Zig/WASM, which vendoring the JS shell does not touch, and the ghostty work is a future dependency swap, not a vendoring decision. Watch item once dom is vendored: dom/core API skew is ours to notice on every upstream merge.

One caution found during review: the installed dom is 0.3.4, not the 0.3.3 the `eli/` notes describe (the lockfile had drifted to 0.3.3 while node_modules ran 0.3.4; package.json is now pinned exact). The 0.3.4 renderer rewrote scrollback rendering as a virtualized overscan window with spacers. The app's `rebuildScrollback`/`ringTurn` math assumes the old append model and must not be ported into the vendor without re-validation.

## Sequence

1. **On-device experiment (gates everything).** A plain page with a styled-hidden `<textarea autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">`. Confirm (a) two consecutive swipes yield `hello world` when the field keeps the first word -- i.e. the separator really depends on a non-empty field; (b) a final non-composing `input` event fires after `compositionend`, carrying the committed text. If (a) fails, the delta approach is dead and the plan is re-opened.
2. **Vendor 0.3.4** via git subtree. Delete the internals guard block; switch imports to the path.
3. **Scrollback re-validation.** Establish whether the ring-freeze still reproduces against the virtualized renderer; delete or rewrite `rebuildScrollback`/`ringTurn` accordingly. Separate work item, not bundled with the input fix.
4. **Input fix, in source.**
   - `handleCompositionEnd` stops sending and stops clearing; it only clears the composing flag. The final non-composing `input` is the single sender, so `sent` (last transmitted content) has one writer and the diff stays self-correcting.
   - Delta handler on `input`: common-prefix/suffix diff between `sent` and the field; send `'\x7f'.repeat(deleted) + inserted`. Count erases in code points or graphemes (`Intl.Segmenter`), never UTF-16 units -- an emoji is 2 units but one PTY character. Translate `\n` to `\r` in inserted text (dictation can produce `insertParagraph`).
   - Backspace ownership: field empty, stock keydown path (preventDefault, send `\x7f`). Field non-empty, no preventDefault and no send; the native deletion arrives as `deleteContentBackward` and goes through the diff. The `if (composing) return` guard stays first in the keydown path.
   - Textarea placement: keep it inside the terminal element (the e2e suite selects `#screen textarea` in ~30 places) but pinned to the scroller's visible bottom edge -- sticky bottom or a top derived from `scrollTop + clientHeight` -- so caret reveal targets already-visible geometry. No reparenting.
   - `scrollOnData` becomes a constructor option (default true) replacing the unconditional `_scrollToBottom()` in the data path; policy instead of a wrapper.
   - Hygiene: clear the field and `sent` when not composing after ~30s idle or past ~4KB. Clearing is safe: the separator only matters within a continuous burst, and an empty field is exactly what the next burst's first word expects.
5. **Upstream PRs** against the recorded SHA: the input delta model and the scrollback findings. Retire the vendor when they land.
6. **Accepted behaviors, documented:** bar-`⌫` (direct `conn.send`) and software-`⌫` (diff path) diverge slightly once the field holds content; harmless, the field is a scratch buffer, never rendered. Swiping while parked in scrollback snaps to the bottom, consistent with tapped keys.

## Verification

Unit tests for the diff: insert, delete, replace, ambiguous overlap where prefix and suffix compete, emoji insert-then-delete, `\n` handling. On-device checklist: two swipes produce a space; swipe then immediate software `⌫` is a single delete with no junk; dictation while scrolled into history does not jump; holding software `⌫` with field content repeats natively with a correct count; `⌫` on an empty field still deletes; keyboard open/close has no new wobble; `⌘`/desktop IME and hardware backspace remain sane; e2e suite green with selectors untouched.
