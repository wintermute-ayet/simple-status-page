(function () {
	var root = document.documentElement;
	var preference;
	try {
		preference = localStorage.getItem("status-theme");
	} catch {
		preference = null;
	}
	if (preference !== "light" && preference !== "dark" && preference !== "system") {
		preference = root.getAttribute("data-default-theme");
	}
	if (preference !== "light" && preference !== "dark" && preference !== "system") {
		preference = "light";
	}
	try {
		var dark =
			preference === "dark" ||
			(preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
		root.setAttribute("data-theme", dark ? "dark" : "light");
	} catch {
		root.setAttribute("data-theme", "light");
	}
})();
