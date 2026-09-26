const state = {
	body: "",
	extra: [],
	cover: null,
	banner: null,
	avatar: null,
	existingImage: "",
};

const dropzone = document.querySelector("#dropzone");
const postForm = document.querySelector("#post-form");
const note = document.querySelector("#frontmatter-note");
const logBox = document.querySelector("#log");
const jobStatus = document.querySelector("#job-status");

function showNote(text) {
	note.textContent = text;
	note.classList.remove("hidden");
}

async function api(url, payload) {
	const response = await fetch(url, {
		method: payload ? "POST" : "GET",
		headers: payload ? { "Content-Type": "application/json" } : undefined,
		body: payload ? JSON.stringify(payload) : undefined,
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "请求失败");
	return data;
}

function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1]);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

function markArticle(file, title) {
	dropzone.classList.add("selected");
	document.querySelector("#article-label").textContent = "已选择文章";
	document.querySelector("#article-name").textContent = title ? `${title}（${file.name}）` : file.name;
}

function fillPost(data, file) {
	state.body = data.body || "";
	state.extra = data.extra || [];
	state.existingImage = data.image || "";
	if (file) markArticle(file, data.title);
	document.querySelector("#slug").value = data.slug || "";
	document.querySelector("#title").value = data.title || "";
	document.querySelector("#published").value = data.published || "";
	document.querySelector("#category").value = data.category || "";
	document.querySelector("#tags").value = (data.tags || []).join(", ");
	document.querySelector("#description").value = data.description || "";
	document.querySelector("#lang").value = data.lang || "";
	document.querySelector("#draft").checked = Boolean(data.draft);
	document.querySelector("#password-protected").checked = Boolean(data.passwordProtected);
	postForm.classList.remove("hidden");
	showNote(data.hasFrontmatter
		? "已读取头部信息，空着的字段可以现在补上。"
		: "没有检测到头部信息，下面是一套基础字段，请补全后再写入。");
	document.querySelector("#cover-name").textContent = data.image
		? `当前封面路径：${data.image}`
		: "未选择新封面。已有封面路径会保留。";
}

async function inspectMarkdown(file) {
	markArticle(file);
	try {
		const content = await file.text();
		const data = await api("/api/post/inspect", { filename: file.name, content });
		fillPost(data, file);
	} catch (error) {
		showNote(`文章已选中，但读取失败：${error.message}`);
	}
}

function setCover(file) {
	if (!file || !file.type.startsWith("image/")) return;
	state.cover = file;
	const preview = document.querySelector("#cover-preview");
	preview.src = URL.createObjectURL(file);
	preview.classList.remove("hidden");
	document.querySelector("#cover-name").textContent = `新封面：${file.name}`;
}

function bindDrop(zone, onFile) {
	zone.addEventListener("dragenter", (event) => event.preventDefault());
	zone.addEventListener("dragover", (event) => {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		zone.classList.add("dragover");
	});
	zone.addEventListener("dragleave", (event) => {
		if (zone.contains(event.relatedTarget)) return;
		zone.classList.remove("dragover");
	});
	zone.addEventListener("drop", (event) => {
		event.preventDefault();
		zone.classList.remove("dragover");
		onFile(event.dataTransfer.files?.[0]);
	});
}

window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

bindDrop(dropzone, (file) => {
	if (!file) return;
	if (/\.(md|mdx)$/i.test(file.name)) {
		inspectMarkdown(file);
		return;
	}
	showNote("这里只接收文章。封面请拖到右边。");
});
document.querySelector("#file-input").addEventListener("change", (event) => {
	const file = event.target.files?.[0];
	if (file) inspectMarkdown(file);
});

const coverDrop = document.querySelector("#cover-drop");
bindDrop(coverDrop, (file) => {
	if (!file) return;
	if (!file.type.startsWith("image/")) {
		showNote("封面这里只接收图片。");
		return;
	}
	setCover(file);
});
document.querySelector("#cover-input").addEventListener("change", (event) => {
	setCover(event.target.files?.[0]);
});

document.querySelectorAll(".tab").forEach((tab) => {
	tab.addEventListener("click", () => {
		const name = tab.dataset.page;
		document.querySelectorAll(".page").forEach((page) => {
			page.classList.toggle("hidden", page.dataset.page !== name);
		});
		document.querySelectorAll(".tab").forEach((item) => {
			item.setAttribute("aria-selected", String(item === tab));
		});
	});
});

function beat() {
	fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
}
beat();
setInterval(beat, 1500);

postForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const fields = {
		title: document.querySelector("#title").value.trim(),
		published: document.querySelector("#published").value,
		description: document.querySelector("#description").value.trim(),
		image: state.existingImage,
		tags: document.querySelector("#tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
		category: document.querySelector("#category").value.trim(),
		draft: document.querySelector("#draft").checked,
		passwordProtected: document.querySelector("#password-protected").checked,
		lang: document.querySelector("#lang").value.trim(),
	};
	const payload = {
		slug: document.querySelector("#slug").value.trim(),
		fields,
		body: state.body,
		extra: state.extra,
		overwrite: false,
	};
	if (state.cover) {
		payload.cover = { name: state.cover.name, data: await fileToBase64(state.cover) };
	}
	try {
		let result;
		try {
			result = await api("/api/post/publish", payload);
		} catch (error) {
			if (!error.message.includes("同名文章已存在")) throw error;
			if (!confirm("同名文章已存在，要覆盖它吗？")) return;
			payload.overwrite = true;
			result = await api("/api/post/publish", payload);
		}
		showNote(`已写入 ${result.path}`);
	} catch (error) {
		showNote(error.message);
	}
});

async function refreshStatus() {
	const status = await api("/api/status");
	logBox.textContent = status.log || "还没有命令输出。";
	logBox.scrollTop = logBox.scrollHeight;
	const siteRunning = status.devRunning || status.previewRunning;
	jobStatus.textContent = status.buildRunning
		? "正在构建…"
		: siteRunning
			? `预览已打开：${status.devUrl || status.previewUrl}`
			: "预览未开启";
	document.querySelector("#build-button").disabled = status.buildRunning;
	document.querySelector("#preview-start").disabled = status.buildRunning || siteRunning;
	document.querySelector("#preview-stop").disabled = !siteRunning;
	return status;
}

document.querySelector("#build-button").addEventListener("click", async () => {
	jobStatus.textContent = "正在构建…";
	document.querySelector("#build-button").disabled = true;
	try {
		await api("/api/build", {});
	} catch (error) {
		jobStatus.textContent = error.message === "Failed to fetch"
			? "构建时和工作台断开了。请重新打开工作台后再构建一次。"
			: error.message;
	}
	await refreshStatus();
});
document.querySelector("#preview-start").addEventListener("click", async () => {
	const button = document.querySelector("#preview-start");
	button.disabled = true;
	jobStatus.textContent = "正在开启预览…";
	try {
		const result = await api("/api/preview/start", {});
		jobStatus.textContent = `已打开 ${result.url}`;
	} catch (error) {
		jobStatus.textContent = error.message;
		button.disabled = false;
	}
	await refreshStatus();
});
document.querySelector("#preview-stop").addEventListener("click", async () => {
	await api("/api/preview/stop", {});
	setTimeout(refreshStatus, 400);
});

function bindImageInput(input, key, preview) {
	input.addEventListener("change", () => {
		const file = input.files?.[0];
		if (!file) return;
		state[key] = file;
		preview.src = URL.createObjectURL(file);
	});
}

async function loadSite() {
	const site = await api("/api/site");
	document.querySelector("#site-title").value = site.title;
	document.querySelector("#site-subtitle").value = site.subtitle;
	document.querySelector("#profile-name").value = site.name;
	document.querySelector("#profile-bio").value = site.bio;
	document.querySelector("#about-content").value = site.about || "";
	document.querySelector("#post-password").value = site.postPassword || "";
	const stamp = Date.now();
	document.querySelector("#banner-preview").src = `${site.bannerUrl}?t=${stamp}`;
	document.querySelector("#avatar-preview").src = `${site.avatarUrl}?t=${stamp}`;
}

bindImageInput(document.querySelector("#banner-input"), "banner", document.querySelector("#banner-preview"));
bindImageInput(document.querySelector("#avatar-input"), "avatar", document.querySelector("#avatar-preview"));

document.querySelector("#show-post-password").addEventListener("change", (event) => {
	document.querySelector("#post-password").type = event.target.checked ? "text" : "password";
});

document.querySelector("#site-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const payload = {
		title: document.querySelector("#site-title").value.trim(),
		subtitle: document.querySelector("#site-subtitle").value.trim(),
		name: document.querySelector("#profile-name").value.trim(),
		bio: document.querySelector("#profile-bio").value.trim(),
		about: document.querySelector("#about-content").value,
		postPassword: document.querySelector("#post-password").value,
	};
	if (state.banner) payload.banner = { name: state.banner.name, data: await fileToBase64(state.banner) };
	if (state.avatar) payload.avatar = { name: state.avatar.name, data: await fileToBase64(state.avatar) };
	try {
		await api("/api/site", payload);
		state.banner = null;
		state.avatar = null;
		await loadSite();
		jobStatus.textContent = "网站设置已保存";
	} catch (error) {
		jobStatus.textContent = error.message;
	}
});

loadSite().catch((error) => { jobStatus.textContent = error.message; });
refreshStatus().catch(() => {});
setInterval(() => { refreshStatus().catch(() => {}); }, 2000);
