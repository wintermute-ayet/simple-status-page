import { parseSnapshot, type BootstrapSnapshot } from "./status-snapshot";

export const POLL_INTERVAL_MS = 45_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

interface PollOptions {
	initialSnapshot?: BootstrapSnapshot;
	initialEtag?: string;
	onSnapshot: (snapshot: BootstrapSnapshot) => void;
	onUnreachable: (unreachable: boolean) => void;
	fetch?: typeof fetch;
	visibility?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
}

export function startStatusPolling(options: PollOptions): () => void {
	const visibility = options.visibility ?? document;
	const request = options.fetch ?? window.fetch.bind(window);
	let hasSnapshot = Boolean(options.initialSnapshot);
	let etag = hasSnapshot ? options.initialEtag : undefined;
	let unreachable = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: AbortController | undefined;
	let refreshOnFinish = false;
	let wasHidden = visibility.hidden;
	function reportUnreachable(value: boolean) {
		// Avoid even a redundant state setter on 304 responses.
		if (unreachable === value) return;
		unreachable = value;
		options.onUnreachable(value);
	}

	function cancelTimer() {
		clearTimeout(timer);
		timer = undefined;
	}
	function schedule() {
		cancelTimer();
		if (!stopped && !visibility.hidden) timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
	}
	async function refresh() {
		if (stopped || visibility.hidden || inFlight) return;
		cancelTimer();
		const controller = new AbortController();
		inFlight = controller;
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await request(`${apiBase}/api/status`, {
				headers: etag ? { "If-None-Match": etag } : {},
				cache: "no-store",
				signal: controller.signal
			});
			if (stopped || controller.signal.aborted) return;
			if (response.status === 304) {
				if (!hasSnapshot) throw new Error("No cached status snapshot");
				// Keep the same React state/object; there is no response body to parse.
			} else {
				if (!response.ok) throw new Error("Status API unavailable");
				const snapshot = parseSnapshot(await response.json());
				if (stopped || controller.signal.aborted) return;
				if (!snapshot) throw new Error("Invalid status snapshot");
				const nextEtag = response.headers.get("ETag") ?? undefined;
				if (!hasSnapshot || !etag || etag !== nextEtag) options.onSnapshot(snapshot);
				hasSnapshot = true;
				etag = nextEtag;
			}
			reportUnreachable(false);
		} catch {
			if (!stopped && !visibility.hidden) reportUnreachable(true);
		} finally {
			clearTimeout(timeout);
			inFlight = undefined;
			if (refreshOnFinish && !stopped && !visibility.hidden) {
				refreshOnFinish = false;
				void refresh();
			} else schedule();
		}
	}
	function onVisibilityChange() {
		if (visibility.hidden) {
			cancelTimer();
			refreshOnFinish = false;
			inFlight?.abort();
		} else if (wasHidden) {
			if (inFlight) refreshOnFinish = true;
			else void refresh();
		}
		wasHidden = visibility.hidden;
	}
	visibility.addEventListener("visibilitychange", onVisibilityChange);
	if (hasSnapshot) schedule();
	else void refresh();
	return () => {
		stopped = true;
		cancelTimer();
		inFlight?.abort();
		visibility.removeEventListener("visibilitychange", onVisibilityChange);
	};
}
