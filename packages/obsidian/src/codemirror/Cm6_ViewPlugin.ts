import type ShikiPlugin from 'packages/obsidian/src/main';
import { SHIKI_INLINE_REGEX } from 'packages/obsidian/src/main';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type EditorState, type Range, type Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { type Tree } from '@lezer/common';
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

interface DocWindow {
	from: number;
	to: number;
}

const TOKEN_CACHE_SIZE = 500;
// line decorations carry the line number, so there can be many distinct ones, unlike token marks
const LINE_DECORATION_CACHE_SIZE = 10_000;
// the minimum number of characters decorated above and below the viewport
const MIN_WINDOW_MARGIN = 2_000;

const CODE_BLOCK_BEGIN = 'HyperMD-codeblock-begin';
const CODE_BLOCK_END = 'HyperMD-codeblock-end';

function hasNodeProp(nodeName: string, prop: string): boolean {
	return nodeName.split('_').includes(prop);
}

/**
 * The part of the document that gets decorated: the viewport plus a margin, so that scrolling a bit does not need a rebuild.
 */
function getDecorationWindow(view: EditorView): DocWindow {
	const { from, to } = view.viewport;
	const margin = Math.max(to - from, MIN_WINDOW_MARGIN);
	return { from: Math.max(0, from - margin), to: Math.min(view.state.doc.length, to + margin) };
}

function isLineInWindow(lineFrom: number, lineTo: number, window: DocWindow): boolean {
	return lineFrom <= window.to && lineTo >= window.from;
}

/**
 * Looks backwards from `pos` for the opening fence of a code block that `pos` is in.
 * Returns the position of the opening fence, or null if `pos` is not in a code block.
 */
function findCodeBlockBeginBefore(tree: Tree, pos: number): number | null {
	const cursor = tree.cursorAt(pos, -1);
	do {
		const name = cursor.type.name;
		if (hasNodeProp(name, CODE_BLOCK_END)) {
			return null;
		}
		if (hasNodeProp(name, CODE_BLOCK_BEGIN)) {
			return cursor.from;
		}
	} while (cursor.prev());
	return null;
}

/**
 * Looks forwards from `pos` for the closing fence of the code block that was opened at `beginPos`.
 * Returns the position of the closing fence, or null if the code block is not closed in the parsed part of the document.
 */
function findCodeBlockEndAfter(tree: Tree, pos: number, beginPos: number): number | null {
	const cursor = tree.cursorAt(pos, 1);
	do {
		if (cursor.from > beginPos && hasNodeProp(cursor.type.name, CODE_BLOCK_END)) {
			return cursor.from;
		}
	} while (cursor.next());
	return null;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- not an easily named type
export function createCm6Plugin(plugin: ShikiPlugin) {
	// Tokens of recently highlighted code, shared between all editors.
	// Without it, every edit would re-tokenize every code block in the note.
	const tokenCache = new Map<string, TokensResult | undefined>();
	const instances = new Set<Cm6ViewPlugin>();
	// Decorations are immutable values, so all tokens and lines with the same style share one decoration object.
	// This saves a lot of memory in large notes and lets codemirror skip unchanged DOM on rebuilds.
	const markCache = new Map<string, Decoration>();
	const lineDecorationCache = new Map<string, Decoration>();

	plugin.updateCm6Plugin = async (): Promise<void> => {
		tokenCache.clear();
		markCache.clear();
		lineDecorationCache.clear();
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
		const cls = ['shiki-token', ...style.classes].join(' ');
		const key = `${cls}\n${style.style}`;
		let decoration = markCache.get(key);
		if (decoration === undefined) {
			decoration = Decoration.mark({ class: cls, attributes: { style: style.style } });
			markCache.set(key, decoration);
		}
		return decoration.range(from, to);
	}

	function lineDecoration(pos: number, cls: string | undefined, attributes: Record<string, string>): Range<Decoration> {
		const key = [cls ?? '', ...Object.entries(attributes).flat()].join('\n');
		let decoration = lineDecorationCache.get(key);
		if (decoration === undefined) {
			if (lineDecorationCache.size >= LINE_DECORATION_CACHE_SIZE) {
				lineDecorationCache.clear();
			}
			decoration = Decoration.line(cls === undefined ? { attributes } : { class: cls, attributes });
			lineDecorationCache.set(key, decoration);
		}
		return decoration.range(pos);
	}

	/**
	 * Finds the shiki inline code (`{lang} code`) and the fenced code blocks in the window of the parsed part of the document.
	 * Code blocks that only partially overlap the window are returned whole, since they have to be tokenized from the start.
	 */
	function findCode(state: EditorState, window: DocWindow, includeCodeBlocks: boolean): { inlineCodes: InlineCode[]; codeBlocks: FencedCodeBlock[] } {
		const inlineCodes: InlineCode[] = [];
		const codeBlocks: FencedCodeBlock[] = [];
		let openBlock: FencedCodeBlock | undefined;
		let openBlockBegin = 0;
		const livePreview = isLivePreview(state);

		const tree = syntaxTree(state);
		// an unclosed code block goes until the end of the parsed part of the document
		const lastParsedLine = state.doc.lineAt(Math.min(tree.length, state.doc.length)).number;

		// start at the opening fence of a code block that begins above the window and reaches into it
		const iterateFrom = (includeCodeBlocks ? findCodeBlockBeginBefore(tree, window.from) : null) ?? window.from;

		tree.iterate({
			from: iterateFrom,
			to: window.to,
			enter: nodeRef => {
				const name = nodeRef.type.name;

				if (includeCodeBlocks && hasNodeProp(name, CODE_BLOCK_BEGIN)) {
					const line = state.doc.lineAt(nodeRef.from).number;
					if (openBlock?.beginLine !== line) {
						openBlock = { beginLine: line, endLine: null, lastCodeLine: lastParsedLine };
						openBlockBegin = nodeRef.from;
						codeBlocks.push(openBlock);
					}
					return;
				}

				if (includeCodeBlocks && hasNodeProp(name, CODE_BLOCK_END)) {
					if (openBlock !== undefined) {
						openBlock.endLine = state.doc.lineAt(nodeRef.from).number;
						openBlock.lastCodeLine = openBlock.endLine - 1;
						openBlock = undefined;
					}
					return;
				}

				if (hasNodeProp(name, 'formatting') || !hasNodeProp(name, 'inline-code') || !plugin.settings.inlineHighlighting) {
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

		// a code block that begins in the window and ends below it
		if (openBlock !== undefined) {
			const endPos = findCodeBlockEndAfter(tree, window.to, openBlockBegin);
			if (endPos !== null) {
				openBlock.endLine = state.doc.lineAt(endPos).number;
				openBlock.lastCodeLine = openBlock.endLine - 1;
			}
		}

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

	/**
	 * Builds the decorations of the lines of the code block that are in the window.
	 * The whole code block is still tokenized, since tokenizing depends on the lines before.
	 */
	async function buildCodeBlockDecorations(doc: Text, codeBlock: FencedCodeBlock, window: DocWindow): Promise<Range<Decoration>[]> {
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
		const lineInWindow = (i: number): boolean => isLineInWindow(lineStarts[i], lineStarts[i] + codeLines[i].length, window);

		let lineOffset = 0;
		for (let i = 0; i < highlight.tokens.length && i < codeLines.length; i++) {
			if (!lineInWindow(i)) {
				lineOffset += codeLines[i].length + 1;
				continue;
			}
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
			if (fenceLine === null || themeStyle === '') {
				continue;
			}
			const line = doc.line(fenceLine);
			if (isLineInWindow(line.from, line.to, window)) {
				decorations.push(lineDecoration(line.from, undefined, { style: themeStyle }));
			}
		}

		for (let i = 0; i < codeLines.length; i++) {
			if (!lineInWindow(i)) {
				continue;
			}

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

			decorations.push(lineDecoration(doc.line(codeBlock.beginLine + 1 + i).from, classes.join(' '), attributes));
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
		/**
		 * The part of the document the current decorations cover. Only the viewport plus a margin gets decorated.
		 */
		window: DocWindow;
		/**
		 * Incremented by every rebuild, so that a rebuild can tell that a newer one replaced it.
		 */
		generation: number;
		/**
		 * The animation frame of a scheduled rebuild, if any.
		 */
		scheduledRebuild: number | null;

		constructor(view: EditorView) {
			this.view = view;
			this.decorations = Decoration.none;
			this.rebuildPending = false;
			this.window = { from: 0, to: 0 };
			this.generation = 0;
			this.scheduledRebuild = null;
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

			if (update.docChanged) {
				this.window = {
					from: update.changes.mapPos(this.window.from, -1),
					to: update.changes.mapPos(this.window.to, 1),
				};
			}

			// rebuild right away when the decorations are wrong, so that typed text is highlighted without delay
			const needsRebuild = this.rebuildPending || update.docChanged || isLivePreview(update.startState) !== isLivePreview(update.state);
			// these happen a lot while a large note is opened or scrolled, so they are coalesced to one rebuild per frame
			const needsScheduledRebuild =
				// the document is parsed incrementally, so code blocks further down are found later
				syntaxTree(update.startState) !== syntaxTree(update.state) ||
				// the viewport left the decorated part of the document
				(update.viewportChanged && !this.windowCovers(update.view.viewport));

			if (needsRebuild) {
				void this.rebuild(update.view);
			} else if (needsScheduledRebuild) {
				this.scheduleRebuild();
			} else if (update.selectionSet) {
				// the selection only affects whether the language of inline code is hidden
				void this.updateInlineCode(update.view);
			}
		}

		private windowCovers(range: DocWindow): boolean {
			return range.from >= this.window.from && range.to <= this.window.to;
		}

		private scheduleRebuild(): void {
			if (this.scheduledRebuild !== null) {
				return;
			}

			this.scheduledRebuild = requestAnimationFrame(() => {
				this.scheduledRebuild = null;
				void this.rebuild(this.view);
			});
		}

		private cancelScheduledRebuild(): void {
			if (this.scheduledRebuild !== null) {
				cancelAnimationFrame(this.scheduledRebuild);
				this.scheduledRebuild = null;
			}
		}

		/**
		 * Rebuilds the decorations of the viewport and its margin. The old decorations stay until the new ones are ready, to avoid flickering.
		 */
		async rebuild(view: EditorView): Promise<void> {
			// this rebuild covers everything a scheduled one would do
			this.cancelScheduledRebuild();
			const generation = ++this.generation;
			this.rebuildPending = true;
			const state = view.state;
			const window = getDecorationWindow(view);
			const { inlineCodes, codeBlocks } = findCode(state, window, true);

			// The positions are stale if the document changed while we were waiting for the highlighter,
			// in that case the rebuild started by that change takes over. A newer rebuild also takes over.
			const isStale = (): boolean => generation !== this.generation || this.view.state !== state;

			const decorations: Range<Decoration>[] = [];
			try {
				for (const codeBlock of codeBlocks) {
					decorations.push(...(await buildCodeBlockDecorations(state.doc, codeBlock, window)));
					if (isStale()) {
						return;
					}
				}
				for (const inlineCode of inlineCodes) {
					decorations.push(...(await buildInlineDecorations(inlineCode)));
					if (isStale()) {
						return;
					}
				}
			} catch (e) {
				console.error(e);
			}

			if (isStale()) {
				return;
			}

			this.decorations = Decoration.set(decorations, true);
			this.window = window;
			this.rebuildPending = false;
			this.redraw(state);
		}

		/**
		 * Updates only the inline code decorations, which depend on the selection.
		 */
		async updateInlineCode(view: EditorView): Promise<void> {
			const state = view.state;
			const { inlineCodes } = findCode(state, this.window, false);
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
			this.cancelScheduledRebuild();
			// abandons a rebuild that is still waiting for the highlighter
			this.generation++;
			this.decorations = Decoration.none;
		}
	}

	return ViewPlugin.fromClass(Cm6ViewPlugin, {
		decorations: v => v.decorations,
	});
}
