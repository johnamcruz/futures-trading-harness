'use strict';

/**
 * A labelled line in a model's reply (the context quiz's rule, #347): the label at the line's start, then its colon, or
 * whitespace then a dash (a hyphen, an en or an em dash); markdown bold around the label or the separator. A line that
 * only starts with the word ("Answering ...", "Answer-wise ...") or quotes the label inside prose is none.
 *
 *   labelLines(text, label, { ignoreCase, colonOnly })   every such line's text after the separator, trimmed, in order
 *     label       a regular-expression source (e.g. 'SELECTION', '(?:FINAL\\s+)?ANSWER'), matched whole-word
 *     ignoreCase  the label in any case (the quiz's ANSWER); default: exactly as given (the selection skill's SELECTION)
 *     colonOnly   the colon form only (the quiz's graded ANSWER line)
 */
function labelLines(text, label, { ignoreCase = false, colonOnly = false } = {}) {
  const sep = colonOnly ? ':' : '(?::|\\s+[-–—])';
  const re = new RegExp(`^\\s*\\**\\s*${label}\\b\\s*\\**\\s*${sep}\\**\\s*(.*)$`, `gm${ignoreCase ? 'i' : ''}`);
  return [...String(text || '').matchAll(re)].map(m => m[1].trim());
}

module.exports = { labelLines };
