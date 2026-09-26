import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Astro 5.13 writes this project's large content store while it is still being
// populated. A slow write can then overwrite a newer snapshot, leaving GitHub
// Pages with only the non-post routes. Windows also cannot always rename the
// temporary file over an existing destination. Keep writes deferred until the
// sync finishes and remove the destination before the atomic rename.
const astroEntry = import.meta.resolve("astro");
const storeFile = fileURLToPath(
	new URL("../content/mutable-data-store.js", astroEntry),
);

let source = await readFile(storeFile, "utf8");
let changed = false;

if (source.includes("const SAVE_DEBOUNCE_MS = 500;")) {
	source = source.replace(
		"const SAVE_DEBOUNCE_MS = 500;",
		"const SAVE_DEBOUNCE_MS = 60000;",
	);
	changed = true;
}

if (
	source.includes("await fs.writeFile(tempFile, data);") &&
	!source.includes("await fs.rm(filePath, { force: true });")
) {
	source = source.replace(
		/(await fs\.writeFile\(tempFile, data\);\r?\n)(\s*)(await fs\.rename\(tempFile, filePath\);)/,
		"$1$2await fs.rm(filePath, { force: true });\n$2$3",
	);
	changed = true;
}

if (changed) {
	await writeFile(storeFile, source, "utf8");
	console.log("Applied Astro large-content-store compatibility fix.");
} else {
	console.log("Astro content-store compatibility fix is already applied or no longer needed.");
}
