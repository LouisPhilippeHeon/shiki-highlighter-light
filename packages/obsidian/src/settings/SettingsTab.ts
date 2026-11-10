import type { ExtraButtonComponent, SettingDefinitionItem } from 'obsidian';
import { PluginSettingTab, Platform, Notice, normalizePath } from 'obsidian';
import type ShikiPlugin from 'packages/obsidian/src/main';
import type { Settings } from 'packages/obsidian/src/settings/Settings';
import { StringSelectModal } from 'packages/obsidian/src/settings/StringSelectModal';
import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/themes/ThemeMapper';

type SettingsKey = keyof Settings;

export class ShikiSettingsTab extends PluginSettingTab {
	plugin: ShikiPlugin;

	constructor(plugin: ShikiPlugin) {
		super(plugin.app, plugin);

		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
		const customThemes = Object.fromEntries(this.plugin.highlighter.customThemes.map(theme => [theme.name, `${theme.displayName} (${theme.type})`]));
		const themes = {
			[OBSIDIAN_THEME_IDENTIFIER]: 'Obsidian built-in (both)',
			...customThemes,
		};

		return [
			{
				name: 'All setting changes require a reload of the highlighter',
				render: (setting): void => {
					setting.addButton(button => {
						button
							.setCta()
							.setButtonText('Reload Highlighter')
							.onClick(async () => {
								button.setDisabled(true);
								await this.plugin.reloadHighlighter();
								button.setDisabled(false);
							});
					});
				},
			},
			{
				name: 'Inline Syntax Highlighting',
				desc: 'Enables syntax highlighting for inline code blocks via `{lang} code`.',
				control: { type: 'toggle', key: 'inlineHighlighting' },
			},
			{
				type: 'group',
				heading: 'Code block defaults',
				items: [
					{
						name: 'Show line numbers',
						desc: 'Controls whether line numbers are shown by default.',
						control: { type: 'toggle', key: 'ecDefaultShowLineNumbers' },
					},
					{
						name: 'Wrap',
						desc: 'Controls whether code block lines wrap by default in reading mode. In the editor, code blocks follow the editor line wrapping.',
						control: { type: 'toggle', key: 'ecDefaultWrap' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Theme',
				extraButtons: this.openFolderButtons('customThemeFolder', 'Open custom themes folder'),
				items: [
					{
						name: 'Dark theme',
						desc: "The theme for code blocks when Obsidian's base color scheme is dark.",
						control: { type: 'dropdown', key: 'darkTheme', options: themes },
					},
					{
						name: 'Light theme',
						desc: "The theme for code blocks when Obsidian's base color scheme is light.",
						control: { type: 'dropdown', key: 'lightTheme', options: themes },
					},
					{
						name: 'Custom themes folder location',
						desc: 'Folder relative to your Vault where custom JSON theme files are located.',
						control: { type: 'folder', key: 'customThemeFolder' },
					},
					{
						name: 'Prefer theme colors',
						desc: 'When enabled the plugin will prefer theme colors over CSS variables for things like the code block background.',
						control: { type: 'toggle', key: 'preferThemeColors' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Languages',
				extraButtons: this.openFolderButtons('customLanguageFolder', 'Open custom languages folder'),
				items: [
					{
						name: 'Custom languages folder location',
						desc: 'Folder relative to your Vault where custom JSON language files are located.',
						control: { type: 'folder', key: 'customLanguageFolder' },
					},
				],
			},
			{
				type: 'list',
				heading: 'Excluded Languages',
				emptyState: 'No languages are excluded.',
				addItem: {
					name: 'Add Language Rule',
					action: (): void => {
						const modal = new StringSelectModal(this.plugin, this.plugin.highlighter.supportedLanguages, language => {
							if (!this.plugin.settings.disabledLanguages.includes(language)) {
								this.plugin.settings.disabledLanguages.push(language);
							}
							void this.plugin.saveSettings();
							this.update();
						});
						modal.open();
					},
				},
				onDelete: (index): void => {
					this.plugin.settings.disabledLanguages.splice(index, 1);
					void this.plugin.saveSettings();
					this.update();
				},
				items: this.plugin.settings.disabledLanguages.map(language => ({ name: language })),
			},
		];
	}

	private openFolderButtons(key: 'customThemeFolder' | 'customLanguageFolder', tooltip: string): ((button: ExtraButtonComponent) => void)[] {
		if (!Platform.isDesktopApp) {
			return [];
		}

		return [
			(button): void => {
				button
					.setIcon('folder-open')
					.setTooltip(tooltip)
					.onClick(async () => {
						const folder = normalizePath(this.plugin.settings[key]);
						if (await this.app.vault.adapter.exists(folder)) {
							this.app.openWithDefaultApp(folder);
						} else {
							new Notice(`Unable to open folder: ${folder}`, 5000);
						}
					});
			},
		];
	}
}
