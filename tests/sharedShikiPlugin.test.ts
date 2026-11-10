import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ExpressiveCodeEngine } from '@expressive-code/core';
import { toDom } from 'hast-util-to-dom';
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistration } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { createEcEngineConfig } from 'packages/ec-core/src/Config';

const odin = JSON.parse(readFileSync('exampleVault/customLanguages/odin.json', 'utf-8')) as LanguageRegistration;
const theme = {
	...(JSON.parse(readFileSync('exampleVault/customThemes/OneMonokai-color-theme.json', 'utf-8')) as ThemeRegistration),
	name: 'onemonokai-color-theme.json',
};

describe('pluginSharedShiki', () => {
	let highlighter: HighlighterCore;
	let ec: ExpressiveCodeEngine;

	beforeAll(async () => {
		highlighter = await createHighlighterCore({
			engine: createOnigurumaEngine(import('shiki/wasm')),
			themes: [theme],
			langs: [{ ...odin, aliases: ['odin'] }],
		});
		ec = new ExpressiveCodeEngine(
			createEcEngineConfig({
				theme,
				getHighlighter: () => highlighter,
				settings: { preferThemeColors: true, ecDefaultShowLineNumbers: false, ecDefaultWrap: false },
				usingObsidianTheme: false,
			}),
		);
	});

	afterAll(() => {
		highlighter.dispose();
	});

	async function render(code: string, language: string): Promise<string> {
		const result = await ec.render({ code, language });
		const container = document.createElement('div');
		container.append(toDom(result.renderedGroupAst));
		return container.innerHTML;
	}

	test('highlights custom languages and their aliases with the shared highlighter', async () => {
		for (const language of ['custom-odin', 'odin']) {
			const html = await render('package main\n\nmain :: proc() {}', language);
			expect(html).toContain('package');
			// highlighted tokens get their colors as inline styles
			expect(html).toMatch(/style="--0:#[0-9a-f]{6}/i);
		}
	});

	test('falls back to plain text for unknown languages', async () => {
		const html = await render('some text', 'not-a-language');
		expect(html).toContain('some text');
	});

	test('removes ANSI escape sequences', async () => {
		const html = await render('\u001b[31mred\u001b[0m text', 'ansi');
		expect(html).toContain('red');
		expect(html).not.toContain('[31m');
	});

	test('fails clearly without a highlighter', async () => {
		const noHighlighter = new ExpressiveCodeEngine(
			createEcEngineConfig({
				theme,
				getHighlighter: () => undefined,
				settings: { preferThemeColors: true, ecDefaultShowLineNumbers: false, ecDefaultWrap: false },
				usingObsidianTheme: false,
			}),
		);
		await expect(noHighlighter.render({ code: 'x', language: 'odin' })).rejects.toThrow('syntax highlighter is not loaded');
	});
});
