import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { collectSourceFiles, resolveSourceLink } from "../src/utils/source-files.mjs";
import { rehypeSourceLinks } from "../src/plugins/rehype-source-links.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuwari-source-links-"));
const article = path.join(root, "src/content/posts/示例文章/index.md");
const code = path.join(root, "src/content/posts/示例文章/code/完整 源码.cpp");
fs.mkdirSync(path.dirname(code), { recursive: true });
fs.writeFileSync(code, '// 中文源码\nconst char *s = "<script>";\nint main() { return 0; }\n');
const shared = path.join(root, "src/content/posts/shared/demo.py");
fs.mkdirSync(path.dirname(shared), { recursive: true });
fs.writeFileSync(shared, 'print("hello")\n');
fs.writeFileSync(path.join(root, "private.cpp"), "private");
after(() => {
	assert.ok(root.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
	assert.ok(path.basename(root).startsWith("fuwari-source-links-"));
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("source paths are relative to the Markdown file, including spaces and Chinese names", () => {
	const source = resolveSourceLink("./code/完整%20源码.cpp", article, root);
	assert.equal(source.file, code);
	assert.equal(source.url, `/source/posts/${encodeURIComponent("示例文章")}/code/${encodeURIComponent("完整 源码.cpp")}/`);
	assert.equal(resolveSourceLink("code/完整%20源码.cpp", article, root).file, code);
});

test("parent-relative links can access shared source files inside the content root", () => {
	assert.equal(resolveSourceLink("../shared/demo.py", article, root).file, shared);
});

test("external URLs, missing files and traversal outside published roots stay untouched", () => {
	for (const href of ["https://example.com/main.cpp", "//example.com/main.cpp", "/main.cpp", "./missing.cpp", "../../../../private.cpp", "./code/%00.cpp", "./code/%broken.cpp"]) {
		assert.equal(resolveSourceLink(href, article, root), null, href);
	}
});

test("Markdown reference links are collected and code examples are not published", () => {
	const body = '[查看源码][code]\n\n[code]: <./code/完整 源码.cpp>\n\n```md\n[例子](../shared/demo.py)\n```';
	assert.deepEqual(collectSourceFiles(body, article, root).map(source => source.file), [code]);
});

test("only source links open a new tab and bypass Swup", () => {
	const anchor = { type: "element", tagName: "a", properties: { href: "./code/完整%20源码.cpp" }, children: [] };
	const normal = { type: "element", tagName: "a", properties: { href: "../another-post/" }, children: [] };
	const tree = { type: "root", children: [anchor, normal] };
	rehypeSourceLinks({ root, base: "/blog/" })(tree, { path: article });
	assert.equal(anchor.properties.href, `/blog${resolveSourceLink("./code/完整%20源码.cpp", article, root).url}`);
	assert.equal(anchor.properties.target, "_blank");
	assert.ok(anchor.properties.rel.includes("noopener"));
	assert.equal(anchor.properties["data-no-swup"], true);
	assert.deepEqual(normal.properties, { href: "../another-post/" });
});
