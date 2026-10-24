// Browser half of the media preview bundle.
//
// Registers one document-preview implementation with the sidebar's `documentPreviews`
// registry and one body with the `sidebar.right.tab.document` slot.
//
// Streaming a phone recording has two failure modes this body is built around:
//
//   1. The media element's own request can come back unauthorised or unanswered (the app
//      runs against a Termux server that Android freezes in the background). The panel
//      then reports "format error" even though the file is a perfectly ordinary mp4.
//   2. A file the WebView cannot decode really is a format problem.
//
// So the body never hands a URL straight to `<video>`. It first probes `/api/file` with a
// ranged `fetch` — the same authenticated path the app already uses for RPC — and:
//
//   - files up to 16 MB are fetched whole and played from a `blob:` URL, which removes
//     both the request and the seek question; the `<video>` never talks to the network;
//   - larger files are streamed by URL, which needs android-fix.mjs patch 27 (Range).
//
// A failed probe is retried with backoff (a frozen Termux thaws in seconds), and a media
// element abort gets one silent retry before the panel shows the codec message. Every
// step logs a `[video-preview]` line, and the app captures the page console into
// `~/.dsh-app/status.log`, so a remaining failure is diagnosable from there.
window.__ModuleLoader__.load({
	id: "@local/dsh-video-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		/** This package's copy namespace. */
		const NS = "localVideoPreview";
		/** Registry id, also the key of the body registration in the document slot. */
		const MEDIA_ID = "@local/dsh-video-preview/media";
		/** Whole-file playback ceiling; above this the element streams ranged reads. */
		const BLOB_LIMIT_BYTES = 16 * 1024 * 1024;
		/** Backoff after a probe failure: a frozen Termux thaws within seconds. */
		const PROBE_RETRY_DELAYS_MS = [800, 1600, 3000, 5000];

		const VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "mov", "mkv", "avi", "flv", "wmv", "3gp", "ts"];
		const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "amr"];

		const zh = {
			title: "视频 / 音频",
			loading: "正在加载媒体…",
			waking: "服务暂时没响应，正在唤醒（Android 冻结了 Termux，几秒后会恢复）…",
			badAddress: "无法解析这个文件的地址",
			unsupported: "这个媒体文件没法在这里播放：WebView 的解码器不支持它的容器或编码，或者文件已损坏。",
			unreachable: "取不到这个文件（{error}）。这不一定是文件本身的问题——服务没响应时也会这样。",
			retry: "重试",
			copyPath: "复制路径",
			copied: "完整路径已复制",
			copyFailed: "复制失败，请手动选择路径",
			openExternal: "用外部播放器打开",
			openFailed: "没能交给外部应用打开（文件在 Termux 私有目录里，外部应用需要 Termux 分享的 content URI）",
			size: "大小 {size}",
			mode: "播放方式：{mode}",
			blobMode: "整段载入内存",
			streamMode: "按字节范围流式读取"
		};
		const en = {
			title: "Video and audio",
			loading: "Loading media…",
			waking: "The service is not answering; waking it (Android froze Termux, it recovers in seconds)…",
			badAddress: "Could not resolve this file address",
			unsupported: "This media file cannot play here: the WebView's decoders do not support its container or codec, or the file is broken.",
			unreachable: "Could not read this file ({error}). That is not necessarily the file — it also happens when the service is not answering.",
			retry: "Retry",
			copyPath: "Copy path",
			copied: "Full path copied",
			copyFailed: "Copy failed; select the path manually",
			openExternal: "Open in external player",
			openFailed: "Could not hand the file to an external app (it lives in Termux's private directory; the app needs a content URI shared by Termux)",
			size: "Size {size}",
			mode: "Playback: {mode}",
			blobMode: "whole file in memory",
			streamMode: "streamed byte ranges"
		};

		/**
		 * Decode a `dsh-resource://file/...` address into an absolute host path.
		 * @param address - the document slot's resource address.
		 * @returns the absolute path, or undefined for an unknown address shape.
		 */
		function pathOfAddress(address) {
			if (typeof address !== "string") return void 0;
			const prefix = "dsh-resource://file/";
			if (!address.startsWith(prefix)) return void 0;
			const parts = address.slice(prefix.length).split("/");
			const scope = parts.shift();
			if (scope === "session") parts.shift();
			else if (scope !== "absolute") return void 0;
			const path = parts
				.map((segment) => {
					try {
						return decodeURIComponent(segment);
					} catch {
						return segment;
					}
				})
				.join("/");
			if (path === "") return void 0;
			return path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : `/${path}`;
		}

		/**
		 * Authenticated file URL for one host path, resolved against the page base so a
		 * deployment prefix keeps working.
		 * @param path - absolute host path.
		 * @returns the URL, or undefined when no valid base exists.
		 */
		function mediaUrl(path) {
			const base = typeof document === "undefined" ? "/" : document.baseURI;
			try {
				return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;
			} catch {
				return void 0;
			}
		}

		/**
		 * Total file size from a ranged probe response, or 0 when the headers do not say.
		 * @param headers - the probe response headers.
		 * @returns the total byte length, or 0.
		 */
		function totalFromHeaders(headers) {
			const contentRange = headers.get("content-range");
			if (typeof contentRange === "string") {
				const match = /\/(\d+)\s*$/.exec(contentRange);
				if (match !== null) return Number(match[1]);
			}
			const length = headers.get("content-length");
			return length === null ? 0 : Number(length) || 0;
		}

		/** Lowercase suffix of a path's last segment. */
		function extensionOf(path) {
			if (typeof path !== "string") return "";
			const name = path.slice(path.lastIndexOf("/") + 1);
			const dot = name.lastIndexOf(".");
			return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
		}

		/** Whether the suffix is one this bundle presents as audio. */
		function isAudioPath(path) {
			return AUDIO_EXTENSIONS.includes(extensionOf(path));
		}

		/** Human size for the diagnostics line. */
		function humanSize(bytes) {
			if (!Number.isFinite(bytes) || bytes <= 0) return "";
			const units = ["B", "KB", "MB", "GB"];
			let value = bytes;
			let index = 0;
			while (value >= 1024 && index < units.length - 1) {
				value /= 1024;
				index += 1;
			}
			return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
		}

		/** One-line reason for a media element failure, for the message under the player. */
		function describeMediaFailure(event) {
			const error = event?.target?.error ?? event?.currentTarget?.error;
			if (error === undefined || error === null) return "";
			const codes = {
				1: "MEDIA_ERR_ABORTED",
				2: "MEDIA_ERR_NETWORK",
				3: "MEDIA_ERR_DECODE",
				4: "MEDIA_ERR_SRC_NOT_SUPPORTED"
			};
			const name = codes[error.code] ?? `MEDIA_ERR_${String(error.code)}`;
			return error.message !== undefined && error.message !== "" ? `${name}: ${error.message}` : name;
		}

		/** Copy text through the clipboard API with the classic execCommand fallback. */
		async function writeClipboard(text) {
			try {
				if (navigator.clipboard?.writeText !== undefined) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				/* fall through to the legacy path */
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.left = "-9999px";
				document.body.appendChild(area);
				area.select();
				const copied = document.execCommand("copy");
				area.remove();
				return copied === true;
			} catch {
				return false;
			}
		}

		/** Shared button look; the sidebar does not export a Button into this bundle. */
		const buttonStyle = {
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			padding: "3px 10px",
			borderRadius: 6,
			cursor: "pointer",
			color: "var(--dsw-alias-label-primary, inherit)",
			background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))",
			border: "0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))"
		};
		const mutedStyle = {
			color: "var(--dsw-alias-label-secondary, inherit)",
			fontSize: 12,
			wordBreak: "break-all"
		};

		/**
		 * The media body: probe the file, then play it from a blob (small files) or by
		 * ranged URL (large ones), with the escapes for a genuine decoder failure.
		 * @param props - document slot props: renderer request, resource address, copy, and
		 * the injected external-open action.
		 * @returns the player with its status line, or the failure panel.
		 */
		function MediaBody(props) {
			const { content, resourceAddress, t } = props;
			const path = (0, react.useMemo)(() => pathOfAddress(resourceAddress), [resourceAddress]);
			const url = (0, react.useMemo)(() => (path === void 0 ? void 0 : mediaUrl(path)), [path]);
			const [phase, setPhase] = (0, react.useState)("probing");
			const [src, setSrc] = (0, react.useState)();
			const [size, setSize] = (0, react.useState)(0);
			const [notice, setNotice] = (0, react.useState)("");
			const [errorKind, setErrorKind] = (0, react.useState)("");
			const [hint, setHint] = (0, react.useState)("");
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [playerFailures, setPlayerFailures] = (0, react.useState)(0);

			(0, react.useEffect)(() => {
				if (url === void 0) return;
				const controller = new AbortController();
				let disposed = false;
				let objectUrl;
				setPhase("probing");
				setNotice("");
				setErrorKind("");
				setSrc(undefined);
				setSize(0);
				setPlayerFailures(0);

				const probe = async () => {
					for (let index = 0; ; index += 1) {
						try {
							const response = await fetch(url, {
								headers: { Range: "bytes=0-1023" },
								credentials: "same-origin",
								cache: "no-store",
								signal: controller.signal
							});
							if (response.status !== 200 && response.status !== 206) throw new Error(`HTTP ${response.status}`);
							const total = totalFromHeaders(response.headers);
							console.info("[video-preview] probe ok", response.status, response.headers.get("content-range"), path);
							if (disposed) return;
							setSize(total);
							if (total > 0 && total <= BLOB_LIMIT_BYTES) {
								const whole = await fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
								if (!whole.ok && whole.status !== 206) throw new Error(`HTTP ${whole.status}`);
								const blob = await whole.blob();
								if (disposed) return;
								try {
									objectUrl = URL.createObjectURL(blob);
									console.info("[video-preview] preloaded", blob.size, "bytes", path);
									setSrc(objectUrl);
								} catch {
									// No blob URLs in this WebView: fall back to ranged streaming.
									setSrc(url);
								}
							} else {
								console.info("[video-preview] streaming", total, "bytes", path);
								setSrc(url);
							}
							setPhase("loading");
							return;
						} catch (error) {
							if (controller.signal.aborted || disposed) return;
							const message = error !== null && error !== undefined && error.message !== undefined ? error.message : String(error);
							console.warn("[video-preview] probe failed", index, message, path);
							if (index >= PROBE_RETRY_DELAYS_MS.length) {
								setPhase("error");
								setErrorKind("probe");
								setNotice(t("unreachable", { error: message }));
								return;
							}
							setNotice(t("waking"));
							await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAYS_MS[index]));
						}
					}
				};
				probe();
				return () => {
					disposed = true;
					controller.abort();
					if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
				};
			}, [url, attempt]);

			const ready = (0, react.useCallback)(() => {
				setPhase("ready");
				setNotice("");
				if (content !== undefined && typeof content.loaded === "function") content.loaded();
			}, [content]);
			const playerError = (0, react.useCallback)((event) => {
				const detail = describeMediaFailure(event);
				console.warn("[video-preview] media error", detail, path);
				if (playerFailures < 1) {
					setPlayerFailures(1);
					setPhase("probing");
					setNotice("");
					setTimeout(() => setAttempt((value) => value + 1), 1200);
					return;
				}
				setPhase("error");
				setErrorKind("media");
				setNotice(detail);
			}, [playerFailures, path]);
			const retry = (0, react.useCallback)(() => {
				setHint("");
				setAttempt((value) => value + 1);
			}, []);
			const copyPath = (0, react.useCallback)(async () => {
				const copied = path === void 0 ? false : await writeClipboard(path);
				setHint(copied ? t("copied") : t("copyFailed"));
			}, [path, t]);
			const openExternal = (0, react.useCallback)(async () => {
				setHint("");
				let opened = false;
				if (path !== void 0 && typeof props.openExternally === "function") {
					try {
						opened = await props.openExternally(path);
					} catch {
						opened = false;
					}
				}
				if (!opened) setHint(t("openFailed"));
			}, [path, props.openExternally, t]);

			if (url === void 0 || path === void 0) {
				return (0, react_jsx_runtime.jsx)("div", {
					style: { padding: 16, fontSize: 13, lineHeight: 1.6 },
					children: t("badAddress")
				});
			}

			const audio = isAudioPath(path);
			const mediaProps = {
				key: attempt,
				controls: true,
				preload: "metadata",
				src,
				onLoadedMetadata: ready,
				onError: playerError,
				style: {
					display: "block",
					maxWidth: "100%",
					maxHeight: "100%",
					background: "#000"
				}
			};
			if (audio) {
				mediaProps.style = { display: "block", width: "100%", maxWidth: 640 };
			} else {
				mediaProps.playsInline = true;
			}
			const player = src === undefined
				? null
				: audio
					? (0, react_jsx_runtime.jsx)("audio", mediaProps)
					: (0, react_jsx_runtime.jsx)("video", mediaProps);

			const diagnostics = [
				size > 0 ? t("size", { size: humanSize(size) }) : "",
				size > 0 ? t("mode", { mode: size <= BLOB_LIMIT_BYTES ? t("blobMode") : t("streamMode") }) : ""
			].filter((line) => line !== "");

			const panel = phase === "error"
				? (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: "none",
							padding: "10px 16px",
							borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))",
							fontSize: 13,
							lineHeight: 1.6
						},
						"data-media-preview-error": errorKind,
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								children: errorKind === "probe" ? notice : t("unsupported")
							}),
							errorKind === "media" && notice !== ""
								? (0, react_jsx_runtime.jsx)("div", { style: { marginTop: 4, ...mutedStyle }, children: notice })
								: null,
							diagnostics.length > 0
								? (0, react_jsx_runtime.jsx)("div", { style: { marginTop: 4, ...mutedStyle }, children: diagnostics.join(" · ") })
								: null,
							(0, react_jsx_runtime.jsxs)("div", {
								style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 },
								children: [
									(0, react_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: retry, children: t("retry") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: copyPath, children: t("copyPath") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: openExternal, children: t("openExternal") })
								]
							}),
							hint !== "" ? (0, react_jsx_runtime.jsx)("div", { style: { marginTop: 6, ...mutedStyle }, children: hint }) : null
						]
					})
				: null;

			return (0, react_jsx_runtime.jsxs)("div", {
				"data-media-preview": phase,
				style: {
					display: "flex",
					flexDirection: "column",
					width: "100%",
					height: "100%",
					minHeight: 0,
					background: "var(--dsw-alias-bg-base, #111)"
				},
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: "1 1 auto",
							minHeight: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							overflow: "hidden",
							padding: audio ? 16 : 0
						},
						children: [
							player === null || phase !== "ready"
								? (0, react_jsx_runtime.jsx)("div", {
										style: {
											position: "absolute",
											padding: "0 16px",
											textAlign: "center",
											fontSize: 12,
											color: "var(--dsw-alias-label-secondary, inherit)"
										},
										children: notice !== "" && phase !== "error" ? notice : t("loading")
									})
								: null,
							player
						]
					}),
					panel
				]
			});
		}

		const inject = ["documentPreviews", "slots", "locale", "remote", "remote.session"];

		/**
		 * Register the media implementation and its body.
		 * @param ctx - client root context carrying the document registry, slots, copy, and remotes.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "video-preview: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.documentPreviews.register({
				id: MEDIA_ID,
				extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
				binaryExtensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS],
				priority: "extension",
				title: () => t("title"),
				loading: "renderer",
				wrap: false
			}), "video-preview: metadata");
			ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
				name: "sidebar.right.tab.document",
				key: MEDIA_ID,
				locale: NS,
				inject: () => ({
					openExternally: async (path) => {
						try {
							const result = await ctx.remote.session.openWorkspacePath({ path });
							return result !== undefined && result !== null && result.opened === true;
						} catch {
							return false;
						}
					}
				})
			}, MediaBody)), "video-preview: body");
		}

		exports.apply = apply;
		exports.inject = inject;
		// Pure helpers and the body for the offline smoke test; not part of the plugin contract.
		exports.__test = {
			pathOfAddress,
			mediaUrl,
			totalFromHeaders,
			extensionOf,
			isAudioPath,
			humanSize,
			describeMediaFailure,
			MediaBody,
			MEDIA_ID,
			BLOB_LIMIT_BYTES
		};
		return module.exports;
	}
});
