/**
 * Drop-in replacement for the `shiki` entry point, aliased in `vite.config.mts`.
 *
 * The regular `shiki` entry re-exports every bundled theme and language, which makes up the vast majority of the plugin size.
 * This module exposes the same API, but with no bundled themes or languages. Themes and languages have to be loaded from the
 * custom theme and language folders instead.
 */
import { createHighlighterCore, type HighlighterCore, type HighlighterCoreOptions } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';

export * from 'shiki/core';
export { createOnigurumaEngine, loadWasm } from 'shiki/engine/oniguruma';
export { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript';

export const bundledLanguages = {};
export const bundledLanguagesBase = {};
export const bundledLanguagesAlias = {};
export const bundledLanguagesInfo = [];
export const bundledThemes = {};
export const bundledThemesInfo = [];

export function createHighlighter(options: Omit<HighlighterCoreOptions, 'engine'> & Partial<Pick<HighlighterCoreOptions, 'engine'>>): Promise<HighlighterCore> {
	return createHighlighterCore({
		engine: createOnigurumaEngine(import('shiki/wasm')),
		...options,
	});
}
