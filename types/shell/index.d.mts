/**
 * The frameless shell: the stylesheet, and the tokens it needs.
 *
 * The CSS is the substance - `shell.css` beside this file. What is here is the
 * list of tokens it reads, so a test can hold the two in agreement rather than
 * somebody noticing a month later that a colour resolves to nothing.
 *
 * That has already happened once. Nib referenced `--accent-soft` from a rule and
 * never defined it, so that background quietly painted nothing for weeks. A
 * missing custom property is not an error anywhere in CSS; it is a rule that
 * silently does less than it says.
 */
/**
 * Every token `shell.css` reads.
 *
 * An app that loads the stylesheet has to define all of these. There are no
 * fallbacks in the CSS on purpose: a missing token should look wrong at once
 * rather than resolve to something plausible and be found later.
 */
export declare const SHELL_TOKENS: readonly ['bg', 'text', 'text-dim', 'surface-2', 'critical'];
/**
 * Which of the tokens a stylesheet does not define.
 *
 * Takes CSS as text rather than reading a file, so it works on a bundled sheet,
 * a concatenation, or whatever a consumer actually ships. Only `:root` and
 * `html` declarations count - a token defined inside a media query or a theme
 * class is not defined in the case that matters.
 *
 * @param {string} css The consumer's own stylesheet.
 * @returns {string[]} Token names, without the leading dashes.
 */
export declare function missingTokens(css: string): string[];
