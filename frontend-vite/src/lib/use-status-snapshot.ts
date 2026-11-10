import { useEffect, useState } from "react";
import { readSnapshot, readSnapshotEtag } from "./status-snapshot";
import { startStatusPolling } from "./status-poller";

export function useStatusSnapshot() {
	const [initialSnapshot] = useState(readSnapshot);
	const [initialEtag] = useState(() => (initialSnapshot ? readSnapshotEtag() : undefined));
	const [snapshot, setSnapshot] = useState(initialSnapshot);
	const [unreachable, setUnreachable] = useState(false);
	useEffect(
		() =>
			startStatusPolling({
				initialSnapshot,
				initialEtag,
				onSnapshot: setSnapshot,
				onUnreachable: setUnreachable
			}),
		[initialSnapshot, initialEtag]
	);
	return { snapshot, unreachable };
}
