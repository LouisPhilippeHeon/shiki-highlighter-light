import { MetaOptions } from '@expressive-code/core';

export interface FenceLine {
	/**
	 * The text before the fence, e.g. `> ` for code blocks in callouts or indentation for code blocks in lists.
	 */
	prefix: string;
	/**
	 * The fence itself, e.g. ```` ``` ```` or `~~~~`.
	 */
	fence: string;
	language: string;
	meta: string;
}

/**
 * Parses an opening code block fence line, e.g. ```` > ```ts title="foo" {1} ````.
 * Returns null if the line is not a fence line.
 */
export function parseFenceLine(line: string): FenceLine | null {
	const match = /^([^`~]*?)(```+|~~~+)[ \t]*([^\s`]*)(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
	if (match === null) {
		return null;
	}

	return {
		prefix: match[1],
		fence: match[2],
		language: match[3],
		meta: match[4] ?? '',
	};
}

/**
 * Returns the text after the code block language on the opening fence line, or null if the line is not an opening fence for that language.
 */
export function parseMetaString(fenceLine: string, language: string): string | null {
	const fence = parseFenceLine(fenceLine);
	if (fence?.language.toLowerCase() !== language.toLowerCase()) {
		return null;
	}
	return fence.meta;
}

/**
 * Returns the prefix of a fence line that also precedes every line of the code block, e.g. `>` for callouts.
 * Whitespace is not part of it, since indentation of the code block lines is part of the code.
 */
export function getLinePrefix(fence: FenceLine): string {
	return fence.prefix.replace(/\s+$/, '').replace(/^\s+/, '');
}

/**
 * Removes the line prefix (e.g. `> ` for callouts) from a code block line.
 * Returns the number of removed characters.
 */
export function stripLinePrefix(line: string, prefix: string): number {
	if (prefix === '') {
		return 0;
	}

	const match = /^\s*/.exec(line)!;
	if (!line.startsWith(prefix, match[0].length)) {
		return 0;
	}

	const end = match[0].length + prefix.length;
	return line[end] === ' ' ? end + 1 : end;
}

/**
 * Finds the code block with the given language and content in a markdown text and returns its meta string.
 * Returns the meta string of the first match, or null if no code block matches.
 */
export function findMetaStringInText(text: string, source: string, language: string): string | null {
	const lines = text.split('\n').map(line => line.replace(/\r$/, ''));

	for (let i = 0; i < lines.length; i++) {
		const fence = parseFenceLine(lines[i]);
		if (fence?.language.toLowerCase() !== language.toLowerCase()) {
			continue;
		}

		const prefix = getLinePrefix(fence);
		const closingFence = new RegExp(`^\\s*${fence.fence[0]}{${fence.fence.length},}\\s*$`);

		const content: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j].slice(stripLinePrefix(lines[j], prefix));

			if (closingFence.test(line)) {
				if (content.join('\n').trim() === source.trim()) {
					return fence.meta;
				}
				break;
			}

			content.push(line);
		}
	}

	return null;
}

/**
 * Returns the language of a `<code class="language-xyz">` element rendered by Obsidian, or null if it has none.
 */
export function getCodeElementLanguage(codeEl: Element): string | null {
	for (const cls of Array.from(codeEl.classList)) {
		if (cls.startsWith('language-') && cls.length > 'language-'.length) {
			return cls.slice('language-'.length);
		}
	}
	return null;
}

export type LineMarkerType = 'mark' | 'ins' | 'del';

export interface EditorCodeBlockMeta {
	showLineNumbers: boolean;
	startLineNumber: number;
	/**
	 * Maps 1-based line numbers of the code block to their marker type.
	 */
	lineMarkers: Map<number, LineMarkerType>;
}

/**
 * Parses an Expressive Code line range like `1, 5-10` or `"Label": 3-4` into a list of 1-based line numbers.
 */
export function parseLineRanges(range: string): number[] {
	// labels are not supported in the editor
	const withoutLabels = range.replace(/"[^"]*"\s*:|'[^']*'\s*:/g, '');
	const lines: number[] = [];

	for (const match of withoutLabels.matchAll(/(\d+)(?:\s*-\s*(\d+))?/g)) {
		const start = Number(match[1]);
		const end = match[2] !== undefined ? Number(match[2]) : start;
		for (let line = Math.min(start, end); line <= Math.max(start, end); line++) {
			lines.push(line);
		}
	}

	return lines;
}

/**
 * Parses the subset of the Expressive Code meta string that is supported in the editor.
 */
export function parseEditorMeta(meta: string, defaultShowLineNumbers: boolean): EditorCodeBlockMeta {
	const options = new MetaOptions(meta);
	const lineMarkers = new Map<number, LineMarkerType>();

	// later marker types win, so that e.g. `del` is visible on top of `mark`
	const markerKeys: [string[], LineMarkerType][] = [
		[['', 'mark'], 'mark'],
		[['ins'], 'ins'],
		[['del'], 'del'],
	];
	for (const [keys, type] of markerKeys) {
		for (const range of options.getRanges(keys)) {
			for (const line of parseLineRanges(range)) {
				lineMarkers.set(line, type);
			}
		}
	}

	return {
		showLineNumbers: options.getBoolean('showLineNumbers') ?? defaultShowLineNumbers,
		startLineNumber: options.getInteger('startLineNumber') ?? 1,
		lineMarkers,
	};
}
