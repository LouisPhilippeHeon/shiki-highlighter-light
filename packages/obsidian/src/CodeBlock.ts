import { type MarkdownPostProcessorContext, MarkdownRenderChild, setIcon } from 'obsidian';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { findMetaStringInText } from 'packages/obsidian/src/CodeBlockMeta';

/**
 * A code block in reading mode (and in other rendered markdown, e.g. embeds and PDF export).
 * Obsidian renders the code block as a `<pre>` element, which gets replaced with the Expressive Code output once it is rendered.
 * In the editor, code blocks are left to Obsidian and only get their highlighting from the editor extension.
 */
export class CodeBlock extends MarkdownRenderChild {
	plugin: ShikiPlugin;
	preEl: HTMLElement;
	source: string;
	language: string;
	ctx: MarkdownPostProcessorContext;
	metaString: string | undefined;

	/**
	 * @param plugin
	 * @param containerEl the element of the markdown section that contains the code block
	 * @param preEl Obsidian's `<pre>` element of the code block, it stays in place until the highlighted code block replaces it
	 * @param source
	 * @param language
	 * @param ctx
	 */
	constructor(plugin: ShikiPlugin, containerEl: HTMLElement, preEl: HTMLElement, source: string, language: string, ctx: MarkdownPostProcessorContext) {
		super(containerEl);

		this.plugin = plugin;
		this.preEl = preEl;
		this.source = source;
		this.language = language;
		this.ctx = ctx;
	}

	private async getMetaString(): Promise<string> {
		const sectionInfo = this.ctx.getSectionInfo(this.containerEl);

		if (sectionInfo !== null) {
			// the section can contain more than just the code block, e.g. when the code block is in a list or callout
			const sectionText = sectionInfo.text
				.split('\n')
				.slice(sectionInfo.lineStart, sectionInfo.lineEnd + 1)
				.join('\n');
			const metaString = findMetaStringInText(sectionText, this.source, this.language);
			if (metaString !== null) {
				return metaString;
			}
		}

		// no section info is available e.g. when exporting to PDF, so we look for the code block in the source file
		const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
		if (file === null) {
			return '';
		}

		const text = await this.plugin.app.vault.cachedRead(file);
		return findMetaStringInText(text, this.source, this.language) ?? '';
	}

	public async render(): Promise<void> {
		this.metaString ??= await this.getMetaString();

		const rendered = createDiv({ cls: 'shiki-code-block' });
		await this.plugin.highlighter.renderWithEc(this.source, this.language, this.metaString, rendered);

		const copyButton = rendered.createEl('button', { cls: 'shiki-copy-button', attr: { 'aria-label': 'Copy' } });
		setIcon(copyButton, 'copy');
		copyButton.addEventListener('click', () => {
			void navigator.clipboard.writeText(this.source).then(() => {
				setIcon(copyButton, 'check');
				window.setTimeout(() => setIcon(copyButton, 'copy'), 1500);
			});
		});

		this.preEl.replaceWith(rendered);
		this.preEl = rendered;
	}

	public async forceRerender(): Promise<void> {
		await this.render();
	}

	public onload(): void {
		super.onload();

		this.plugin.addActiveCodeBlock(this);
	}

	public onunload(): void {
		super.onunload();

		this.plugin.removeActiveCodeBlock(this);
	}
}
