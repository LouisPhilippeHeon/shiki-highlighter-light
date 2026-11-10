import { type ThemeRegistration } from 'shiki/core';
import type * as hast_types from 'hast';
import { OBSIDIAN_THEME } from 'packages/ec-core/src/ObsidianTheme';
import type ShikiPlugin from 'packages/obsidian/src/main';

export const OBSIDIAN_THEME_IDENTIFIER = 'obsidian-theme';

// the placeholder colors created by `mapColor`
const PLACEHOLDER_COLOR_REGEX = /#[0-9A-F]{6}/g;

export class ThemeMapper {
	plugin: ShikiPlugin;
	mapCounter: number;
	mapping: Map<string, string>;
	/**
	 * The reverse of `mapping`, from placeholder color to the original color or CSS variable.
	 */
	reverseMapping: Map<string, string>;

	constructor(plugin: ShikiPlugin) {
		this.plugin = plugin;

		this.mapCounter = 0;
		this.mapping = new Map();
		this.reverseMapping = new Map();
	}

	async getThemeForEC(): Promise<ThemeRegistration> {
		const activeTheme = this.getThemeIdentifier();

		if (this.usingCustomTheme()) {
			return this.plugin.highlighter.customThemes.find(theme => theme.name === activeTheme) as ThemeRegistration;
		}

		return {
			displayName: OBSIDIAN_THEME.displayName,
			name: OBSIDIAN_THEME.name,
			semanticHighlighting: OBSIDIAN_THEME.semanticHighlighting,
			colors: Object.fromEntries(Object.entries(OBSIDIAN_THEME.colors).map(([key, value]) => [key, this.mapColor(value)])),
			tokenColors: OBSIDIAN_THEME.tokenColors.map(token => {
				const newToken = { ...token };

				if (newToken.settings) {
					newToken.settings = { ...newToken.settings };
				}

				if (newToken.settings.foreground) {
					newToken.settings.foreground = this.mapColor(newToken.settings.foreground);
				}

				return newToken;
			}),
		};
	}

	async getTheme(): Promise<ThemeRegistration> {
		const activeTheme = this.getThemeIdentifier();

		if (this.usingCustomTheme()) {
			return this.plugin.highlighter.customThemes.find(theme => theme.name === activeTheme) as ThemeRegistration;
		}

		return OBSIDIAN_THEME;
	}

	getThemeIdentifier(): string {
		if (this.plugin.app.isDarkMode()) {
			return this.plugin.loadedSettings.darkTheme;
		} else {
			return this.plugin.loadedSettings.lightTheme;
		}
	}

	usingObsidianTheme(): boolean {
		return this.getThemeIdentifier() === OBSIDIAN_THEME_IDENTIFIER;
	}

	usingCustomTheme(): boolean {
		return this.getThemeIdentifier().endsWith('.json');
	}

	/**
	 * Maps a color or CSS variable to a hex color.
	 */
	mapColor(color: string): string {
		if (this.mapping.has(color)) {
			return this.mapping.get(color)!;
		} else {
			const newColor = `#${this.mapCounter.toString(16).padStart(6, '0').toUpperCase()}`;
			this.mapCounter += 1;
			this.mapping.set(color, newColor);
			this.reverseMapping.set(newColor, color);
			return newColor;
		}
	}

	/**
	 * Maps the placeholder colors in the AST to CSS variables.
	 */
	fixAST(ast: hast_types.Parents): hast_types.Parents {
		if (!this.usingObsidianTheme()) {
			return ast;
		}

		ast.children = ast.children.map(child => {
			if (child.type === 'element') {
				return this.fixNode(child);
			} else {
				return child;
			}
		});

		return ast;
	}

	private fixNode(node: hast_types.Element): hast_types.Element {
		if (node.properties?.style) {
			// a single pass over the style, instead of one per mapped color
			node.properties.style = (node.properties.style as string).replace(PLACEHOLDER_COLOR_REGEX, match => this.reverseMapping.get(match) ?? match);
		}

		for (const child of node.children) {
			if (child.type === 'element') {
				this.fixNode(child);
			}
		}

		return node;
	}
}
