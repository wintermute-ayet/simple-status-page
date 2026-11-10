import { errorDetails, logRedactor, type Redactor } from "./logging";

export function installProcessHandlers(
	shutdown: () => Promise<void>,
	redact: Redactor = logRedactor()
): () => void {
	let stopping = false;
	let exitTimer: ReturnType<typeof setTimeout> | undefined;
	const forceExit = () => {
		if (!exitTimer) {
			exitTimer = setTimeout(() => process.exit(1), 15000);
			exitTimer.unref();
		}
	};
	const stop = () => {
		if (stopping) return;
		stopping = true;
		void shutdown().catch((error) => {
			console.error("Graceful shutdown failed", errorDetails(error, redact));
			process.exitCode = 1;
			forceExit();
		});
	};
	const rejection = (reason: unknown) => {
		console.error("Unhandled promise rejection; stopping service", errorDetails(reason, redact));
		process.exitCode = 1;
		stop();
		forceExit();
	};
	const exception = (error: unknown) => {
		console.error("Uncaught exception; stopping service", errorDetails(error, redact));
		process.exitCode = 1;
		stop();
		forceExit();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	process.on("unhandledRejection", rejection);
	process.on("uncaughtException", exception);
	return () => {
		clearTimeout(exitTimer);
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		process.off("unhandledRejection", rejection);
		process.off("uncaughtException", exception);
	};
}
