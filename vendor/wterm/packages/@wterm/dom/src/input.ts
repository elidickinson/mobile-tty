import type { TerminalCore } from "@wterm/core";
import { isLinkActivationModifier } from "./hyperlink.js";

const NORMAL_KEYS: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
};

const APP_KEYS: Record<string, string> = {
  ArrowUp: "\x1bOA",
  ArrowDown: "\x1bOB",
  ArrowRight: "\x1bOC",
  ArrowLeft: "\x1bOD",
  Home: "\x1bOH",
  End: "\x1bOF",
};

const FIXED_KEYS: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

export class InputHandler {
  private element: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private onData: (data: string) => void;
  private getBridge: () => TerminalCore | null;
  private getCellSize: () => {
    charWidth: number;
    rowHeight: number;
  } | null;
  private composing = false;
  private mouseButtons = 0;
  private focused = false;
  // The field is a mirror of the PTY's input line: `sent` is what this class
  // has transmitted of the field's content. Every byte the PTY receives from
  // anywhere else (bar keys, Enter, paste, PTY resets) must invalidate the
  // mirror via resetMirror(), or the next diff sends bytes that double-apply.
  private sent = "";
  private idleClear: ReturnType<typeof setTimeout> | null = null;
  private segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  /** True while the diff is transmitting, so consumers can exempt it from
   *  modifier chords and other send-side rewriting. */
  inFlush = false;

  private _onKeyDown: (e: KeyboardEvent) => void;
  private _onPaste: (e: ClipboardEvent) => void;
  private _onCompositionStart: () => void;
  private _onCompositionEnd: (e: CompositionEvent) => void;
  private _onInput: (e: InputEvent) => void;
  private _onFocus: () => void;
  private _onBlur: () => void;
  private _onMouseDown: (e: MouseEvent) => void;
  private _onMouseMove: (e: MouseEvent) => void;
  private _onMouseUp: (e: MouseEvent) => void;
  private _onWheel: (e: WheelEvent) => void;

  constructor(
    element: HTMLElement,
    onData: (data: string) => void,
    getBridge: () => TerminalCore | null,
    getCellSize: () => { charWidth: number; rowHeight: number } | null = () =>
      null,
  ) {
    this.element = element;
    this.onData = onData;
    this.getBridge = getBridge;
    this.getCellSize = getCellSize;

    this.textarea = document.createElement("textarea");
    this.textarea.setAttribute("autocapitalize", "off");
    this.textarea.setAttribute("autocomplete", "off");
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.setAttribute("spellcheck", "false");
    this.textarea.setAttribute("enterkeyhint", "send");
    this.textarea.setAttribute("tabindex", "0");
    this.textarea.setAttribute("aria-hidden", "true");
    const s = this.textarea.style;
    // Sticky at the scrollport's bottom edge: the caret is always in view, so
    // WebKit's reveal-the-caret scrolling (swipe, dictation, any real
    // insertion) has nothing to correct and never drags the scroller to the
    // top of history, where an absolutely-positioned field at top: 0 put it.
    // The element is fully transparent, 1px wide and 0 tall, so being in view
    // shows nothing and adds nothing to the scroll geometry; in flow it sits
    // after the grid, which keeps it out of every row-height invariant.
    s.position = "sticky";
    s.bottom = "0";
    s.left = "0";
    s.top = "auto";
    s.width = "1px";
    s.height = "0";
    s.opacity = "0";
    s.overflow = "hidden";
    s.border = "0";
    s.padding = "0";
    s.margin = "0";
    s.outline = "none";
    s.resize = "none";
    s.pointerEvents = "none";
    s.caretColor = "transparent";
    s.color = "transparent";
    s.background = "transparent";
    element.appendChild(this.textarea);

    this._onKeyDown = this.handleKeyDown.bind(this);
    this._onPaste = this.handlePaste.bind(this);
    this._onCompositionStart = this.handleCompositionStart.bind(this);
    this._onCompositionEnd = this.handleCompositionEnd.bind(this);
    this._onInput = this.handleInput.bind(this);
    this._onFocus = () => {
      if (this.focused) return;
      this.focused = true;
      this.element.classList.add("focused");
      if (this.getBridge()?.focusEvents?.()) this.onData("\x1b[I");
    };
    this._onBlur = () => {
      this.focused = false;
      this.element.classList.remove("focused");
      this.stopMouseCapture();
      if (this.getBridge()?.focusEvents?.()) this.onData("\x1b[O");
    };
    this._onMouseDown = (event) => this.handleMouse(event, "press");
    this._onMouseMove = (event) => {
      if (this.mouseButtons !== 0) this.handleMouse(event, "move");
    };
    this._onMouseUp = (event) => {
      if (this.mouseButtons === 0) return;
      this.handleMouse(event, "release");
      this.mouseButtons = event.buttons & 7;
      if (this.mouseButtons === 0) this.stopMouseCapture();
    };
    this._onWheel = (event) => this.handleMouse(event, "wheel");

    this.textarea.addEventListener("keydown", this._onKeyDown);
    this.textarea.addEventListener("paste", this._onPaste as EventListener);
    this.textarea.addEventListener(
      "compositionstart",
      this._onCompositionStart,
    );
    this.textarea.addEventListener(
      "compositionend",
      this._onCompositionEnd as EventListener,
    );
    this.textarea.addEventListener("input", this._onInput);
    this.textarea.addEventListener("focus", this._onFocus);
    this.textarea.addEventListener("blur", this._onBlur);
    this.element.addEventListener("mousedown", this._onMouseDown);
    this.element.addEventListener("wheel", this._onWheel, { passive: false });
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
  }

  destroy(): void {
    if (this.idleClear !== null) clearTimeout(this.idleClear);
    this.textarea.removeEventListener("keydown", this._onKeyDown);
    this.textarea.removeEventListener("paste", this._onPaste as EventListener);
    this.textarea.removeEventListener(
      "compositionstart",
      this._onCompositionStart,
    );
    this.textarea.removeEventListener(
      "compositionend",
      this._onCompositionEnd as EventListener,
    );
    this.textarea.removeEventListener("input", this._onInput);
    this.textarea.removeEventListener("focus", this._onFocus);
    this.textarea.removeEventListener("blur", this._onBlur);
    this.element.removeEventListener("mousedown", this._onMouseDown);
    this.stopMouseCapture();
    this.element.removeEventListener("wheel", this._onWheel);
    this.element.classList.remove("focused");
    this.textarea.remove();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.composing) return;

    // A non-empty field means iOS is driving deletion natively: its repeat
    // arrives as repeated deleteContentBackward input events, not keydowns,
    // and preventDefault here would cancel that loop. Stand aside and let the
    // diff turn the deletion into DEL bytes. An empty field is the only time
    // the keydown path below is the deletion's owner.
    if (e.key === "Backspace" && this.textarea.value !== "") return;
    if ((e.metaKey || e.ctrlKey) && e.key === "c") {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "v") {
      this.textarea.focus();
      return;
    }
    if (e.metaKey && !e.ctrlKey) {
      if (e.key === "Backspace") {
        e.preventDefault();
        this.onData("\x15");
      } else if (e.key === "a") {
        e.preventDefault();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(this.element);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return;
    }

    // Only preventDefault once a sequence is actually produced: keys with no
    // terminal meaning (an emoji keydown carries the character as a 2-unit
    // string, for one) must keep their default action, which is a real
    // insertion into the field -- the input event then carries it through the
    // diff. Suppressing it here is what made emoji presses do nothing.
    const seq = this.keyToSequence(e);
    if (!seq) return;
    e.preventDefault();
    // Everything a keydown sends either changes or consumes the PTY's line,
    // so the mirror goes: arrows move the cursor (the diff transport assumes
    // end-of-line), Enter consumes the line, a printable appends to it.
    this.resetMirror();
    this.onData(seq);
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (!text) return;

    const bridge = this.getBridge();
    if (bridge && bridge.bracketedPaste()) {
      // Strip ESC bytes so clipboard payloads cannot inject \x1b[201~ to
      // break out of bracketed paste mode and smuggle commands to the PTY.
      const safe = text.replace(/\x1b/g, "");
      this.onData("\x1b[200~" + safe + "\x1b[201~");
    } else {
      this.onData(text);
    }
    this.resetMirror();
  }

  private handleCompositionStart(): void {
    this.composing = true;
  }

  private handleCompositionEnd(e: CompositionEvent): void {
    this.composing = false;
    // Do not send e.data: engines disagree about whether the final `input`
    // fires before or after `compositionend`, and the committed text is in
    // the field either way -- flush() is idempotent, so whichever event
    // carries it first transmits it exactly once.
    this.flush();
  }

  private handleInput(e: InputEvent): void {
    if (this.composing) return;
    this.flush();
  }

  /**
   * Transmit the difference between the field and what has already been
   * sent. The field is never wiped: iOS's text-insertion system (QuickPath,
   * dictation, the emoji keyboard) reads it to decide things like the
   * separator space between swiped words, and an empty field reads as
   * "nothing to separate".
   *
   * Erase counts are graphemes -- that is what a terminal line editor removes
   * per DEL (verified against pi) -- and the transport assumes the PTY's
   * cursor is at end-of-line, which every mirror invalidation exists to
   * protect.
   *
   * A newline inside the inserted text is translated to CR (dictation emits
   * insertParagraph). Everything before a CR is consumed by the program, and
   * the field's tail after the last CR is exactly the PTY's new line, so the
   * mirror stays aligned without touching the field mid-dictation.
   */
  private flush(): void {
    const value = this.textarea.value;
    if (value === this.sent) return;
    this.armIdleClear();
    const before = Array.from(this.segmenter.segment(this.sent), (x) => x.segment);
    const after = Array.from(this.segmenter.segment(value), (x) => x.segment);
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    let s = 0;
    while (
      s < before.length - p &&
      s < after.length - p &&
      before[before.length - 1 - s] === after[after.length - 1 - s]
    )
      s++;
    const deleted = before.length - p - s;
    const inserted = after
      .slice(p, after.length - s)
      .join("")
      .replace(/\n/g, "\r");
    if (deleted > 0 || inserted.length > 0) {
      this.inFlush = true;
      try {
        this.onData("\x7f".repeat(deleted) + inserted);
      } finally {
        this.inFlush = false;
      }
    }
    this.sent = value;
    // Bounded buffer: past the cap, forget immediately after transmitting.
    if (value.length > 4096) this.resetMirror();
  }

  /**
   * Drop the mirror: the field is cleared and its content forgotten. Call
   * whenever the PTY's line changes from outside this class, or the next
   * diff sends bytes that double-apply over the new line state.
   */
  resetMirror(): void {
    this.textarea.value = "";
    this.sent = "";
    if (this.idleClear !== null) {
      clearTimeout(this.idleClear);
      this.idleClear = null;
    }
  }

  /**
   * A long-lived field is a scratch buffer, not a diary: forget it after a
   * generous idle, and keep it bounded during a continuous burst. Forgetting
   * only drops separator context and re-send history; the next transmission
   * is computed from an empty mirror and appends correctly.
   */
  private armIdleClear(): void {
    if (this.idleClear !== null) clearTimeout(this.idleClear);
    this.idleClear = setTimeout(() => {
      if (!this.composing) this.resetMirror();
    }, 30_000);
  }

  private handleMouse(
    event: MouseEvent | WheelEvent,
    kind: "press" | "move" | "release" | "wheel",
  ): void {
    const bridge = this.getBridge();
    const tracking = bridge?.mouseTracking?.() ?? 0;
    if (!bridge || tracking === 0 || !bridge.mouseSgr?.()) return;
    if (
      kind === "press" &&
      isLinkActivationModifier(
        event,
        this.element.ownerDocument.defaultView?.navigator ?? navigator,
      ) &&
      event.target instanceof Element &&
      event.target.closest(".term-link")
    ) {
      return;
    }
    if (kind === "press" && (event.shiftKey || event.button > 2)) return;
    if (kind === "release" && event.button > 2) return;
    const supportedButtons = event.buttons & 7;
    if (kind === "move" && (tracking !== 1002 || supportedButtons === 0)) {
      return;
    }

    const view = this.element.ownerDocument.defaultView;
    if (!view) return;
    const viewportRow = this.element.querySelector<HTMLElement>(
      ".term-row:not(.term-scrollback-row)",
    );
    const hostRect = this.element.getBoundingClientRect();
    const rowRect = viewportRow?.getBoundingClientRect();
    const cellSize = this.getCellSize();
    let left: number;
    let top: number;
    let charWidth: number;
    let rowHeight: number;
    if (rowRect && cellSize) {
      left = rowRect.left;
      top = rowRect.top;
      charWidth = cellSize.charWidth;
      rowHeight = cellSize.rowHeight;
    } else {
      const style = view.getComputedStyle(this.element);
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderRight = parseFloat(style.borderRightWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const borderBottom = parseFloat(style.borderBottomWidth) || 0;
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      left = rowRect?.left ?? hostRect.left + borderLeft + paddingLeft;
      top = rowRect?.top ?? hostRect.top + borderTop + paddingTop;
      charWidth =
        (hostRect.width -
          borderLeft -
          borderRight -
          paddingLeft -
          paddingRight) /
        bridge.getCols();
      rowHeight =
        (hostRect.height -
          borderTop -
          borderBottom -
          paddingTop -
          paddingBottom) /
        bridge.getRows();
    }
    if (charWidth <= 0 || rowHeight <= 0) return;
    if (kind === "press") {
      this.textarea.focus({ preventScroll: true });
      if (!this.focused) this._onFocus();
      this.mouseButtons =
        supportedButtons ||
        (event.button === 1 ? 4 : event.button === 2 ? 2 : 1);
      view.addEventListener("mousemove", this._onMouseMove);
      view.addEventListener("mouseup", this._onMouseUp);
    }
    const col = Math.max(
      1,
      Math.min(
        bridge.getCols(),
        Math.floor((event.clientX - left) / charWidth) + 1,
      ),
    );
    const row = Math.max(
      1,
      Math.min(
        bridge.getRows(),
        Math.floor((event.clientY - top) / rowHeight) + 1,
      ),
    );
    const modifiers =
      (event.shiftKey ? 4 : 0) |
      (event.altKey ? 8 : 0) |
      (event.ctrlKey ? 16 : 0);
    let code: number;
    let final = "M";
    if (kind === "wheel") {
      const wheel = event as WheelEvent;
      if (Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)) {
        if (wheel.deltaX === 0) return;
        code = (wheel.deltaX < 0 ? 66 : 67) | modifiers;
      } else {
        if (wheel.deltaY === 0) return;
        code = (wheel.deltaY < 0 ? 64 : 65) | modifiers;
      }
    } else {
      const button =
        kind === "move"
          ? supportedButtons & 4
            ? 1
            : supportedButtons & 2
              ? 2
              : 0
          : event.button === 1
            ? 1
            : event.button === 2
              ? 2
              : 0;
      code = button | modifiers | (kind === "move" ? 32 : 0);
      if (kind === "release") final = "m";
    }
    event.preventDefault();
    this.onData(`\x1b[<${code};${col};${row}${final}`);
  }

  private stopMouseCapture(): void {
    this.mouseButtons = 0;
    const view = this.element.ownerDocument.defaultView;
    view?.removeEventListener("mousemove", this._onMouseMove);
    view?.removeEventListener("mouseup", this._onMouseUp);
  }

  private keyToSequence(e: KeyboardEvent): string | null {
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key.length === 1) {
        const code = e.key.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
      }
      if (e.key === "[") return "\x1b";
      if (e.key === "\\") return "\x1c";
      if (e.key === "]") return "\x1d";
      if (e.key === "^") return "\x1e";
      if (e.key === "_") return "\x1f";
    }

    if (e.key === "Enter" && e.shiftKey) return "\x1b[13;2u";
    if (e.key === "Tab" && e.shiftKey) return "\x1b[Z";

    const fixed = FIXED_KEYS[e.key];
    if (fixed) return e.altKey ? "\x1b" + fixed : fixed;

    const bridge = this.getBridge();
    const appMode = bridge && bridge.cursorKeysApp();
    const navMap = appMode ? APP_KEYS : NORMAL_KEYS;
    const nav = navMap[e.key];
    if (nav) return e.altKey ? "\x1b" + nav : nav;

    if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey) {
      return e.altKey ? "\x1b" + e.key : e.key;
    }

    return null;
  }
}
