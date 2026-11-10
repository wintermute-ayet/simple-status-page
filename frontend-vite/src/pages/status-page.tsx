import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import StatusMonitor from "@/components/ui/status-monitor";
import IncidentList from "@/components/ui/incident-list";
import SvgFavicon from "@/components/svg-favicon";
import { useStatusSnapshot } from "@/lib/use-status-snapshot";

const SubscribeDialog = lazy(() => import("@/components/subscribe-dialog"));
const results: Record<string, string> = {
	"subscribe-success": "Successfully activated your subscription.",
	"subscribe-error": "Unable to activate your subscription. Please try again.",
	"unsubscribe-success": "Successfully unsubscribed from status updates.",
	"unsubscribe-error": "Unable to unsubscribe. Please try again."
};

export default function StatusPage() {
	const { snapshot, unreachable } = useStatusSnapshot();
	const [subscribeOpen, setSubscribeOpen] = useState(false);
	const subscribeButton = useRef<HTMLButtonElement>(null);
	const [result] = useState(() =>
		typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("result")
	);
	useEffect(() => {
		if (snapshot) document.title = `${snapshot.public.companyName} Service Status`;
	}, [snapshot]);
	function closeSubscribe() {
		setSubscribeOpen(false);
		subscribeButton.current?.focus();
	}
	const down = snapshot?.monitors.filter((monitor) => monitor.status === "down").length ?? 0;
	const degraded =
		snapshot?.monitors.filter((monitor) => monitor.status === "degraded").length ?? 0;
	const unknown = snapshot?.monitors.filter((monitor) => monitor.status === "unknown").length ?? 0;
	const empty = !snapshot?.monitors.length;
	const summaryStatus = down ? "down" : degraded ? "degraded" : unknown || empty ? "unknown" : "up";
	const summary = down
		? `${down} service${down === 1 ? " is" : "s are"} down`
		: degraded
			? `${degraded} service${degraded === 1 ? " has" : "s have"} degraded performance`
			: unknown || empty
				? "Waiting for service status"
				: "All services operational";
	const activeIncidents =
		snapshot?.incidents.filter((incident) => incident.status === "active").length ?? 0;

	return (
		<main className="status-page">
			{snapshot && <SvgFavicon svgMarkup={snapshot.public.favicon} />}
			<header className="page-header">
				<div>
					{snapshot?.public.logo && (
						<img
							className="company-logo"
							src={`data:image/svg+xml,${encodeURIComponent(snapshot.public.logo)}`}
							alt={`${snapshot.public.companyName} logo`}
						/>
					)}
					<h1>{snapshot?.public.companyName} Service Status</h1>
				</div>
				{snapshot?.public.subscriptionsEnabled && (
					<button ref={subscribeButton} type="button" onClick={() => setSubscribeOpen(true)}>
						Subscribe
					</button>
				)}
			</header>
			{result && results[result] && (
				<p className="notice" role={result.endsWith("error") ? "alert" : "status"}>
					{results[result]}
				</p>
			)}
			{unreachable && (
				<p className="notice api-unreachable" role="alert">
					API unreachable.{" "}
					{snapshot ? "Showing the last available status. " : "Status is unavailable. "}
					Retrying automatically when this tab is visible.
				</p>
			)}
			{snapshot ? (
				<>
					<div className={`summary status-${summaryStatus}`} role="status">
						<span aria-hidden="true">
							{summaryStatus === "up" ? "✓" : summaryStatus === "unknown" ? "?" : "!"}
						</span>{" "}
						{summary}
					</div>
					<p className="last-updated">
						Last updated:{" "}
						<time dateTime={new Date(snapshot.updatedAt).toISOString()}>
							{new Date(snapshot.updatedAt).toLocaleString()}
						</time>
						{" · "}Refreshes every 45 seconds while visible
					</p>
					<nav className="section-links" aria-label="Status sections">
						<a href="#services">Services</a>
						<a href="#incidents">Incidents ({activeIncidents} active)</a>
					</nav>
					<section id="services" aria-label="Services">
						{snapshot.groups.map((group) => (
							<Fragment key={group.name}>
								<h2 className="group-title">{group.name}</h2>
								{group.monitors.map((id) => {
									const monitor = snapshot.monitors.find((entry) => entry.id === id);
									return monitor ? <StatusMonitor key={id} data={monitor} /> : null;
								})}
							</Fragment>
						))}
						{empty && <p>No services are published yet.</p>}
					</section>
					<section id="incidents" aria-labelledby="incidents-title">
						<h2 id="incidents-title">Incidents</h2>
						<IncidentList data={snapshot.incidents} />
					</section>
				</>
			) : (
				!unreachable && <p role="status">Loading service status…</p>
			)}
			{subscribeOpen && snapshot?.public.subscriptionsEnabled && (
				<Suspense fallback={<p role="status">Loading subscription form…</p>}>
					<SubscribeDialog onClose={closeSubscribe} />
				</Suspense>
			)}
			<footer>{snapshot?.public.companyName} Service Status</footer>
		</main>
	);
}
