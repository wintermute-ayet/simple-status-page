import { readConfig } from "./config";
import { initializeDatabase, loadMonitorStates } from "./database";
import migrateDatabase from "./database-migrations";
import { MonitorRuntime } from "./monitors";

export async function runCli(args: string[]): Promise<number> {
	const [command, configPath] = args;
	if (args.length > 2 || (command !== "check-config" && command !== "check-monitors")) {
		console.error("Usage: node dist/cli.js <check-config|check-monitors> [config-path]");
		return 1;
	}
	let config;
	try {
		config = readConfig(configPath);
	} catch (error) {
		console.error(
			"Configuration invalid:",
			error instanceof Error ? error.message : "Unknown error"
		);
		return 1;
	}
	if (command === "check-config") {
		console.log(`Configuration valid (${config.monitors.length} monitors)`);
		return 0;
	}
	// Probe once, without changing the configured database, creating incidents or sending mail.
	const monitors = config.monitors
		.filter((monitor) => monitor.type === "http")
		.map((monitor) => ({ ...monitor, retries: 1, incidents: {} }));
	if (!monitors.length) {
		console.log("No HTTP monitors configured.");
		return 0;
	}
	const db = initializeDatabase(":memory:");
	let runtime: MonitorRuntime | undefined;
	try {
		migrateDatabase(db);
		runtime = new MonitorRuntime({ ...config, monitors }, db);
		for (const monitor of monitors) await runtime.checkHTTPMonitor(monitor);
		const states = loadMonitorStates(db);
		const results = monitors.map((monitor) => ({
			id: monitor.id,
			name: monitor.name,
			status: states.get(monitor.id)!.last_status,
			elapsed: states.get(monitor.id)!.last_value
		}));
		console.table(results);
		return results.some((result) => result.status === "down") ? 1 : 0;
	} finally {
		await runtime?.stop();
		db.close();
	}
}

if (require.main === module) {
	void runCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch(() => {
			console.error("Monitor checks failed");
			process.exitCode = 1;
		});
}
