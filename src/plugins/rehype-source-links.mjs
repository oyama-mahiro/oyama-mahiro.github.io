import { visit } from "unist-util-visit";
import { resolveSourceLink } from "../utils/source-files.mjs";

export function rehypeSourceLinks({ root = process.cwd(), base = "/" } = {}) {
	return (tree, file) => {
		visit(tree, "element", node => {
			if (node.tagName !== "a") return;
			const source = resolveSourceLink(node.properties?.href, file.path, root);
			if (!source) return;
			node.properties.href = `${base.replace(/\/$/, "")}${source.url}`;
			node.properties.target = "_blank";
			const rel = new Set(String(node.properties.rel || "").split(/[\s,]+/).filter(Boolean));
			rel.add("noopener");
			rel.add("noreferrer");
			node.properties.rel = [...rel];
			node.properties["data-no-swup"] = true;
		});
	};
}
