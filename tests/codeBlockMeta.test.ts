import { describe, test, expect } from 'bun:test';
import {
	findMetaStringInText,
	getLinePrefix,
	parseEditorMeta,
	parseFenceLine,
	parseLineRanges,
	parseMetaString,
	stripLinePrefix,
} from 'packages/obsidian/src/CodeBlockMeta';

describe('parseFenceLine', () => {
	test('parses language and meta', () => {
		expect(parseFenceLine('```ts title="foo" {1}')).toEqual({ prefix: '', fence: '```', language: 'ts', meta: 'title="foo" {1}' });
	});

	test('parses fences without meta, with tildes and with prefixes', () => {
		expect(parseFenceLine('~~~~python')).toEqual({ prefix: '', fence: '~~~~', language: 'python', meta: '' });
		expect(parseFenceLine('> ``` c++ {2}')).toEqual({ prefix: '> ', fence: '```', language: 'c++', meta: '{2}' });
		expect(parseFenceLine('```')).toEqual({ prefix: '', fence: '```', language: '', meta: '' });
	});

	test('rejects lines that are not fences', () => {
		expect(parseFenceLine('some text')).toBeNull();
	});
});

describe('parseMetaString', () => {
	test('matches the language case-insensitively', () => {
		expect(parseMetaString('```TS showLineNumbers', 'ts')).toBe('showLineNumbers');
		expect(parseMetaString('```ts', 'ts')).toBe('');
		expect(parseMetaString('```js {1}', 'ts')).toBeNull();
	});
});

describe('line prefixes', () => {
	test('callout prefixes are stripped, indentation is kept', () => {
		expect(getLinePrefix(parseFenceLine('> ```ts')!)).toBe('>');
		expect(getLinePrefix(parseFenceLine('    ```ts')!)).toBe('');
		expect(stripLinePrefix('> const a = 1;', '>')).toBe(2);
		expect(stripLinePrefix('>   indented', '>')).toBe(2);
		expect(stripLinePrefix('no prefix', '>')).toBe(0);
		expect(stripLinePrefix('    code', '')).toBe(0);
	});
});

describe('findMetaStringInText', () => {
	test('finds the matching code block', () => {
		const text = ['```ts {1}', 'const a = 1;', '```', '', '```ts {2}', 'const b = 2;', '```'].join('\n');
		expect(findMetaStringInText(text, 'const b = 2;', 'ts')).toBe('{2}');
	});

	test('finds code blocks in callouts', () => {
		const text = ['> [!note]', '> ```ts showLineNumbers', '> const a = 1;', '> ```'].join('\n');
		expect(findMetaStringInText(text, 'const a = 1;', 'ts')).toBe('showLineNumbers');
	});
});

describe('parseLineRanges', () => {
	test('parses single lines, ranges and labels', () => {
		expect(parseLineRanges('1, 3-5')).toEqual([1, 3, 4, 5]);
		expect(parseLineRanges('"Label": 2-3')).toEqual([2, 3]);
	});
});

describe('parseEditorMeta', () => {
	test('parses line markers, later marker types win', () => {
		const meta = parseEditorMeta('{1, 3} ins={3-4} del={4}', false);
		expect([...meta.lineMarkers.entries()].sort()).toEqual([
			[1, 'mark'],
			[3, 'ins'],
			[4, 'del'],
		]);
	});

	test('parses line numbers', () => {
		expect(parseEditorMeta('showLineNumbers startLineNumber=5', false)).toMatchObject({ showLineNumbers: true, startLineNumber: 5 });
		expect(parseEditorMeta('showLineNumbers=false', true).showLineNumbers).toBe(false);
		expect(parseEditorMeta('', true).showLineNumbers).toBe(true);
	});
});
