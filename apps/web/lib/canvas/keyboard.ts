/**
 * The single answer to "is the user typing right now?".
 *
 * There used to be THREE predicates for this — `e.target.tagName` in the canvas
 * shortcut handler, `document.activeElement` in Input's Space guard, and a
 * separate `editingRef` for the text-overlay nav lock. They agreed only by
 * coincidence: the text overlay happens to be autofocused and commits on blur,
 * so target and focus happened to point at the same element. Any editing surface
 * that did not focus itself would have made them disagree, and the failure mode
 * is silent — a shortcut firing mid-word.
 *
 * Both forms are exported because both questions are real: a key event knows its
 * target, while a pointer/wheel handler only has ambient focus to go on.
 */

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable
  );
}

/** True if `target` (typically `KeyboardEvent.target`) is a text-entry control. */
export function isTypingElement(target: EventTarget | null): boolean {
  return target instanceof Element && isTextEntry(target);
}

/** True if focus is currently in a text-entry control, whatever the event target. */
export function isTypingNow(): boolean {
  if (typeof document === "undefined") return false;
  return isTextEntry(document.activeElement);
}
