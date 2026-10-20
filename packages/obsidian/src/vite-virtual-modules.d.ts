declare module 'virtual:ec-runtime';

declare module 'virtual:ec-styles.css';

declare module 'virtual:shiki-lang-aliases' {
	const aliases: Record<string, string[]>;
	export default aliases;
}
