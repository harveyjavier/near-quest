/**
 * Who owns the keyboard right now: the harbor, or a text field.
 *
 * Phaser listens for keys on `window`, so without a single answer to this
 * question the game and the HUD fight over every keystroke -- typing "was"
 * in chat walks the angler west, south and east.
 */

/** True when this element takes typed characters (chat, shop quantity, ...). */
export function isTypingTarget(element) {
  if (!element) return false;
  if (element.isContentEditable) return true;

  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;

  // Checkboxes, radios and buttons are activated with keys rather than typed
  // into, so they leave the keyboard to the game.
  return !/^(button|checkbox|radio|submit|reset|file|image|range|color)$/i.test(element.type);
}

/** True when the focused element is taking typed characters. */
export function isTyping() {
  return isTypingTarget(document.activeElement);
}
