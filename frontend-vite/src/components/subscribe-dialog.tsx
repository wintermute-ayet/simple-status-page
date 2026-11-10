import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiBase } from "@/lib/status-poller";

export default function SubscribeDialog({ onClose }: { onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const request = useRef<AbortController>();
	const [email, setEmail] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	useEffect(() => {
		const element = dialog.current!;
		element.showModal();
		input.current?.focus();
		return () => {
			request.current?.abort();
			element.close();
		};
	}, []);
	async function subscribe(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || !event.currentTarget.reportValidity()) return;
		setPending(true);
		setError("");
		const controller = new AbortController();
		request.current = controller;
		const timeout = setTimeout(() => controller.abort(), 10_000);
		try {
			const response = await fetch(`${apiBase}/api/subscribe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: email.trim() }),
				signal: controller.signal
			});
			if (!response.ok) throw new Error("Subscription request failed");
			setSent(true);
		} catch {
			setError("Unable to subscribe. Please try again later.");
		} finally {
			clearTimeout(timeout);
			setPending(false);
		}
	}
	return (
		<dialog
			ref={dialog}
			aria-labelledby="subscribe-title"
			aria-describedby="subscribe-description"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			<div className="dialog-header">
				<h2 id="subscribe-title">Subscribe for updates</h2>
				<button type="button" onClick={onClose} aria-label="Close subscription form">
					×
				</button>
			</div>
			<p id="subscribe-description">
				Receive important service updates and incident notifications.
			</p>
			{sent ? (
				<p role="status">Please check your inbox to confirm your subscription.</p>
			) : (
				<form onSubmit={(event) => void subscribe(event)}>
					<label htmlFor="subscribe-email">Email address</label>
					<input
						ref={input}
						id="subscribe-email"
						name="email"
						type="email"
						autoComplete="email"
						placeholder="Email address"
						maxLength={254}
						required
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						disabled={pending}
					/>
					{error && <p role="alert">{error}</p>}
					<button type="submit" disabled={pending}>
						{pending ? "Submitting…" : "Subscribe"}
					</button>
				</form>
			)}
		</dialog>
	);
}
