import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";

const sourceExtensions = new Set([
	".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
	".py", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".java", ".rs",
	".go", ".sh", ".bash", ".ps1", ".qml", ".glsl", ".vert", ".frag",
	".cmake", ".json", ".yaml", ".yml", ".toml", ".txt",
]);
const markdown = new MarkdownIt();

function isWithin(root, file) {
	const relative = path.relative(root, file);
	return relative !== "" && relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Resolve against the Markdown file's directory, not its public article URL.
export function resolveSourceLink(href, markdownFile, root = process.cwd()) {
	if (typeof href !== "string" || !markdownFile ||
		/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return null;
	let relativePath;
	try {
		relativePath = decodeURIComponent(href.split(/[?#]/, 1)[0]);
	} catch {
		return null;
	}
	if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\")) return null;
	const name = path.basename(relativePath);
	if (!sourceExtensions.has(path.extname(name).toLowerCase()) &&
		name !== "CMakeLists.txt" && name !== "Makefile") return null;

	const file = path.resolve(path.dirname(markdownFile), relativePath);
	const roots = [
		{ kind: "posts", directory: path.resolve(root, "src/content/posts") },
		{ kind: "public", directory: path.resolve(root, "public") },
	];
	const location = roots.find(({ directory }) => isWithin(directory, file));
	if (!location) return null;
	try {
		if (!fs.statSync(file).isFile() ||
			!isWithin(fs.realpathSync(location.directory), fs.realpathSync(file))) return null;
	} catch {
		return null;
	}
	const relative = path.relative(location.directory, file).split(path.sep).join("/");
	return {
		file,
		name,
		key: `${location.kind}/${relative}`,
		url: `/source/${location.kind}/${relative.split("/").map(encodeURIComponent).join("/")}/`,
	};
}

// Use Markdown's parser so reference links and filenames with spaces work too.
export function collectSourceFiles(body, markdownFile, root = process.cwd()) {
	const sources = new Map();
	function collect(tokens) {
		for (const token of tokens) {
			if (token.type === "link_open") {
				const source = resolveSourceLink(token.attrGet("href"), markdownFile, root);
				if (source) sources.set(source.key, source);
			}
			if (token.children) collect(token.children);
		}
	}
	collect(markdown.parse(body, {}));
	return [...sources.values()];
}
