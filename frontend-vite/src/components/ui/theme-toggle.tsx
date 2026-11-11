import type { ThemePreference } from "@/lib/theme";

const choices: { value: ThemePreference; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
	{ value: "system", label: "System" }
];

export default function ThemeToggle({
	preference,
	onChange
}: {
	preference: ThemePreference;
	onChange: (value: ThemePreference) => void;
}) {
	return (
		<div className="theme-toggle" role="group" aria-label="Color theme">
			{choices.map(({ value, label }) => (
				<button
					key={value}
					type="button"
					aria-pressed={preference === value}
					onClick={() => onChange(value)}
				>
					{label}
				</button>
			))}
		</div>
	);
}
