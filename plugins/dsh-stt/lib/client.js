/*!
 * dsh-stt browser half — a lazy-CJS bundle served by the harness client
 * module system. It registers a microphone button in the composer tool row
 * (the `conversation.input.right` seat). Click to start recording; the
 * browser's Web Speech API keeps listening until you click again to stop, and
 * the transcript streams into the prompt draft via `inputActions.setDraft`.
 *
 * All work happens in the browser — no host half, no API keys, no networking.
 * The Web Speech API is a real browser global here (the durable client runs
 * as an ordinary page module, unlike dynamic closures), so
 * `window.SpeechRecognition`/`webkitSpeechRecognition` are reachable directly.
 */
window.__ModuleLoader__.load({
	id: "dsh-stt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/* Mic button styles, keyed to the harness theme tokens so the button
		 * matches the rest of the composer tool row (idle = secondary label,
		 * recording = error red + pulse). */
		var STYLES = [
			".stt-mic-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;flex:none;}",
			".stt-mic-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12));}",
			".stt-mic-btn:disabled{opacity:.45;cursor:not-allowed;}",
			".stt-mic-btn.stt-mic-active{color:var(--dsw-alias-state-error-primary,#e5484d);}",
			".stt-mic-btn.stt-mic-active svg{animation:stt-mic-pulse 1.4s ease-in-out infinite;}",
			"@keyframes stt-mic-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}"
		].join("\n");

		function injectStyles() {
			if (typeof document === "undefined" || document.getElementById("dsh-stt-style")) return;
			var el = document.createElement("style");
			el.id = "dsh-stt-style";
			el.textContent = STYLES;
			document.head.appendChild(el);
		}
		injectStyles();

		/** The mic glyph (Feather-style), colored by the current button color. The
		 * primitives package exposes no microphone glyph, so the SVG stays inline. */
		function MicIcon() {
			return React.createElement("svg", {
				viewBox: "0 0 24 24",
				width: "16",
				height: "16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			},
				React.createElement("path", { d: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" }),
				React.createElement("path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }),
				React.createElement("line", { x1: "12", y1: "19", x2: "12", y2: "23" }),
				React.createElement("line", { x1: "8", y1: "23", x2: "16", y2: "23" }));
		}

		/**
		 * The microphone toggle. Props come from the conversation slot currency:
		 * `input` (InputState with the live draft) and `inputActions` (whose
		 * `setDraft` is the single public draft write path).
		 */
		function MicButton(props) {
			const input = (props && props.input) || {};
			const actions = props && props.inputActions;
			const draft = typeof input.draft === "string" ? input.draft : "";
			const [active, setActive] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const recRef = React.useRef(null);
			const stoppedRef = React.useRef(false);
			const errorRef = React.useRef(false);
			const restartRef = React.useRef(0);
			const anchorLenRef = React.useRef(0);
			const latestDraftRef = React.useRef(draft);

			/* Live mirror of the draft so result events can compute the tail. */
			React.useEffect(() => {
				latestDraftRef.current = draft;
			}, [draft]);

			/* Abort any live recognition when the seat unmounts (session switch, plugin stop). */
			React.useEffect(() => {
				return () => {
					const rec = recRef.current;
					if (!rec) return;
					rec.onresult = null;
					rec.onerror = null;
					rec.onend = null;
					try { rec.abort(); } catch (e) {}
				};
			}, []);

			/* Replace only the region after the anchor; text typed before recording survives. */
			const writeTranscript = (text) => {
				if (!actions || typeof actions.setDraft !== "function") return;
				const trimmed = String(text || "").trim();
				if (!trimmed) return;
				const tail = latestDraftRef.current.slice(0, anchorLenRef.current).trimEnd();
				actions.setDraft(tail ? tail + " " + trimmed : trimmed);
			};

			const buildRecognition = () => {
				const Ctor = (typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
				if (!Ctor) return null;
				const rec = new Ctor();
				rec.continuous = true;
				rec.interimResults = true;
				rec.maxAlternatives = 1;
				rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

				rec.onresult = (event) => {
					restartRef.current = 0;
					let finalText = "";
					let interimText = "";
					for (let i = 0; i < event.results.length; i++) {
						const result = event.results[i];
						if (!result || !result[0]) continue;
						if (result.isFinal) finalText += result[0].transcript;
						else interimText += result[0].transcript;
					}
					writeTranscript(finalText + " " + interimText);
				};

				rec.onerror = (event) => {
					const err = event && event.error;
					/* Benign endings: aborted by our own stop()/abort(), or a silent session. */
					if (err === "aborted" || err === "no-speech") return;
					errorRef.current = true;
					if (err === "not-allowed" || err === "service-not-allowed") {
						setNotice("Microphone access denied — allow it in your browser settings");
					} else if (err === "network") {
						setNotice("Speech service unreachable — check your connection");
					} else {
						setNotice("Voice input failed");
					}
					console.error("[dsh-stt] speech recognition error:", err);
				};

				rec.onend = () => {
					if (recRef.current !== rec) return;
					if (stoppedRef.current || errorRef.current) {
						recRef.current = null;
						setActive(false);
						return;
					}
					/* Continuous mode still lets the browser drop the session (network blip,
					 * continuous-audio cap): restart so it keeps recording until the user stops. */
					restartRef.current += 1;
					if (restartRef.current > 5) {
						recRef.current = null;
						setActive(false);
						setNotice("Voice input stopped unexpectedly");
						return;
					}
					try {
						rec.start();
					} catch (e) {
						recRef.current = null;
						setActive(false);
						setNotice("Voice input could not restart");
					}
				};
				return rec;
			};

			const start = () => {
				if (active || recRef.current) return;
				setNotice(null);
				stoppedRef.current = false;
				errorRef.current = false;
				restartRef.current = 0;
				anchorLenRef.current = latestDraftRef.current.length;
				const rec = buildRecognition();
				if (!rec) {
					setNotice("Speech input is not supported in this browser");
					return;
				}
				recRef.current = rec;
				try {
					rec.start();
					setActive(true);
				} catch (e) {
					recRef.current = null;
					setNotice("Voice input could not start");
					console.error("[dsh-stt] start failed:", e);
				}
			};

			const stop = () => {
				const rec = recRef.current;
				if (!rec) return;
				stoppedRef.current = true;
				try { rec.stop(); } catch (e) {}
			};

			const onClick = (e) => {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				if (active) stop();
				else start();
			};

			const supported = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
			const label = notice || (!supported
				? "Speech input is not supported in this browser"
				: active ? "Listening — click to stop" : "Voice input");

			/* The mic control follows the composer's tool-row convention: a plain
			 * icon button (matching the shipped `.add`/`.primary` controls) wrapped
			 * in the `Tooltip` primitive so its helper text matches the rest of the
			 * row instead of a native `title`. */
			return React.createElement(primitives.Tooltip, {
				label,
				side: "top",
				delayMs: 500
			}, React.createElement("button", {
				type: "button",
				className: "stt-mic-btn" + (active ? " stt-mic-active" : ""),
				onClick,
				disabled: !supported || !!notice,
				"aria-label": active ? "Stop voice input" : "Start voice input",
				"aria-pressed": active
			}, React.createElement(MicIcon, null)));
		}

		/** Required client services (Cordis fibre inject). */
		const inject = ["slots"];

		/**
		 * Plugin body: register the mic button into the composer's right tool-row
		 * seat (the additive list slot before the send button).
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
				{ name: "conversation.input.right", id: "stt-mic", order: 100 },
				MicButton
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
