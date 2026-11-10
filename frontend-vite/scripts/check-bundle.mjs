import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const limit = 70_000;
let total = 0;
let files = 0;
function measure(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name)
	)) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) measure(path);
		else if (entry.name.endsWith(".js")) {
			const source = readFileSync(path);
			const size = gzipSync(source).length;
			total += size;
			files++;
			console.log(`${relative(dist, path)}: ${source.length} bytes, ${size} gzip bytes`);
		}
	}
}
measure(dist);
console.log(`Total JavaScript: ${total} gzip bytes (must be under ${limit})`);
if (!files || total >= limit) process.exitCode = 1;
