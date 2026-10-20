import { EditorView } from '@codemirror/view';
import { type MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type ShikiPlugin from 'packages/obsidian/src/main';

export class CodeBlock extends MarkdownRenderChild {
	plugin: ShikiPlugin;
	source: string;
	language: string;
	ctx: MarkdownPostProcessorContext;
	cachedMetaString: string;

	constructor(plugin: ShikiPlugin, containerEl: HTMLElement, source: string, language: string, ctx: MarkdownPostProcessorContext) {
		super(containerEl);

		this.plugin = plugin;
		this.source = source;
		this.language = language;
		this.ctx = ctx;
		this.cachedMetaString = '';
	}

	private getMetaString(): string {
		const sectionInfo = this.ctx.getSectionInfo(this.containerEl);

		if (sectionInfo === null) {
			return '';
		}

		const lines = sectionInfo.text.split('\n');
		const startLine = lines[sectionInfo.lineStart];

		// regexp to match the text after the code block language
		const regex = new RegExp('^[^`~]*?\\s*(```+|~~~+)' + this.language + ' (.*)', 'g');
		const match = regex.exec(startLine);
		if (match !== null) {
			return match[2];
		} else {
			return '';
		}
	}

	private async render(metaString: string): Promise<void> {
		await this.plugin.highlighter.renderWithEc(this.source, this.language, metaString, this.containerEl);
	}

	public async rerenderOnNoteChange(): Promise<void> {
		// compare the new meta string to the cached one
		// only rerender if they are different, to avoid unnecessary work
		// since the meta string is likely to be the same most of the time
		// and if the code block content changes obsidian will rerender for us
		const newMetaString = this.getMetaString();
		if (newMetaString !== this.cachedMetaString) {
			this.cachedMetaString = newMetaString;
			await this.render(newMetaString);
		}
	}

	public async forceRerender(): Promise<void> {
		await this.render(this.cachedMetaString);
	}

	/**
	 * Gets the caret position (text node and offset) at the given screen coordinates.
	 */
	private getCaretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
		if (typeof document.caretPositionFromPoint === 'function') {
			const pos = document.caretPositionFromPoint(x, y);
			return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
		}
		const range = document.caretRangeFromPoint(x, y);
		return range ? { node: range.startContainer, offset: range.startOffset } : null;
	}

	/**
	 * In live preview, clicking on the rendered code block moves the editor cursor to the clicked position,
	 * similar to how Obsidian's native code blocks behave.
	 */
	private onMouseDown(event: MouseEvent): void {
		if (event.button !== 0 || event.defaultPrevented) {
			return;
		}

		// keep the copy button and collapsible sections working
		const target = event.target as HTMLElement | null;
		if (target?.closest('button, summary, a') != null) {
			return;
		}

		// findFromDOM only searches downwards, so it needs the editor root element
		const editorEl = this.containerEl.closest<HTMLElement>('.cm-editor');
		const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
		if (view === null) {
			return;
		}

		const lines = Array.from(this.containerEl.querySelectorAll<HTMLElement>('.ec-line'));
		if (lines.length === 0) {
			return;
		}

		// find the line closest to the click vertically
		let lineIndex = lines.length - 1;
		for (let i = 0; i < lines.length; i++) {
			if (event.clientY < lines[i].getBoundingClientRect().bottom) {
				lineIndex = i;
				break;
			}
		}

		const lineEl = lines[lineIndex];
		const codeEl = lineEl.querySelector<HTMLElement>('.code') ?? lineEl;
		const lineLength = codeEl.textContent?.length ?? 0;

		let column: number;
		const caret = this.getCaretAtPoint(event.clientX, event.clientY);
		if (caret !== null && codeEl.contains(caret.node)) {
			const range = document.createRange();
			range.setStart(codeEl, 0);
			range.setEnd(caret.node, caret.offset);
			column = range.toString().length;
		} else {
			column = event.clientX < codeEl.getBoundingClientRect().left ? 0 : lineLength;
		}

		const doc = view.state.doc;
		let fenceLine;
		try {
			fenceLine = doc.lineAt(view.posAtDOM(this.containerEl));
		} catch {
			return;
		}

		const docLineNumber = fenceLine.number + 1 + lineIndex;
		if (docLineNumber > doc.lines) {
			return;
		}
		const docLine = doc.line(docLineNumber);

		// account for prefixes such as list indentation or `> ` in callouts and blockquotes
		const prefixLength = Math.max(0, fenceLine.text.search(/```|~~~/));
		const pos = Math.min(docLine.from + Math.min(prefixLength, docLine.length) + column, docLine.to);

		event.preventDefault();
		event.stopPropagation();

		view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		view.focus();
	}

	public onload(): void {
		super.onload();

		this.plugin.addActiveCodeBlock(this);

		this.registerDomEvent(this.containerEl, 'mousedown', event => this.onMouseDown(event), { capture: true });

		this.cachedMetaString = this.getMetaString();
		void this.render(this.cachedMetaString);
	}

	public onunload(): void {
		super.onunload();

		this.plugin.removeActiveCodeBlock(this);

		this.containerEl.empty();
		this.containerEl.innerText = 'unloaded shiki code block';
	}
}
