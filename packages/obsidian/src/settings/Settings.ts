import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/themes/ThemeMapper';

export interface Settings {
	disabledLanguages: string[];
	customThemeFolder: string;
	customLanguageFolder: string;
	darkTheme: string;
	lightTheme: string;
	preferThemeColors: boolean;
	inlineHighlighting: boolean;
	ecDefaultShowLineNumbers: boolean;
	ecDefaultWrap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	disabledLanguages: [],
	customThemeFolder: '',
	customLanguageFolder: '',
	darkTheme: OBSIDIAN_THEME_IDENTIFIER,
	lightTheme: OBSIDIAN_THEME_IDENTIFIER,
	preferThemeColors: true,
	inlineHighlighting: true,
	ecDefaultShowLineNumbers: false,
	ecDefaultWrap: false,
};
