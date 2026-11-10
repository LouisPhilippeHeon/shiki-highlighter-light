import path from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig, type UserConfig } from 'vite';
import { ExpressiveCodeEngine } from '@expressive-code/core';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import banner from 'vite-plugin-banner';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { getBuildBanner } from '@lemons_dev/lemons-obsidian-plugin-automation';
import manifest from './manifest.json' with { type: 'json' };
import { createCssVariableThemeBundle, createEcEngineConfig, EC_VIRTUAL_SETTINGS } from './packages/ec-core/src/Config';
import { OBSIDIAN_THEME } from './packages/ec-core/src/ObsidianTheme';
import { bundledLanguagesInfo } from 'shiki';

const polyfilledNodeBuiltins = new Set(['fs', 'path', 'url']);
const externalNodeBuiltins = builtinModules.filter(moduleName => !polyfilledNodeBuiltins.has(moduleName.replace(/^node:/, '')));

const entryFile = 'packages/obsidian/src/main.ts';
const EC_RUNTIME_MODULE_ID = 'virtual:ec-runtime';
const EC_STYLES_MODULE_ID = 'virtual:ec-styles.css';
const EC_RUNTIME_RESOLVED_ID = `\0${EC_RUNTIME_MODULE_ID}`;
const EC_STYLES_RESOLVED_ID = `\0${EC_STYLES_MODULE_ID}`;
const LANG_ALIASES_MODULE_ID = 'virtual:shiki-lang-aliases';
const LANG_ALIASES_RESOLVED_ID = `\0${LANG_ALIASES_MODULE_ID}`;

/**
 * Bundles only the alias metadata of shiki's languages (e.g. `ts` for `typescript`), so that custom languages
 * can be used via the same aliases as the bundled ones, without bundling the grammars themselves.
 */
function shikiLanguageAliasesPlugin() {
	return {
		name: 'shiki-lang-aliases',
		resolveId(id: string): string | undefined {
			return id === LANG_ALIASES_MODULE_ID ? LANG_ALIASES_RESOLVED_ID : undefined;
		},
		load(id: string): string | undefined {
			if (id !== LANG_ALIASES_RESOLVED_ID) {
				return undefined;
			}

			const aliases = Object.fromEntries(bundledLanguagesInfo.filter(lang => lang.aliases?.length).map(lang => [lang.id, lang.aliases]));
			return `export default ${JSON.stringify(aliases)};`;
		},
	};
}

function expressiveCodeBundlePlugin() {
	let bundlePromise: Promise<{ runtimeModule: string; styles: string }> | undefined;

	const getBundle = async (): Promise<{ runtimeModule: string; styles: string }> => {
		if (!bundlePromise) {
			bundlePromise = (async () => {
				const cssVariableTheme = createCssVariableThemeBundle(OBSIDIAN_THEME);
				const ec = new ExpressiveCodeEngine(
					createEcEngineConfig({
						theme: cssVariableTheme.theme,
						// only the base styles and scripts are generated here, nothing gets highlighted
						getHighlighter: () => undefined,
						settings: EC_VIRTUAL_SETTINGS,
						usingObsidianTheme: true,
					}),
				);

				const [baseStyles, jsModules] = await Promise.all([ec.getBaseStyles(), ec.getJsModules()]);

				return {
					runtimeModule: jsModules.join('\n'),
					styles: cssVariableTheme.restoreCssVariables(baseStyles),
				};
			})();
		}

		return bundlePromise;
	};

	return {
		name: 'expressive-code-bundle',
		resolveId(id: string): string | undefined {
			if (id === EC_RUNTIME_MODULE_ID) {
				return EC_RUNTIME_RESOLVED_ID;
			}
			if (id === EC_STYLES_MODULE_ID) {
				return EC_STYLES_RESOLVED_ID;
			}

			return undefined;
		},
		async load(id: string): Promise<string | undefined> {
			if (id !== EC_RUNTIME_RESOLVED_ID && id !== EC_STYLES_RESOLVED_ID) {
				return undefined;
			}

			const bundle = await getBundle();

			if (id === EC_RUNTIME_RESOLVED_ID) {
				return bundle.runtimeModule;
			}

			return bundle.styles;
		},
	};
}

export default defineConfig(({ mode }) => {
	const prod = mode === 'production';
	const outDir = prod ? 'dist/' : `exampleVault/.obsidian/plugins/${manifest.id}/`;

	return {
		plugins: [
			nodePolyfills({
				include: ['fs', 'path', 'url'],
				protocolImports: true,
			}),
			expressiveCodeBundlePlugin(),
			shikiLanguageAliasesPlugin(),
			banner({
				outDir,
				content: getBuildBanner(prod ? 'Release Build' : 'Dev Build', version => version),
			}),
			viteStaticCopy({
				targets: [{ src: 'manifest.json', dest: outDir }],
			}),
		],
		resolve: {
			alias: [
				{ find: 'packages', replacement: path.resolve(__dirname, './packages') },
				// replace the full shiki entry (which bundles all themes and languages) for both our code and EC's shiki plugin
				{ find: /^shiki$/, replacement: path.resolve(__dirname, './packages/obsidian/src/shikiLight.ts') },
			],
		},
		build: {
			lib: {
				entry: path.resolve(__dirname, entryFile),
				name: 'main',
				fileName: () => 'main.js',
				formats: ['cjs'],
			},
			minify: prod,
			target: 'es2022',
			sourcemap: prod ? false : 'inline',
			cssCodeSplit: false,
			emptyOutDir: false,
			outDir: '',
			rolldownOptions: {
				input: {
					main: path.resolve(__dirname, entryFile),
				},
				output: {
					dir: outDir,
					entryFileNames: 'main.js',
					assetFileNames: 'styles.css',
					codeSplitting: false,
				},
				external: [
					'obsidian',
					'electron',
					'@codemirror/autocomplete',
					'@codemirror/collab',
					'@codemirror/commands',
					'@codemirror/language',
					'@codemirror/lint',
					'@codemirror/search',
					'@codemirror/state',
					'@codemirror/view',
					'@lezer/common',
					'@lezer/highlight',
					'@lezer/lr',
					...externalNodeBuiltins,
				],
			},
		},
	} as UserConfig;
});
