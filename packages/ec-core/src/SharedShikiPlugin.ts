import { definePlugin, InlineStyleAnnotation, type ExpressiveCodeLine, type ExpressiveCodePlugin, type ExpressiveCodeTheme } from '@expressive-code/core';
import { isSpecialLang, type HighlighterCore, type ThemedToken, type ThemeRegistration } from 'shiki/core';

const TERMINAL_LANGUAGES = new Set(['shellscript', 'shell', 'bash', 'sh', 'zsh', 'nu', 'nushell']);

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

/**
 * Syntax highlighting for Expressive Code, a replacement for `@expressive-code/plugin-shiki`.
 *
 * The official plugin creates its own shiki highlighter, so every grammar would be loaded and compiled twice,
 * and it hashes its whole config, including all grammars, for every code block it renders.
 * This plugin highlights with the highlighter the plugin already has instead.
 *
 * @param getHighlighter returns the loaded highlighter, it is only called while rendering
 */
export function pluginSharedShiki(getHighlighter: () => HighlighterCore | undefined): ExpressiveCodePlugin {
	// the name each EC theme is loaded into the highlighter as, since EC themes differ from the themes the highlighter was created with
	const themeNames = new WeakMap<ExpressiveCodeTheme, string>();
	let themeCounter = 0;

	async function ensureThemeIsLoaded(highlighter: HighlighterCore, theme: ExpressiveCodeTheme): Promise<string> {
		let name = themeNames.get(theme);
		if (name === undefined) {
			name = `expressive-code-theme-${themeCounter++}`;
			themeNames.set(theme, name);
		}

		if (!highlighter.getLoadedThemes().includes(name)) {
			const themeRegistration: ThemeRegistration = { ...theme, name, settings: theme.settings ?? [] };
			await highlighter.loadTheme(themeRegistration);
		}

		return name;
	}

	return definePlugin({
		name: 'Shiki',
		hooks: {
			performSyntaxAnalysis: async ({ codeBlock, styleVariants }) => {
				const highlighter = getHighlighter();
				if (highlighter === undefined) {
					throw new Error('Failed to highlight code block, the syntax highlighter is not loaded.');
				}

				const codeLines = codeBlock.getLines();
				let code = codeBlock.code;
				// placeholders like `<file>` would otherwise be highlighted as redirections
				if (TERMINAL_LANGUAGES.has(codeBlock.language)) {
					code = code.replace(/<([^>]*[^>\s])>/g, 'X$1X');
				}

				const language =
					isSpecialLang(codeBlock.language) || highlighter.getLoadedLanguages().includes(codeBlock.language) ? codeBlock.language : 'txt';

				for (let styleVariantIndex = 0; styleVariantIndex < styleVariants.length; styleVariantIndex++) {
					const theme = styleVariants[styleVariantIndex].theme;

					let tokenLines: ThemedToken[][];
					try {
						const themeName = await ensureThemeIsLoaded(highlighter, theme);
						tokenLines = highlighter.codeToTokensBase(code, { lang: language, theme: themeName, includeExplanation: false });
					} catch (e) {
						throw new Error(`Failed to highlight code block with language "${codeBlock.language}" and theme "${theme.name}".`, { cause: e });
					}

					tokenLines.forEach((line, lineIndex) => {
						const codeLine = codeLines[lineIndex];
						if (codeLine === undefined) {
							return;
						}

						if (codeBlock.language === 'ansi' && styleVariantIndex === 0) {
							removeAnsiSequencesFromCodeLine(codeLine, line);
						}

						let charIndex = 0;
						for (const token of line) {
							const tokenEndIndex = charIndex + token.content.length;
							const fontStyle = token.fontStyle ?? 0;
							codeLine.addAnnotation(
								new InlineStyleAnnotation({
									styleVariantIndex,
									color: token.color ?? theme.fg,
									bgColor: token.bgColor,
									italic: (fontStyle & FONT_STYLE_ITALIC) !== 0,
									bold: (fontStyle & FONT_STYLE_BOLD) !== 0,
									underline: (fontStyle & FONT_STYLE_UNDERLINE) !== 0,
									strikethrough: (fontStyle & FONT_STYLE_STRIKETHROUGH) !== 0,
									inlineRange: { columnStart: charIndex, columnEnd: tokenEndIndex },
									renderPhase: 'earliest',
								}),
							);
							charIndex = tokenEndIndex;
						}
					});
				}
			},
		},
	});
}

/**
 * The tokens of ANSI code no longer contain the escape sequences, so they are removed from the line as well.
 */
function removeAnsiSequencesFromCodeLine(codeLine: ExpressiveCodeLine, lineTokens: ThemedToken[]): void {
	const newLine = lineTokens.map(token => token.content).join('');
	const rangesToRemove = getRemovedRanges(codeLine.text, newLine);
	for (let index = rangesToRemove.length - 1; index >= 0; index--) {
		const [start, end] = rangesToRemove[index];
		codeLine.editText(start, end, '');
	}
}

function getRemovedRanges(original: string, edited: string): [number, number][] {
	const ranges: [number, number][] = [];
	let from = -1;
	let originalIndex = 0;
	let editedIndex = 0;

	while (originalIndex < original.length && editedIndex < edited.length) {
		if (original[originalIndex] !== edited[editedIndex]) {
			if (from === -1) {
				from = originalIndex;
			}
			originalIndex++;
		} else {
			if (from > -1) {
				ranges.push([from, originalIndex]);
				from = -1;
			}
			originalIndex++;
			editedIndex++;
		}
	}

	if (editedIndex < edited.length) {
		throw new Error(`Edited string contains characters not present in original (${JSON.stringify({ original, edited })})`);
	}
	if (originalIndex < original.length) {
		ranges.push([originalIndex, original.length]);
	}

	return ranges;
}
