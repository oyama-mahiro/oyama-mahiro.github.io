import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_PATH = path.join(ROOT, "src", "config.ts");
const ABOUT_PATH = path.join(ROOT, "src", "content", "spec", "about.md");
const POSTS_DIR = path.join(ROOT, "src", "content", "posts");
const SRC_DIR = path.join(ROOT, "src");
const PORT = Number(process.env.STUDIO_PORT || 4399);
const HOST = "127.0.0.1";
const MAX_BODY = 40 * 1024 * 1024;
const PREVIEW_START_TIMEOUT_MS = Number(process.env.PREVIEW_START_TIMEOUT_MS || 120_000);
const inheritedNodeOptions = (process.env.NODE_OPTIONS || "")
	.replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
	.trim();
const ASTRO_ENV = {
	...process.env,
	NODE_OPTIONS: [inheritedNodeOptions, "--max-old-space-size=4096"].filter(Boolean).join(" "),
};

const KNOWN_FIELDS = new Set([
	"title",
	"published",
	"updated",
	"description",
	"image",
	"tags",
	"category",
	"draft",
	"passwordProtected",
	"lang",
	"prevTitle",
	"prevSlug",
	"nextTitle",
	"nextSlug",
]);

const STUDIO_URL = `http://${HOST}:${PORT}/`;

const state = {
	log: "",
	build: { running: false, child: null },
	clientSeen: false,
	lastHeartbeat: 0,
	preview: { running: false, ready: false, pid: null, url: "", waiters: [] },
	dev: { running: false, ready: false, pid: null, url: "", waiters: [] },
};

function appendLog(text) {
	state.log += text;
	if (state.log.length > 80_000) {
		state.log = state.log.slice(-60_000);
	}
}

function today() {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

function unquote(value) {
	const text = value.trim();
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith("'") && text.endsWith("'"))
	) {
		try {
			return JSON.parse(text.startsWith("'") ? `"${text.slice(1, -1).replace(/"/g, '\\"')}"` : text);
		} catch {
			return text.slice(1, -1);
		}
	}
	return text;
}

function parseInlineList(value) {
	const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
	if (!inner.trim()) return [];
	return inner.split(",").map((item) => unquote(item)).filter(Boolean);
}

function parseFrontmatter(markdown) {
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) {
		return { hasFrontmatter: false, data: {}, extra: [], body: markdown.replace(/^\uFEFF/, "") };
	}
	const data = {};
	const extra = [];
	const lines = match[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!field) {
			extra.push(line);
			continue;
		}
		const key = field[1];
		const rest = field[2];
		if (rest.trim() === "" ) {
			const items = [];
			let next = i + 1;
			while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
				items.push(unquote(lines[next].replace(/^\s+-\s+/, "")));
				next++;
			}
			if (items.length) {
				data[key] = items;
				i = next - 1;
				continue;
			}
		}
		data[key] = rest.trim().startsWith("[") ? parseInlineList(rest) : unquote(rest);
		if (!KNOWN_FIELDS.has(key)) extra.push(line);
	}
	return {
		hasFrontmatter: true,
		data,
		extra,
		body: markdown.slice(match[0].length),
	};
}

function asTags(value) {
	if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
	if (!value) return [];
	return String(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeDate(value) {
	if (!value) return "";
	const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
	return match ? match[1] : "";
}

function suggestedSlug(filename) {
	const base = path.basename(filename || "未命名", path.extname(filename || ""));
	return base.trim() || "未命名";
}

function assertSlug(slug) {
	const name = String(slug || "").trim();
	if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000]/.test(name)) {
		throw new Error("文章文件名不合法");
	}
	return name;
}

function yamlString(value) {
	return JSON.stringify(value ?? "");
}

function buildMarkdown({ fields, body, extra }) {
	const tags = asTags(fields.tags);
	const lines = [
		"---",
		`title: ${yamlString(fields.title || "")}`,
		`published: ${normalizeDate(fields.published) || today()}`,
		`description: ${yamlString(fields.description || "")}`,
		`image: ${yamlString(fields.image || "")}`,
		`tags: [${tags.map((tag) => yamlString(tag)).join(", ")}]`,
		`category: ${yamlString(fields.category || "")}`,
		`draft: ${fields.draft ? "true" : "false"}`,
		`passwordProtected: ${fields.passwordProtected ? "true" : "false"}`,
		`lang: ${yamlString(fields.lang || "")}`,
	];
	for (const line of extra || []) {
		if (!/^(title|published|description|image|tags|category|draft|passwordProtected|lang):/.test(line.trim())) {
			lines.push(line);
		}
	}
	lines.push("---", "");
	return `${lines.join("\n")}${body.replace(/^\n/, "")}`;
}

function fieldsFromMarkdown(filename, markdown) {
	const parsed = parseFrontmatter(markdown);
	const data = parsed.data;
	return {
		hasFrontmatter: parsed.hasFrontmatter,
		slug: suggestedSlug(filename),
		title: data.title || suggestedSlug(filename),
		published: normalizeDate(data.published) || today(),
		description: data.description || "",
		image: typeof data.image === "string" ? data.image : "",
		tags: asTags(data.tags),
		category: data.category || "",
		draft: data.draft === true || data.draft === "true",
		passwordProtected: data.passwordProtected === true || data.passwordProtected === "true",
		lang: data.lang || "",
		body: parsed.body,
		extra: parsed.extra.filter((line) => !KNOWN_FIELDS.has((line.match(/^([A-Za-z0-9_-]+):/) || [])[1])),
	};
}

function extensionOf(name, fallback = ".jpg") {
	const ext = path.extname(name || "").toLowerCase();
	if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
	return fallback;
}

function readConfig() {
	return fs.readFileSync(CONFIG_PATH, "utf8");
}

function blockOf(source, exportName) {
	const start = source.indexOf(`export const ${exportName}`);
	if (start < 0) throw new Error(`找不到 ${exportName}`);
	const next = source.indexOf("\nexport const ", start + 10);
	return { start, end: next === -1 ? source.length : next };
}

function readStringField(source, exportName, field) {
	const { start, end } = blockOf(source, exportName);
	const block = source.slice(start, end);
	const matched = block.match(new RegExp(`${field}:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`));
	if (!matched) throw new Error(`找不到 ${exportName}.${field}`);
	return JSON.parse(matched[1].startsWith("'") ? `"${matched[1].slice(1, -1)}"` : matched[1]);
}

function replaceStringField(source, exportName, field, value) {
	const { start, end } = blockOf(source, exportName);
	const block = source.slice(start, end);
	const pattern = new RegExp(`(${field}:\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`);
	if (!pattern.test(block)) throw new Error(`找不到 ${exportName}.${field}`);
	const updated = block.replace(pattern, (_matched, prefix) => `${prefix}${JSON.stringify(value)}`);
	return source.slice(0, start) + updated + source.slice(end);
}

function mediaFromConfig(kind) {
	const source = readConfig();
	const rel = kind === "banner"
		? readStringField(source, "siteConfig", "src")
		: readStringField(source, "profileConfig", "avatar");
	const filePath = rel.startsWith("/")
		? path.join(ROOT, "public", rel)
		: path.join(SRC_DIR, rel);
	return { rel, filePath };
}

function contentType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return {
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".png": "image/png",
		".webp": "image/webp",
		".gif": "image/gif",
		".html": "text/html; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
	}[ext] || "application/octet-stream";
}

function writeImage(relPath, base64) {
	const filePath = path.join(SRC_DIR, relPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
	return filePath;
}

function sitePayload() {
	const source = readConfig();
	return {
		title: readStringField(source, "siteConfig", "title"),
		subtitle: readStringField(source, "siteConfig", "subtitle"),
		name: readStringField(source, "profileConfig", "name"),
		bio: readStringField(source, "profileConfig", "bio"),
		about: fs.existsSync(ABOUT_PATH) ? fs.readFileSync(ABOUT_PATH, "utf8") : "",
		postPassword: readStringField(source, "postPasswordConfig", "password"),
		bannerUrl: "/api/media/banner",
		avatarUrl: "/api/media/avatar",
	};
}

function publishPost(payload) {
	if (!payload.fields || typeof payload.fields !== "object") throw new Error("缺少文章信息");
	if (!String(payload.fields.title || "").trim()) throw new Error("文章标题不能为空");
	if (!normalizeDate(payload.fields.published)) throw new Error("发布日期格式不正确");
	const slug = assertSlug(payload.slug);
	const filePath = path.join(POSTS_DIR, `${slug}.md`);
	const dirPath = path.join(POSTS_DIR, slug);
	const indexPath = path.join(dirPath, "index.md");
	const exists = fs.existsSync(filePath) || fs.existsSync(indexPath);
	if (exists && !payload.overwrite) {
		return { status: 409, body: { error: "同名文章已存在", slug, exists: true } };
	}

	const fields = { ...payload.fields };
	let target = filePath;
	if (payload.cover) {
		const ext = extensionOf(payload.cover.name, ".jpg");
		const coverName = `cover${ext}`;
		fs.mkdirSync(dirPath, { recursive: true });
		fs.writeFileSync(path.join(dirPath, coverName), Buffer.from(payload.cover.data, "base64"));
		fields.image = `./${coverName}`;
		target = indexPath;
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
	} else if (fs.existsSync(indexPath)) {
		target = indexPath;
	}

	const markdown = buildMarkdown({
		fields,
		body: payload.body || "",
		extra: payload.extra || [],
	});
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, markdown, "utf8");
	const relative = path.relative(ROOT, target).replaceAll("\\", "/");
	appendLog(`\n[发布] 已写入 ${relative}\n`);
	return { status: 200, body: { ok: true, path: relative } };
}

function commandPath(name) {
	return path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function runCommand(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: ROOT,
			shell: true,
			windowsHide: true,
			env: ASTRO_ENV,
		});
		state.build.child = child;
		const onData = (chunk) => appendLog(chunk.toString());
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", reject);
		child.on("close", (code) => {
			if (state.build.child === child) state.build.child = null;
			if (code === 0) resolve();
			else reject(new Error(`${path.basename(command)} 退出码 ${code}`));
		});
	});
}

async function buildSite() {
	if (state.build.running) return { ok: false, error: "构建正在进行" };
	state.build.running = true;
	try {
		if (state.dev.running || state.preview.running) {
			appendLog("\n[构建] 先关闭预览，避免和构建同时占用项目\n");
			await stopRunner(state.dev);
			await stopRunner(state.preview);
		}
		appendLog("\n[构建] 开始 astro build\n");
		await runCommand(commandPath("astro"), ["build"]);
		appendLog("\n[构建] 开始 pagefind\n");
		await runCommand(commandPath("pagefind"), ["--site", "dist"]);
		appendLog("\n[构建] 完成\n");
		return { ok: true };
	} catch (error) {
		appendLog(`\n[构建] 失败：${error.message}\n`);
		return { ok: false, error: error.message };
	} finally {
		state.build.running = false;
	}
}

function notifyWaiters(runner) {
	const waiters = runner.waiters;
	runner.waiters = [];
	for (const waiter of waiters) waiter(runner.ready ? runner.url : "");
}

function startAstro(runner, args, label) {
	if (runner.running) return { ok: true, url: runner.url, already: true };
	appendLog(`\n[${label}] 正在开启\n`);
	const child = spawn(commandPath("astro"), args, {
		cwd: ROOT,
		shell: true,
		windowsHide: true,
		env: ASTRO_ENV,
	});
	runner.running = true;
	runner.ready = false;
	runner.pid = child.pid;
	runner.url = "";
	const onData = (chunk) => {
		const text = chunk.toString();
		appendLog(text);
		const matched = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/);
		if (!matched || runner.ready) return;
		runner.url = matched[0].endsWith("/") ? matched[0] : `${matched[0]}/`;
		runner.ready = true;
		notifyWaiters(runner);
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	child.on("exit", () => {
		runner.running = false;
		runner.ready = false;
		runner.pid = null;
		appendLog(`\n[${label}] 已停止\n`);
		notifyWaiters(runner);
	});
	return { ok: true, url: runner.url };
}

function whenReady(runner, failMessage) {
	if (runner.ready && runner.url) return Promise.resolve(runner.url);
	if (!runner.running) return Promise.reject(new Error(failMessage));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			runner.waiters = runner.waiters.filter((waiter) => waiter !== onReady);
			reject(new Error("启动超时，请看下方日志"));
		}, PREVIEW_START_TIMEOUT_MS);
		function onReady(url) {
			clearTimeout(timer);
			if (url) resolve(url);
			else reject(new Error(failMessage));
		}
		runner.waiters.push(onReady);
	});
}

async function stopRunner(runner) {
	if (!runner.pid) {
		runner.running = false;
		return;
	}
	const pid = runner.pid;
	killProcessTree(pid);
	await new Promise((resolve) => {
		const timer = setTimeout(resolve, 4000);
		const check = setInterval(() => {
			if (!runner.running || runner.pid !== pid) {
				clearInterval(check);
				clearTimeout(timer);
				resolve();
			}
		}, 200);
	});
}

async function stopPreview() {
	await Promise.all([stopRunner(state.preview), stopRunner(state.dev)]);
	return { ok: true, stopped: true };
}

async function openSite() {
	if (state.build.running) throw new Error("构建进行中，请等待构建完成后再开启预览");
	if (state.preview.running) await stopRunner(state.preview);
	startAstro(state.dev, ["dev", "--host", HOST], "预览");
	const url = await whenReady(state.dev, "预览没有启动成功");
	openBrowser(url);
	return { ok: true, url };
}

function openBrowser(url) {
	const target = url || STUDIO_URL;
	if (process.platform === "win32") {
		const child = spawn("rundll32", ["url.dll,FileProtocolHandler", target], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	} else {
		execFile(process.platform === "darwin" ? "open" : "xdg-open", [target]);
	}
	return { ok: true, url: target };
}

function killProcessTree(pid) {
	if (!pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	try { process.kill(-pid); } catch { process.kill(pid); }
}

let stopping = false;
function shutdown() {
	if (stopping) return;
	stopping = true;
	console.log("页面已关闭，工作台停止。");
	killProcessTree(state.preview.pid);
	killProcessTree(state.dev.pid);
	killProcessTree(state.build.child?.pid);
	setTimeout(() => process.exit(0), 400);
}

function noteClient() {
	state.clientSeen = true;
	state.lastHeartbeat = Date.now();
}

function send(res, status, body, type = "application/json; charset=utf-8") {
	const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": type,
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("上传内容过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function readJson(req) {
	const text = await readBody(req);
	if (!text) return {};
	return JSON.parse(text);
}

function serveStatic(req, res) {
	const url = new URL(req.url, `http://${HOST}`);
	const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
	const filePath = path.resolve(PUBLIC_DIR, requested);
	const relative = path.relative(PUBLIC_DIR, filePath);
	const outsidePublic = relative.startsWith("..") || path.isAbsolute(relative);
	if (outsidePublic || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
		send(res, 404, "Not found", "text/plain; charset=utf-8");
		return;
	}
	send(res, 200, fs.readFileSync(filePath), contentType(filePath));
}

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${HOST}`);
		if (req.method === "POST" && url.pathname === "/api/heartbeat") {
			noteClient();
			send(res, 200, { ok: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/status") {
			send(res, 200, {
				buildRunning: state.build.running,
				previewRunning: state.preview.running,
				previewUrl: state.preview.url,
				devRunning: state.dev.running,
				devUrl: state.dev.url,
				log: state.log,
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/site") {
			send(res, 200, sitePayload());
			return;
		}
		if (req.method === "GET" && url.pathname.startsWith("/api/media/")) {
			const kind = url.pathname.endsWith("avatar") ? "avatar" : "banner";
			const media = mediaFromConfig(kind);
			if (!fs.existsSync(media.filePath)) {
				send(res, 404, { error: "图片不存在" });
				return;
			}
			send(res, 200, fs.readFileSync(media.filePath), contentType(media.filePath));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/post/inspect") {
			const payload = await readJson(req);
			send(res, 200, fieldsFromMarkdown(payload.filename, payload.content || ""));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/post/publish") {
			const payload = await readJson(req);
			const result = publishPost(payload);
			send(res, result.status, result.body);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/site") {
			const payload = await readJson(req);
			let source = readConfig();
			const previousBanner = mediaFromConfig("banner");
			const previousAvatar = mediaFromConfig("avatar");
			source = replaceStringField(source, "siteConfig", "title", payload.title ?? "");
			source = replaceStringField(source, "siteConfig", "subtitle", payload.subtitle ?? "");
			source = replaceStringField(source, "profileConfig", "name", payload.name ?? "");
			source = replaceStringField(source, "profileConfig", "bio", payload.bio ?? "");
			const postPassword = String(payload.postPassword ?? "");
			if (!postPassword) throw new Error("文章访问密码不能为空");
			source = replaceStringField(source, "postPasswordConfig", "password", postPassword);
			if (typeof payload.about === "string") {
				const about = payload.about.endsWith("\n") ? payload.about : `${payload.about}\n`;
				fs.mkdirSync(path.dirname(ABOUT_PATH), { recursive: true });
				fs.writeFileSync(ABOUT_PATH, about, "utf8");
			}
			if (payload.banner?.data) {
				const rel = `assets/images/banner${extensionOf(payload.banner.name, ".jpg")}`;
				writeImage(rel, payload.banner.data);
				source = replaceStringField(source, "siteConfig", "src", rel);
				if (previousBanner.rel !== rel && fs.existsSync(previousBanner.filePath)) {
					fs.unlinkSync(previousBanner.filePath);
				}
			}
			if (payload.avatar?.data) {
				const rel = `assets/images/avatar${extensionOf(payload.avatar.name, ".png")}`;
				writeImage(rel, payload.avatar.data);
				source = replaceStringField(source, "profileConfig", "avatar", rel);
				if (previousAvatar.rel !== rel && fs.existsSync(previousAvatar.filePath)) {
					fs.unlinkSync(previousAvatar.filePath);
				}
			}
			fs.writeFileSync(CONFIG_PATH, source, "utf8");
			appendLog("\n[站点] 已更新站点文字或图片\n");
			send(res, 200, sitePayload());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/build") {
			const result = await buildSite();
			send(res, result.ok ? 200 : 500, result);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/preview/start") {
			const result = await openSite();
			send(res, 200, result);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/preview/stop") {
			send(res, 200, await stopPreview());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/open") {
			const result = await openSite();
			send(res, 200, result);
			return;
		}
		if (req.method === "GET") {
			serveStatic(req, res);
			return;
		}
		send(res, 404, { error: "未知接口" });
	} catch (error) {
		send(res, 500, { error: error.message || "服务器错误" });
	}
});

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.log("工作台已经在运行，正在打开页面。");
		openBrowser(STUDIO_URL);
		process.exit(0);
	}
	console.error(error);
	process.exit(1);
});

setInterval(() => {
	if (!state.clientSeen || stopping || state.build.running) return;
	if (state.dev.running || state.preview.running) return;
	if (Date.now() - state.lastHeartbeat > 15000) shutdown();
}, 1000);

server.listen(PORT, HOST, () => {
	console.log("博客工作台已在浏览器中打开。关闭网页后，工作台会自动停止。");
	openBrowser(STUDIO_URL);
});
