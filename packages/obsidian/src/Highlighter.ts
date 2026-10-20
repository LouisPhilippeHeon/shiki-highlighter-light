import { ExpressiveCodeEngine } from '@expressive-code/core';
import type ShikiPlugin from 'packages/obsidian/src/main';
import { type LanguageRegistration, type HighlighterCore, type TokensResult, type ThemedToken } from 'shiki/core';
import { createHighlighter } from 'packages/obsidian/src/shikiLight';
import { ThemeMapper } from 'packages/obsidian/src/themes/ThemeMapper';
import { normalizePath, Notice } from 'obsidian';
import { DEFAULT_SETTINGS } from 'packages/obsidian/src/settings/Settings';
import { toDom } from 'hast-util-to-dom';
import { createEcEngineConfig } from 'packages/ec-core/src/Config';
import BUNDLED_LANGUAGE_ALIASES from 'virtual:shiki-lang-aliases';

interface CustomTheme {
	name: string;
	displayName: string;
	type: string;
	colors?: Record<string, unknown>[];
	tokenColors?: Record<string, unknown>[];
}

// some languages break obsidian's `registerMarkdownCodeBlockProcessor`, so we blacklist them
const LANGUAGE_BLACKLIST = new Set(['c++', 'c#', 'f#', 'mermaid']);

// some languages are considered "special" by shiki.isSpecialLang
const LANGUAGE_SPECIAL = new Set(['plaintext', 'txt', 'text', 'plain', 'ansi']);

export class CodeHighlighter {
	plugin: ShikiPlugin;
	themeMapper: ThemeMapper;

	ec!: ExpressiveCodeEngine;
	ecStyleElement: HTMLElement | undefined;
	supportedLanguages!: string[];
	shiki!: HighlighterCore;
	customThemes!: CustomTheme[];
	customLanguages!: LanguageRegistration[];

	// the custom theme and language files, which are cheap to load and needed to register the code block processors
	private customFilesLoading: Promise<void> | undefined;
	// EC and shiki, which are expensive to load (shiki compiles its WASM engine), so their loading can be deferred
	private enginesLoading: Promise<void> | undefined;
	// settles once the engines are loaded, renders started before that wait on it
	private enginesReady!: Promise<void>;
	private settleEnginesReady!: { resolve: () => void; reject: (reason: unknown) => void };

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;
		this.themeMapper = new ThemeMapper(this.plugin);
		this.resetEnginesReady();
	}

	/**
	 * Loads everything, including the engines.
	 */
	async load(): Promise<void> {
		await this.loadCustomFiles();
		await this.loadEngines();
	}

	/**
	 * Loads the custom themes and languages. After this, the supported languages and custom themes are known.
	 */
	loadCustomFiles(): Promise<void> {
		this.customFilesLoading = (async (): Promise<void> => {
			await Promise.all([this.loadCustomThemes(), this.loadCustomLanguages()]);

			this.supportedLanguages = [...LANGUAGE_SPECIAL, ...this.customLanguages.flatMap(i => [i.name, ...(i.aliases ?? [])])];
		})();

		return this.customFilesLoading;
	}

	/**
	 * Loads EC and shiki, unless they are already loaded or loading.
	 */
	loadEngines(): Promise<void> {
		this.enginesLoading ??= (async (): Promise<void> => {
			// captured, since an unload during loading already replaces it for the next load
			const settleEnginesReady = this.settleEnginesReady;
			try {
				await this.customFilesLoading;
				await this.loadEC();
				await this.loadShiki();
				settleEnginesReady.resolve();
			} catch (e) {
				settleEnginesReady.reject(e);
				throw e;
			}
		})();

		return this.enginesLoading;
	}

	async unload(): Promise<void> {
		const enginesLoading = this.enginesLoading;
		if (enginesLoading === undefined) {
			// the engines were never loaded, renders waiting on them keep waiting for the next load
			return;
		}

		this.enginesLoading = undefined;
		this.resetEnginesReady();

		try {
			await enginesLoading;
		} catch {
			// the error was already reported to the renders waiting on the engines
		}

		this.unloadEC();
		this.unloadShiki();
	}

	private resetEnginesReady(): void {
		this.enginesReady = new Promise((resolve, reject) => {
			this.settleEnginesReady = { resolve, reject };
		});
		// a load error is also thrown by `loadEngines`, so it does not need to be reported when nothing is rendering yet
		this.enginesReady.catch(() => {});
	}

	async loadCustomLanguages(): Promise<void> {
		this.customLanguages = [];

		if (!this.plugin.loadedSettings.customLanguageFolder) return;

		const languageFolder = normalizePath(this.plugin.loadedSettings.customLanguageFolder);
		if (!(await this.plugin.app.vault.adapter.exists(languageFolder))) {
			new Notice(`${this.plugin.manifest.name}\nUnable to open custom languages folder: ${languageFolder}`, 5000);
			return;
		}

		const languageList = await this.plugin.app.vault.adapter.list(languageFolder);
		const languageFiles = languageList.files.filter(f => f.toLowerCase().endsWith('.json'));

		for (const languageFile of languageFiles) {
			try {
				const language = JSON.parse(await this.plugin.app.vault.adapter.read(languageFile)) as LanguageRegistration;
				// validate that language file JSON can be parsed and contains at a minimum a scopeName
				if (!language.name) {
					throw Error('Invalid JSON language file is missing a name property.');
				}

				// keep the aliases the bundled shiki language of the same name had (e.g. `ts` for `typescript`)
				const aliases = new Set([...(language.aliases ?? []), ...(BUNDLED_LANGUAGE_ALIASES[language.name] ?? [])]);
				aliases.delete(language.name);
				language.aliases = [...aliases];

				this.customLanguages.push(language);
			} catch (e) {
				new Notice(`${this.plugin.manifest.name}\nUnable to load custom language: ${languageFile}`, 5000);
				console.warn(`Unable to load custom language: ${languageFile}`, e);
			}
		}
	}

	async loadCustomThemes(): Promise<void> {
		const activeTheme = this.themeMapper.getThemeIdentifier();
		this.customThemes = [];

		// custom themes are disabled unless users specify a folder for them in plugin settings
		if (!this.plugin.loadedSettings.customThemeFolder) return;

		const themeFolder = normalizePath(this.plugin.loadedSettings.customThemeFolder);
		if (!(await this.plugin.app.vault.adapter.exists(themeFolder))) {
			new Notice(`${this.plugin.manifest.name}\nUnable to open custom themes folder: ${themeFolder}`, 5000);
			return;
		}

		const themeList = await this.plugin.app.vault.adapter.list(themeFolder);
		const themeFiles = themeList.files.filter(f => f.toLowerCase().endsWith('.json'));

		for (const themeFile of themeFiles) {
			const baseName = themeFile.substring(`${themeFolder}/`.length);
			try {
				const theme = JSON.parse(await this.plugin.app.vault.adapter.read(themeFile)) as CustomTheme;
				// validate that theme file JSON can be parsed and contains colors at a minimum
				if (!theme.colors && !theme.tokenColors) {
					throw Error('Invalid JSON theme file.');
				}
				// what metadata is available in the theme file depends on how it was created
				theme.displayName = theme.displayName ?? theme.name ?? baseName;
				theme.name = baseName.toLowerCase();
				theme.type = theme.type ?? 'both';

				this.customThemes.push(theme);
			} catch (e) {
				new Notice(`${this.plugin.manifest.name}\nUnable to load custom theme: ${themeFile}`, 5000);
				console.warn(`Unable to load custom theme: ${themeFile}`, e);
			}
		}

		// if the user's set theme cannot be loaded (e.g. it was deleted), fall back to default theme
		if (this.themeMapper.usingCustomTheme() && !this.customThemes.find(theme => theme.name === activeTheme)) {
			// ony reset the theme that's currently broken
			if (activeTheme == this.plugin.loadedSettings.darkTheme) {
				this.plugin.settings.darkTheme = DEFAULT_SETTINGS.darkTheme;
				this.plugin.loadedSettings.darkTheme = DEFAULT_SETTINGS.darkTheme;
			} else if (activeTheme == this.plugin.loadedSettings.lightTheme) {
				this.plugin.settings.lightTheme = DEFAULT_SETTINGS.lightTheme;
				this.plugin.loadedSettings.lightTheme = DEFAULT_SETTINGS.lightTheme;
			}

			await this.plugin.saveSettings();
		}

		this.customThemes.sort((a, b) => a.displayName.localeCompare(b.displayName));
	}

	async loadEC(): Promise<void> {
		this.ec = new ExpressiveCodeEngine(
			createEcEngineConfig({
				theme: await this.themeMapper.getThemeForEC(),
				customLanguages: this.customLanguages,
				settings: this.plugin.loadedSettings,
				usingObsidianTheme: this.themeMapper.usingObsidianTheme(),
			}),
		);

		if (this.ecStyleElement) {
			this.ecStyleElement.remove();
			this.ecStyleElement = undefined;
		}

		// Since they come directly from EC, and depend on runtime settings/theme selection, there is no other way than to attach them dynamically.
		// Note that the static EC styles and scripts are bundled with the plugin and don't need to be loaded like this.
		const themeStyles = await this.ec.getThemeStyles();
		this.ecStyleElement = document.head.createEl('style', { text: themeStyles });
	}

	unloadEC(): void {
		if (this.ecStyleElement) {
			this.ecStyleElement.remove();
			this.ecStyleElement = undefined;
		}
	}

	async loadShiki(): Promise<void> {
		this.shiki = await createHighlighter({
			themes: [await this.themeMapper.getTheme()],
			langs: this.customLanguages,
		});
	}

	unloadShiki(): void {
		this.shiki?.dispose();
	}

	/**
	 * All languages that are safe to use with Obsidian's `registerMarkdownCodeBlockProcessor`.
	 */
	obsidianSafeLanguageNames(): string[] {
		return this.supportedLanguages.filter(lang => !LANGUAGE_BLACKLIST.has(lang) && !this.plugin.loadedSettings.disabledLanguages.includes(lang));
	}

	/**
	 * Highlights code with EC and renders it to the passed container element.
	 */
	async renderWithEc(code: string, language: string, meta: string, container: HTMLElement): Promise<void> {
		await this.enginesReady;

		const result = await this.ec.render({
			code,
			language,
			meta,
		});

		container.empty();
		container.append(toDom(this.themeMapper.fixAST(result.renderedGroupAst)));
	}

	async getHighlightTokens(code: string, lang: string): Promise<TokensResult | undefined> {
		if (!this.obsidianSafeLanguageNames().includes(lang)) {
			return undefined;
		}

		await this.enginesReady;

		return this.shiki.codeToTokens(code, {
			lang,
			theme: this.themeMapper.getThemeIdentifier(),
		});
	}

	renderTokens(tokens: ThemedToken[], parent: HTMLElement): void {
		for (const token of tokens) {
			this.tokenToSpan(token, parent);
		}
	}

	tokenToSpan(token: ThemedToken, parent: HTMLElement): void {
		const tokenStyle = this.getTokenStyle(token);
		parent.createSpan({
			text: token.content,
			cls: tokenStyle.classes.join(' '),
			attr: { style: tokenStyle.style },
		});
	}

	getTokenStyle(token: ThemedToken): { style: string; classes: string[] } {
		const fontStyle = token.fontStyle ?? 0;

		return {
			style: `color: ${token.color}`,
			classes: [
				(fontStyle & 1) !== 0 ? 'shiki-italic' : undefined,
				(fontStyle & 2) !== 0 ? 'shiki-bold' : undefined,
				(fontStyle & 4) !== 0 ? 'shiki-ul' : undefined,
			].filter(Boolean) as string[],
		};
	}
}
