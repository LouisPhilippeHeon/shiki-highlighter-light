import { ExpressiveCodeTheme, type ExpressiveCodeEngineConfig } from '@expressive-code/core';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';
import { pluginTextMarkers } from '@expressive-code/plugin-text-markers';
import { type HighlighterCore, type ThemeRegistration } from 'shiki/core';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths -- needed for vite to load this correctly
import { getECTheme } from './ECTheme';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths -- needed for vite to load this correctly
import { pluginSharedShiki } from './SharedShikiPlugin';

export interface EcSettingsProps {
	preferThemeColors: boolean;
	ecDefaultShowLineNumbers: boolean;
	ecDefaultWrap: boolean;
}

export interface EcConfigInput {
	theme: ThemeRegistration;
	/**
	 * Returns the highlighter with the languages loaded, it is only called while rendering code blocks.
	 */
	getHighlighter: () => HighlighterCore | undefined;
	settings: EcSettingsProps;
	usingObsidianTheme: boolean;
}

export interface CssVariableThemeBundle {
	theme: ThemeRegistration;
	restoreCssVariables: (css: string) => string;
}

export const EC_VIRTUAL_SETTINGS: EcSettingsProps = {
	preferThemeColors: true,
	ecDefaultShowLineNumbers: false,
	ecDefaultWrap: false,
};

export function createCssVariableThemeBundle(theme: ThemeRegistration): CssVariableThemeBundle {
	const cssVarToPlaceholder = new Map<string, string>();
	let placeholderCounter = 0;

	const toPlaceholder = (value: string): string => {
		if (!value.trim().startsWith('var(')) {
			return value;
		}

		const existing = cssVarToPlaceholder.get(value);
		if (existing) {
			return existing;
		}

		const placeholder = `#${placeholderCounter.toString(16).padStart(6, '0').toUpperCase()}`;
		placeholderCounter += 1;
		cssVarToPlaceholder.set(value, placeholder);
		return placeholder;
	};

	const mapThemeTokenColor = <T extends { settings?: { foreground?: string; background?: string } }>(token: T): T => {
		if (!token.settings) {
			return token;
		}

		return {
			...token,
			settings: {
				...token.settings,
				foreground: token.settings.foreground ? toPlaceholder(token.settings.foreground) : token.settings.foreground,
				background: token.settings.background ? toPlaceholder(token.settings.background) : token.settings.background,
			},
		};
	};

	const mappedTheme: ThemeRegistration = {
		...theme,
		colors: Object.fromEntries(Object.entries(theme.colors ?? {}).map(([key, value]) => [key, toPlaceholder(value)])),
		tokenColors: (theme.tokenColors ?? []).map(mapThemeTokenColor),
	};

	return {
		theme: mappedTheme,
		restoreCssVariables: (css: string): string => {
			let output = css;
			for (const [cssVar, placeholder] of cssVarToPlaceholder) {
				output = output.replaceAll(placeholder, cssVar);
			}
			return output;
		},
	};
}

export function createEcEngineConfig(input: EcConfigInput): ExpressiveCodeEngineConfig {
	const useThemeColors = input.settings.preferThemeColors && !input.usingObsidianTheme;

	return {
		themes: [new ExpressiveCodeTheme(input.theme)],
		plugins: [pluginSharedShiki(input.getHighlighter), pluginCollapsibleSections(), pluginTextMarkers(), pluginLineNumbers()],
		styleOverrides: getECTheme(useThemeColors),
		minSyntaxHighlightingColorContrast: 0,
		themeCssRoot: 'div.expressive-code',
		defaultProps: {
			showLineNumbers: input.settings.ecDefaultShowLineNumbers,
			wrap: input.settings.ecDefaultWrap,
		},
	};
}
