import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const output = path.resolve("dist");
const cssCache = new Map();
const requiredStyles = [
	["card styling", /\.card-base\s*\{/],
	["closed floating panels", /\.float-panel-closed\s*\{/],
	["theme variables", /--card-bg\s*:/],
];
let pages = 0;

function checkDirectory(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			checkDirectory(file);
			continue;
		}
		if (!entry.name.endsWith(".html")) continue;
		const html = fs.readFileSync(file, "utf8");
		if (!html.includes('id="main-grid"')) continue;
		const linkedCss = [];
		for (const match of html.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/g)) {
			const pathname = decodeURIComponent(new URL(match[1], "https://blog.test").pathname);
			const cssFile = path.join(output, pathname.replace(/^\/+/, ""));
			if (!cssCache.has(cssFile)) cssCache.set(cssFile, fs.readFileSync(cssFile, "utf8"));
			linkedCss.push(cssCache.get(cssFile));
		}
		const css = linkedCss.join("\n");
		for (const [name, pattern] of requiredStyles) {
			assert.match(css, pattern, `${path.relative(output, file)} is missing ${name}`);
		}
		pages++;
	}
}

checkDirectory(output);
assert.ok(pages > 0, "No blog pages were checked");
console.log(`Global styles verified on ${pages} blog pages.`);
