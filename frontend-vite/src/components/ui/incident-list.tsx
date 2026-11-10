import type { Incident } from "@/lib/status-snapshot";

export default function IncidentList({ data }: { data: Incident[] }) {
	if (!data.length) return <p className="muted">No incidents reported.</p>;
	return (
		<div className="incident-list">
			{data.map((incident) => (
				<article
					className={`card incident ${incident.status === "active" ? `incident-${incident.type}` : ""}`}
					key={incident.id}
				>
					<div className="incident-header">
						<h3>
							{incident.type === "down" ? "Service outage" : "Performance degradation"} —{" "}
							{incident.monitor_name}
						</h3>
						<span
							className={`current-status status-${incident.status === "resolved" ? "up" : incident.type}`}
						>
							<span aria-hidden="true">{incident.status === "resolved" ? "✓" : "!"}</span>{" "}
							{incident.status === "resolved" ? "Resolved" : "Active"}
						</span>
					</div>
					<p className="muted">
						{incident.created} UTC
						{incident.status === "resolved" ? ` · Resolved ${incident.modified} UTC` : ""}
					</p>
					<div className="whitespace-pre-line">
						{incident.message.replace(/<br\s*\/?\s*>/gi, "\n")}
					</div>
				</article>
			))}
		</div>
	);
}
