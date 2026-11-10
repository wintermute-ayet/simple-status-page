export function installProcessHandlers(shutdown: () => Promise<void>): () => void {
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void shutdown().catch(() => {
			console.error("Graceful shutdown failed");
			process.exitCode = 1;
		});
	};
	const rejection = () => {
		console.error("Unhandled promise rejection; stopping service");
		process.exitCode = 1;
		stop();
	};
	const exception = () => {
		console.error("Uncaught exception; stopping service");
		process.exitCode = 1;
		stop();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	process.on("unhandledRejection", rejection);
	process.on("uncaughtException", exception);
	return () => {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		process.off("unhandledRejection", rejection);
		process.off("uncaughtException", exception);
	};
}
