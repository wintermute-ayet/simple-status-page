import { useId, useRef, useState, type KeyboardEvent } from "react";
import { averageUptime, dayDetails, statusIcons, statusLabels } from "@/lib/history";
import type { Monitor } from "@/lib/status-snapshot";

export default function StatusMonitor({ data }: { data: Monitor }) {
	const detailsId = useId();
	const latest = data.history[data.history.length - 1];
	const [selectedDate, setSelectedDate] = useState(latest?.date);
	const selected = data.history.find((day) => day.date === selectedDate) ?? latest;
	const buttons = useRef<(HTMLButtonElement | null)[]>([]);
	const uptime = averageUptime(data.history);
	function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? data.history.length - 1
					: event.key === "ArrowLeft"
						? Math.max(0, index - 1)
						: event.key === "ArrowRight"
							? Math.min(data.history.length - 1, index + 1)
							: undefined;
		if (next === undefined) return;
		event.preventDefault();
		buttons.current[next]?.focus();
	}
	return (
		<article className="monitor card">
			<div className="monitor-header">
				<h3>{data.name}</h3>
				<span className={`current-status status-${data.status}`}>
					<span aria-hidden="true">{statusIcons[data.status]}</span> {statusLabels[data.status]}
				</span>
				<span className="uptime">
					{uptime === null ? "No data" : `${uptime.toFixed(1)}%`}{" "}
					<span className="uptime-wording">{data.uptimeWording || "uptime"}</span>
				</span>
			</div>
			{data.description && <p className="monitor-description">{data.description}</p>}
			<div
				className="history"
				role="group"
				aria-label={`Daily history for ${data.name}. Use arrow keys to choose a day.`}
			>
				{data.history.map((day, index) => (
					<button
						key={day.date}
						ref={(element) => {
							buttons.current[index] = element;
						}}
						type="button"
						className={`history-day status-${day.status}`}
						tabIndex={day.date === selected?.date ? 0 : -1}
						aria-label={dayDetails(day)}
						aria-describedby={detailsId}
						title={dayDetails(day)}
						onFocus={() => setSelectedDate(day.date)}
						onClick={() => setSelectedDate(day.date)}
						onKeyDown={(event) => navigate(event, index)}
					/>
				))}
			</div>
			<div className="history-range">
				<span>{data.history[0]?.date ?? "No data"}</span>
				<span>Today</span>
			</div>
			<p id={detailsId} className="day-details" aria-live="polite">
				{selected ? dayDetails(selected) : "No data"}
			</p>
		</article>
	);
}
