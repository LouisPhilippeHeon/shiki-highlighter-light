import { debounce, loadPrism, Plugin } from 'obsidian';
import { CodeBlock } from 'packages/obsidian/src/CodeBlock';
import { getCodeElementLanguage } from 'packages/obsidian/src/CodeBlockMeta';
import { createCm6Plugin } from 'packages/obsidian/src/codemirror/Cm6_ViewPlugin';
import { DEFAULT_SETTINGS, type Settings } from 'packages/obsidian/src/settings/Settings';
import { ShikiSettingsTab } from 'packages/obsidian/src/settings/SettingsTab';
import { filterHighlightAllPlugin, type PrismWithFilterHighlightAll } from 'packages/obsidian/src/PrismPlugin';
import { CodeHighlighter } from 'packages/obsidian/src/Highlighter';
import { InlineCodeBlock } from 'packages/obsidian/src/InlineCodeBlock';
import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/themes/ThemeMapper';

import 'packages/obsidian/src/styles.css';
import 'virtual:ec-styles.css';
import 'virtual:ec-runtime';

export const SHIKI_INLINE_REGEX = /^\{([^\s]+)\} (.*)/i; // format: `{lang} code`

export default class ShikiPlugin extends Plugin {
	highlighter!: CodeHighlighter;
	activeCodeBlocks!: Map<string, (CodeBlock | InlineCodeBlock)[]>;
	declare settings: Settings;
	loadedSettings!: Settings;
	updateCm6Plugin!: () => Promise<void>;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.loadedSettings = structuredClone(this.settings);
		this.addSettingTab(new ShikiSettingsTab(this));

		this.highlighter = new CodeHighlighter(this);
		// only the custom files are needed to register the code block processors,
		// loading the engines is deferred to not slow down Obsidian's startup, renders wait for them
		await this.highlighter.loadCustomFiles();
		this.app.workspace.onLayoutReady(() => {
			void this.highlighter.loadEngines();
		});

		this.activeCodeBlocks = new Map();

		this.registerInlineCodeProcessor();
		this.registerCodeBlockProcessor();

		this.registerEditorExtension([createCm6Plugin(this)]);

		const debouncedReload = debounce(
			() => {
				void this.reloadHighlighter();
			},
			500,
			true,
		);

		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				debouncedReload();
			}),
		);

		this.addCommand({
			id: 'reload-highlighter',
			name: 'Reload highlighter',
			callback: () => {
				void this.reloadHighlighter();
			},
		});

		void this.registerPrismPlugin();
	}

	async reloadHighlighter(): Promise<void> {
		await this.highlighter.unload();

		this.loadedSettings = structuredClone(this.settings);

		await this.highlighter.load();

		for (const [_, codeBlocks] of this.activeCodeBlocks) {
			for (const codeBlock of codeBlocks) {
				await codeBlock.forceRerender();
			}
		}

		await this.updateCm6Plugin();
	}

	async registerPrismPlugin(): Promise<void> {
		const prism = (await loadPrism()) as PrismWithFilterHighlightAll;
		const filterHighlightAll = filterHighlightAllPlugin(prism);
		filterHighlightAll?.reject.addSelector('div.expressive-code pre code');
	}

	/**
	 * Highlights the code blocks of rendered markdown, e.g. in reading mode or PDF export.
	 * In the editor, Obsidian's native code blocks are kept and highlighted by the editor extension instead.
	 */
	registerCodeBlockProcessor(): void {
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const renders: Promise<void>[] = [];

			for (const codeEl of el.findAll('pre > code')) {
				const preEl = codeEl.parentElement!;
				// we need to avoid making the hidden frontmatter code block visible
				if (preEl.classList.contains('frontmatter') || preEl.closest('.mod-frontmatter') !== null) {
					continue;
				}

				const language = getCodeElementLanguage(codeEl)?.toLowerCase();
				if (language === undefined || !this.highlighter.isLanguageEnabled(language)) {
					continue;
				}

				// Obsidian keeps the trailing newline of the code block in the code element
				const source = (codeEl.textContent ?? '').replace(/\n$/, '');
				const codeBlock = new CodeBlock(this, el, preEl, source, language, ctx);
				ctx.addChild(codeBlock);

				renders.push(
					codeBlock.render().catch((e: unknown) => {
						console.error(`Failed to render ${language} code block.`, e);
					}),
				);
			}

			// returning the promise lets Obsidian wait for the code blocks, e.g. when exporting to PDF
			await Promise.all(renders);
		});
	}

	registerInlineCodeProcessor(): void {
		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const inlineCodes = el.findAll(':not(pre) > code');
			for (const codeElm of inlineCodes) {
				const match = SHIKI_INLINE_REGEX.exec(codeElm.textContent ?? ''); // format: `{lang} code`
				if (!match) {
					continue;
				}

				const codeBlock = new InlineCodeBlock(this, codeElm, match[2], match[1], ctx);

				ctx.addChild(codeBlock);
			}
		});
	}

	onunload(): void {
		void this.highlighter.unload();
	}

	addActiveCodeBlock(codeBlock: CodeBlock | InlineCodeBlock): void {
		const filePath = codeBlock.ctx.sourcePath;

		if (!this.activeCodeBlocks.has(filePath)) {
			this.activeCodeBlocks.set(filePath, [codeBlock]);
		} else {
			this.activeCodeBlocks.get(filePath)!.push(codeBlock);
		}
	}

	removeActiveCodeBlock(codeBlock: CodeBlock | InlineCodeBlock): void {
		const filePath = codeBlock.ctx.sourcePath;

		if (this.activeCodeBlocks.has(filePath)) {
			const index = this.activeCodeBlocks.get(filePath)!.indexOf(codeBlock);
			if (index !== -1) {
				this.activeCodeBlocks.get(filePath)!.splice(index, 1);
			}
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as Settings;

		// code block frames are no longer supported
		delete (this.settings as unknown as Record<string, unknown>).ecDefaultFrame;

		// bundled shiki themes are no longer included, so fall back to the default theme for anything that is not a custom theme
		if (this.settings.darkTheme !== OBSIDIAN_THEME_IDENTIFIER && !this.settings.darkTheme.endsWith('.json')) {
			this.settings.darkTheme = DEFAULT_SETTINGS.darkTheme;
		}
		if (this.settings.lightTheme !== OBSIDIAN_THEME_IDENTIFIER && !this.settings.lightTheme.endsWith('.json')) {
			this.settings.lightTheme = DEFAULT_SETTINGS.lightTheme;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
