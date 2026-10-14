export interface SourceFile {
	file: string;
	name: string;
	key: string;
	url: string;
}

export function resolveSourceLink(
	href: string | undefined,
	markdownFile: string | undefined,
	root?: string,
): SourceFile | null;

export function collectSourceFiles(
	body: string,
	markdownFile: string,
	root?: string,
): SourceFile[];
