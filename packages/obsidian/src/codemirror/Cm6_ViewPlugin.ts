import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type EditorState, type Range, type Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Cm6_Util } from 'packages/obsidian/src/codemirror/Cm6_Util';
import { type TokensResult } from 'shiki';
import { editorLivePreviewField } from 'obsidian';
import { getLinePrefix, parseEditorMeta, parseFenceLine, stripLinePrefix } from 'packages/obsidian/src/CodeBlockMeta';

interface InlineCode {
	from: number;
	to: number;
	lang: string;
	content: string;
	hideLang: boolean;
	hideTo: number;
}

interface FencedCodeBlock {
	/**
	 * 1-based line number of the opening fence.
	 */
	beginLine: number;
	/**
	 * 1-based line number of the closing fence, or null if the code block is not closed.
	 */
	endLine: number | null;
	/**
	 * 1-based line number of the last line of the code.
	 */
	lastCodeLine: number;
}

const TOKEN_CACHE_SIZE = 500;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	// Tokens of recently highlighted code, shared between all editors.
	// Without it, every edit would re-tokenize every code block in the note.
	const tokenCache = new Map<string, TokensResult | undefined>();
	const instances = new Set<Cm6ViewPlugin>();

	plugin.updateCm6Plugin = async (): Promise<void> => {
		tokenCache.clear();
		await Promise.all([...instances].map(instance => instance.rebuild(instance.view)));
	};

	async function getTokens(code: string, lang: string): Promise<TokensResult | undefined> {
		const key = `${lang}\n${code}`;
		if (tokenCache.has(key)) {
			const cached = tokenCache.get(key);
			// move the entry to the end, so that the least recently used entries are evicted first
			tokenCache.delete(key);
			tokenCache.set(key, cached);
			return cached;
		}

		const tokens = await plugin.highlighter.getHighlightTokens(code, lang);
		tokenCache.set(key, tokens);
		if (tokenCache.size > TOKEN_CACHE_SIZE) {
			tokenCache.delete(tokenCache.keys().next().value!);
		}
		return tokens;
	}

	function isLivePreview(state: EditorState): boolean {
		// @ts-ignore some strange private field not being assignable
		return state.field(editorLivePreviewField, false) ?? false;
	}

	function tokenMark(from: number, to: number, style: { style: string; classes: string[] }): Range<Decoration> {
		return Decoration.mark({
			class: ['shiki-token', ...style.classes].join(' '),
			attributes: { style: style.style },
		}).range(from, to);
	}

	/**
	 * Finds the shiki inline code (`{lang} code`) and the fenced code blocks in the parsed part of the document.
	 */
	function findCode(state: EditorState, includeCodeBlocks: boolean): { inlineCodes: InlineCode[]; codeBlocks: FencedCodeBlock[] } {
		const inlineCodes: InlineCode[] = [];
		const codeBlocks: FencedCodeBlock[] = [];
		let openBlock: FencedCodeBlock | undefined;
		const livePreview = isLivePreview(state);

		const tree = syntaxTree(state);
		// an unclosed code block goes until the end of the parsed part of the document
		const lastParsedLine = state.doc.lineAt(Math.min(tree.length, state.doc.length)).number;

		tree.iterate({
			enter: nodeRef => {
				const props = new Set<string>(nodeRef.type.name.split('_'));

				if (includeCodeBlocks && props.has('HyperMD-codeblock-begin')) {
					const line = state.doc.lineAt(nodeRef.from).number;
					if (openBlock?.beginLine !== line) {
						openBlock = { beginLine: line, endLine: null, lastCodeLine: lastParsedLine };
						codeBlocks.push(openBlock);
					}
					return;
				}

				if (includeCodeBlocks && props.has('HyperMD-codeblock-end')) {
					if (openBlock !== undefined) {
						openBlock.endLine = state.doc.lineAt(nodeRef.from).number;
						openBlock.lastCodeLine = openBlock.endLine - 1;
						openBlock = undefined;
					}
					return;
				}

				if (props.has('formatting') || !props.has('inline-code') || !plugin.settings.inlineHighlighting) {
					return;
				}

				const content = Cm6_Util.getContent(state, nodeRef.from, nodeRef.to);
				const match = SHIKI_INLINE_REGEX.exec(content); // format: `{lang} code`
				if (!match) {
					return;
				}

				const hasSelectionOverlap = Cm6_Util.checkSelectionAndRangeOverlap(state.selection, nodeRef.from - 1, nodeRef.to + 1);
				inlineCodes.push({
					from: nodeRef.from,
					to: nodeRef.to,
					lang: match[1],
					content: match[2],
					hideLang: livePreview && !hasSelectionOverlap,
					hideTo: nodeRef.from + match[1].length + 3, // hide `{lang} `
				});
			},
		});

		return { inlineCodes, codeBlocks };
	}

	async function buildInlineDecorations(inlineCode: InlineCode): Promise<Range<Decoration>[]> {
		const highlight = await getTokens(inlineCode.content, inlineCode.lang.toLowerCase());
		if (!highlight) {
			return [];
		}

		const decorations: Range<Decoration>[] = [];
		if (inlineCode.hideLang) {
			decorations.push(Decoration.replace({}).range(inlineCode.from, inlineCode.hideTo));
		}

		for (const token of highlight.tokens.flat(1)) {
			const from = inlineCode.hideTo + token.offset;
			const to = Math.min(from + token.content.length, inlineCode.to);
			if (from < to) {
				decorations.push(tokenMark(from, to, plugin.highlighter.getTokenStyle(token)));
			}
		}

		return decorations;
	}

	async function buildCodeBlockDecorations(doc: Text, codeBlock: FencedCodeBlock): Promise<Range<Decoration>[]> {
		const fence = parseFenceLine(doc.line(codeBlock.beginLine).text);
		const lang = fence?.language.toLowerCase() ?? '';
		if (fence === null || lang === '') {
			return [];
		}

		// collect the code, without the line prefixes of e.g. callouts, and where each line starts in the document
		const prefix = getLinePrefix(fence);
		const codeLines: string[] = [];
		const lineStarts: number[] = [];
		for (let lineNumber = codeBlock.beginLine + 1; lineNumber <= codeBlock.lastCodeLine; lineNumber++) {
			const line = doc.line(lineNumber);
			const skip = stripLinePrefix(line.text, prefix);
			codeLines.push(line.text.slice(skip));
			lineStarts.push(line.from + skip);
		}

		if (codeLines.length === 0) {
			return [];
		}

		const highlight = await getTokens(codeLines.join('\n'), lang);
		if (!highlight) {
			return [];
		}

		const decorations: Range<Decoration>[] = [];

		// token offsets are relative to the whole code, so we track where each line starts in the code
		let lineOffset = 0;
		for (let i = 0; i < highlight.tokens.length && i < codeLines.length; i++) {
			for (const token of highlight.tokens[i]) {
				const from = lineStarts[i] + token.offset - lineOffset;
				const to = from + token.content.length;
				if (token.content.length > 0) {
					decorations.push(tokenMark(from, to, plugin.highlighter.getTokenStyle(token)));
				}
			}
			lineOffset += codeLines[i].length + 1;
		}

		const meta = parseEditorMeta(fence.meta, plugin.loadedSettings.ecDefaultShowLineNumbers);
		const useThemeColors = plugin.loadedSettings.preferThemeColors && !plugin.highlighter.themeMapper.usingObsidianTheme();
		const themeStyle = useThemeColors && highlight.bg ? `--code-background: ${highlight.bg}; --code-normal: ${highlight.fg ?? 'inherit'};` : '';
		const lineNumberWidth = String(meta.startLineNumber + codeLines.length - 1).length;

		for (const fenceLine of [codeBlock.beginLine, codeBlock.endLine]) {
			if (fenceLine !== null && themeStyle !== '') {
				decorations.push(Decoration.line({ attributes: { style: themeStyle } }).range(doc.line(fenceLine).from));
			}
		}

		for (let i = 0; i < codeLines.length; i++) {
			const classes = ['shiki-line'];
			const attributes: Record<string, string> = {};
			let style = themeStyle;

			const marker = meta.lineMarkers.get(i + 1);
			if (marker !== undefined) {
				classes.push(`shiki-line-${marker}`);
			}

			if (meta.showLineNumbers) {
				classes.push('shiki-line-number');
				attributes['data-shiki-line-number'] = String(meta.startLineNumber + i);
				style += `--shiki-line-number-width: ${lineNumberWidth}ch;`;
			}

			if (style !== '') {
				attributes.style = style;
			}

			decorations.push(Decoration.line({ class: classes.join(' '), attributes }).range(doc.line(codeBlock.beginLine + 1 + i).from));
		}

		return decorations;
	}

	class Cm6ViewPlugin {
		decorations: DecorationSet;
		view: EditorView;
		/**
		 * Set while a rebuild has not finished yet. A rebuild is abandoned when the document changes while it is
		 * waiting for the highlighter, so the next update has to rebuild everything, even if it is just a selection change.
		 */
		rebuildPending: boolean;

		constructor(view: EditorView) {
			this.view = view;
			this.decorations = Decoration.none;
			this.rebuildPending = false;
			instances.add(this);

			void this.rebuild(view);
		}

		/**
		 * Triggered by codemirror when the view updates.
		 */
		update(update: ViewUpdate): void {
			this.view = update.view;

			try {
				this.decorations = this.decorations.map(update.changes);
			} catch (e) {
				this.decorations = Decoration.none;
				console.warn('Resetting decorations due to error:', e);
			}

			const needsRebuild =
				this.rebuildPending ||
				update.docChanged ||
				// the document is parsed incrementally, so code blocks further down are found later
				syntaxTree(update.startState) !== syntaxTree(update.state) ||
				isLivePreview(update.startState) !== isLivePreview(update.state);

			if (needsRebuild) {
				void this.rebuild(update.view);
			} else if (update.selectionSet) {
				// the selection only affects whether the language of inline code is hidden
				void this.updateInlineCode(update.view);
			}
		}

		/**
		 * Rebuilds all decorations. The old decorations stay until the new ones are ready, to avoid flickering.
		 */
		async rebuild(view: EditorView): Promise<void> {
			this.rebuildPending = true;
			const state = view.state;
			const { inlineCodes, codeBlocks } = findCode(state, true);

			const decorations: Range<Decoration>[] = [];
			try {
				for (const codeBlock of codeBlocks) {
					decorations.push(...(await buildCodeBlockDecorations(state.doc, codeBlock)));
				}
				for (const inlineCode of inlineCodes) {
					decorations.push(...(await buildInlineDecorations(inlineCode)));
				}
			} catch (e) {
				console.error(e);
			}

			// the positions are stale if the document changed while we were waiting for the highlighter,
			// in that case the rebuild started by that change takes over
			if (this.view.state !== state) {
				return;
			}

			this.decorations = Decoration.set(decorations, true);
			this.rebuildPending = false;
			this.redraw(state);
		}

		/**
		 * Updates only the inline code decorations, which depend on the selection.
		 */
		async updateInlineCode(view: EditorView): Promise<void> {
			const state = view.state;
			const { inlineCodes } = findCode(state, false);
			if (inlineCodes.length === 0) {
				return;
			}

			const updates: { inlineCode: InlineCode; decorations: Range<Decoration>[] }[] = [];
			for (const inlineCode of inlineCodes) {
				updates.push({ inlineCode, decorations: await buildInlineDecorations(inlineCode) });
			}

			if (this.view.state !== state) {
				return;
			}

			for (const { inlineCode, decorations } of updates) {
				this.decorations = this.decorations.update({
					filterFrom: inlineCode.from,
					filterTo: inlineCode.to,
					filter: () => false,
					add: decorations,
					sort: true,
				});
			}
			this.redraw(state);
		}

		private redraw(state: EditorState): void {
			// Use requestAnimationFrame to avoid "Calls to EditorView.update are not allowed while an update is in progress".
			// Update the view directly instead of dispatching an empty transaction. A
			// transaction during IME composition can interrupt the browser's composing
			// text, notably with the Windows Korean IME.
			requestAnimationFrame(() => {
				if (this.view.state === state) {
					this.view.update([]);
				}
			});
		}

		/**
		 * Triggered by codemirror when the view plugin is destroyed.
		 */
		destroy(): void {
			instances.delete(this);
			this.decorations = Decoration.none;
		}
	}

	return ViewPlugin.fromClass(Cm6ViewPlugin, {
		decorations: v => v.decorations,
	});
}
