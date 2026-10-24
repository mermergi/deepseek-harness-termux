// Browser half of the media preview bundle.
//
// Registers one document-preview implementation with the sidebar's `documentPreviews`
// registry and one body with the `sidebar.right.tab.document` slot. The body streams the
// file from the authenticated `/api/file` route through a `<video>`/`<audio>` element, so
// a phone recording plays in place instead of being copied out of Termux's private
// directory. Byte ranges come from android-fix.mjs patch 27 — without them the route
// answers a whole-file 200 (or 413 over its 20 MB cap) and the element cannot seek.
//
// The body still offers the two escapes a preview cannot replace: copy the absolute path,
// or hand the file to an external application through the same remote call the "open in
// app" control uses.
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

		const VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "mov", "mkv", "avi", "flv", "wmv", "3gp", "ts"];
		const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "amr"];

		const zh = {
			title: "视频 / 音频",
			loading: "正在加载媒体…",
			badAddress: "无法解析这个文件的地址",
			unsupported: "这个媒体文件没法在这里播放：WebView 的解码器不支持它的容器或编码，或者文件已损坏。",
			retry: "重试",
			copyPath: "复制路径",
			copied: "完整路径已复制",
			copyFailed: "复制失败，请手动选择路径",
			openExternal: "用外部播放器打开",
			openFailed: "没能交给外部应用打开（文件在 Termux 私有目录里，外部应用需要 Termux 分享的 content URI）"
		};
		const en = {
			title: "Video and audio",
			loading: "Loading media…",
			badAddress: "Could not resolve this file address",
			unsupported: "This media file cannot play here: the WebView's decoders do not support its container or codec, or the file is broken.",
			retry: "Retry",
			copyPath: "Copy path",
			copied: "Full path copied",
			copyFailed: "Copy failed; select the path manually",
			openExternal: "Open in external player",
			openFailed: "Could not hand the file to an external app (it lives in Termux's private directory; the app needs a content URI shared by Termux)"
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

		/** One-line reason for a media element failure, for the message under the player. */
		function describeMediaFailure(event) {
			const error = event?.target?.error ?? event?.currentTarget?.error;
			if (error === void 0 || error === null) return "";
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

		/**
		 * The media body: a player that streams the file, plus the escapes when decoding
		 * fails (retry, copy the path, hand it to an external app).
		 * @param props - document slot props: renderer request, resource address, copy, and
		 * the injected external-open action.
		 * @returns the player, or the failure panel.
		 */
		function MediaBody(props) {
			const { content, resourceAddress, t } = props;
			const path = (0, react.useMemo)(() => pathOfAddress(resourceAddress), [resourceAddress]);
			const [state, setState] = (0, react.useState)("loading");
			const [notice, setNotice] = (0, react.useState)("");
			const [hint, setHint] = (0, react.useState)("");
			const [attempt, setAttempt] = (0, react.useState)(0);
			const url = (0, react.useMemo)(() => (path === void 0 ? void 0 : mediaUrl(path)), [path]);
			const settle = (0, react.useCallback)(() => {
				setState("ready");
				setNotice("");
				if (content !== void 0 && typeof content.loaded === "function") content.loaded();
			}, [content]);
			const fail = (0, react.useCallback)((event) => {
				setState("error");
				setNotice(describeMediaFailure(event));
			}, []);
			const retry = (0, react.useCallback)(() => {
				setState("loading");
				setNotice("");
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

			if (url === void 0) {
				return (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: 16,
						fontSize: 13,
						lineHeight: 1.6
					},
					children: t("badAddress")
				});
			}

			const mediaProps = {
				key: attempt,
				controls: true,
				preload: "metadata",
				src: url,
				onLoadedMetadata: settle,
				onError: fail,
				style: {
					display: "block",
					maxWidth: "100%",
					maxHeight: "100%",
					background: "#000"
				}
			};
			if (isAudioPath(path)) {
				mediaProps.style = {
					display: "block",
					width: "100%",
					maxWidth: 640
				};
			} else {
				mediaProps.playsInline = true;
			}
			const player = isAudioPath(path)
				? (0, react_jsx_runtime.jsx)("audio", mediaProps)
				: (0, react_jsx_runtime.jsx)("video", mediaProps);

			const panel = state === "error"
				? (0, react_jsx_runtime.jsxs)("div", {
						style: {
							flex: "none",
							padding: "10px 16px",
							borderTop: "0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))",
							fontSize: 13,
							lineHeight: 1.6
						},
						"data-media-preview-error": "",
						children: [
							(0, react_jsx_runtime.jsx)("div", { children: t("unsupported") }),
							notice !== "" ? (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 4,
									color: "var(--dsw-alias-label-secondary, inherit)",
									fontSize: 12,
									wordBreak: "break-all"
								},
								children: notice
							}) : null,
							(0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									flexWrap: "wrap",
									gap: 8,
									marginTop: 10
								},
								children: [
									(0, react_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: retry, children: t("retry") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: copyPath, children: t("copyPath") }),
									(0, react_jsx_runtime.jsx)("button", { type: "button", style: buttonStyle, onClick: openExternal, children: t("openExternal") })
								]
							}),
							hint !== "" ? (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 6,
									color: "var(--dsw-alias-label-secondary, inherit)",
									fontSize: 12
								},
								children: hint
							}) : null
						]
					})
				: null;

			return (0, react_jsx_runtime.jsxs)("div", {
				"data-media-preview": state,
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
							padding: isAudioPath(path) ? 16 : 0
						},
						children: [
							state === "loading" ? (0, react_jsx_runtime.jsx)("div", {
								style: {
									position: "absolute",
									fontSize: 12,
									color: "var(--dsw-alias-label-secondary, inherit)"
								},
								children: t("loading")
							}) : null,
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
		return module.exports;
	}
});
