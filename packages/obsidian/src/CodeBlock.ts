import { EditorView } from '@codemirror/view';
import { type MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type ShikiPlugin from 'packages/obsidian/src/main';

/**
 * Returns the text after the code block language on the opening fence line, or null if the line is not an opening fence for that language.
 */
export function parseMetaString(fenceLine: string, language: string): string | null {
	// regexp to match the text after the code block language
	const regex = new RegExp('^[^`~]*?\\s*(```+|~~~+)' + language + ' (.*)', 'g');
	const match = regex.exec(fenceLine);
	return match !== null ? match[2] : null;
}

/**
 * Finds the code block with the given language and content in a markdown text and returns its meta string.
 * Returns the meta string of the first match, or null if no code block matches.
 */
export function findMetaStringInText(text: string, source: string, language: string): string | null {
	const lines = text.split('\n').map(line => line.replace(/\r$/, ''));

	for (let i = 0; i < lines.length; i++) {
		const metaString = parseMetaString(lines[i], language);
		if (metaString === null) {
			continue;
		}

		const fence = /^([^`~]*?\s*)(```+|~~~+)/.exec(lines[i])!;
		// the prefix of the fence line, e.g. "> " for code blocks in callouts
		const prefix = fence[1].replace(/\s+$/, '');
		const closingFence = new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`);

		const content: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			let line = lines[j];
			if (prefix !== '' && line.startsWith(prefix)) {
				line = line.slice(prefix.length).replace(/^ /, '');
			}

			if (closingFence.test(line)) {
				if (content.join('\n').trim() === source.trim()) {
					return metaString;
				}
				break;
			}

			content.push(line);
		}
	}

	return null;
}

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

	private async getMetaString(): Promise<string> {
		const sectionInfo = this.ctx.getSectionInfo(this.containerEl);

		if (sectionInfo !== null) {
			const lines = sectionInfo.text.split('\n');
			return parseMetaString(lines[sectionInfo.lineStart], this.language) ?? '';
		}

		// no section info is available when exporting to PDF, so we look for the code block in the source file
		const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
		if (file === null) {
			return '';
		}

		const text = await this.plugin.app.vault.cachedRead(file);
		return findMetaStringInText(text, this.source, this.language) ?? '';
	}

	private async render(metaString: string): Promise<void> {
		await this.plugin.highlighter.renderWithEc(this.source, this.language, metaString, this.containerEl);
	}

	public async rerenderOnNoteChange(): Promise<void> {
		// compare the new meta string to the cached one
		// only rerender if they are different, to avoid unnecessary work
		// since the meta string is likely to be the same most of the time
		// and if the code block content changes obsidian will rerender for us
		const newMetaString = await this.getMetaString();
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
		const pos = Math.min(docLine.from + column, docLine.to);

		event.preventDefault();
		event.stopPropagation();

		if (event.clientY < lines[0].getBoundingClientRect().top) {
			view.dispatch({ selection: { anchor: pos - lineLength - 1 }, scrollIntoView: false });
			return;
		} else if (event.clientY > lines[lines.length - 1].getBoundingClientRect().bottom) {
			const lineBelowCodeBlock = this.containerEl.closest<HTMLElement>('.cm-preview-code-block')?.nextElementSibling;
			if (lineBelowCodeBlock) {
				view.dispatch({ selection: { anchor: doc.lineAt(view.posAtDOM(lineBelowCodeBlock)).from - 1 }, scrollIntoView: false });
			}

			return;
		}

		view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
	}

	public onload(): void {
		super.onload();

		this.plugin.addActiveCodeBlock(this);

		this.registerDomEvent(this.containerEl, 'mousedown', event => this.onMouseDown(event), { capture: true });

		void this.getMetaString().then(metaString => {
			this.cachedMetaString = metaString;
			return this.render(metaString);
		});
	}

	public onunload(): void {
		super.onunload();

		this.plugin.removeActiveCodeBlock(this);

		this.containerEl.empty();
		this.containerEl.innerText = 'unloaded shiki code block';
	}
}
