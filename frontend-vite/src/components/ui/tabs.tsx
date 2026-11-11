import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export default function Tabs({
	label,
	tabs
}: {
	label: string;
	tabs: { id: string; label: ReactNode; content: ReactNode }[];
}) {
	const prefix = useId();
	const [activeId, setActiveId] = useState(tabs[0]?.id);
	const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
	const triggers = useRef<(HTMLButtonElement | null)[]>([]);
	function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? tabs.length - 1
					: event.key === "ArrowLeft"
						? (index - 1 + tabs.length) % tabs.length
						: event.key === "ArrowRight"
							? (index + 1) % tabs.length
							: undefined;
		if (next === undefined) return;
		event.preventDefault();
		setActiveId(tabs[next].id);
		triggers.current[next]?.focus();
	}
	return (
		<div className="tabs">
			<div className="tab-list" role="tablist" aria-label={label}>
				{tabs.map((tab, index) => (
					<button
						key={tab.id}
						ref={(element) => {
							triggers.current[index] = element;
						}}
						type="button"
						role="tab"
						id={`${prefix}-${tab.id}-tab`}
						aria-selected={tab.id === active?.id}
						aria-controls={`${prefix}-${tab.id}-panel`}
						tabIndex={tab.id === active?.id ? 0 : -1}
						className={`tab${tab.id === active?.id ? " tab-active" : ""}`}
						onClick={() => setActiveId(tab.id)}
						onKeyDown={(event) => navigate(event, index)}
					>
						{tab.label}
					</button>
				))}
			</div>
			{active && (
				<div
					className="tab-panel"
					role="tabpanel"
					id={`${prefix}-${active.id}-panel`}
					aria-labelledby={`${prefix}-${active.id}-tab`}
					tabIndex={0}
				>
					{active.content}
				</div>
			)}
		</div>
	);
}
