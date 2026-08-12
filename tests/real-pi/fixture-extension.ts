import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ENTRY_TYPE = "mobile-tty-real-pi-fixture";
const LINE_COUNT = 100;

type FixtureEntry = { lines: string[] };

const fixtureLines = () => [
	...Array.from({ length: LINE_COUNT }, (_, i) => {
		const id = String(i).padStart(3, "0");
		return `MTTY-LINE-${id} alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november END-${id}`;
	}),
	`MTTY_FIXTURE_DONE lines=${LINE_COUNT}`,
];

export default function (pi: ExtensionAPI) {
	const appendFixture = () => pi.appendEntry<FixtureEntry>(ENTRY_TYPE, { lines: fixtureLines() });
	const appendLine = (line: string) => pi.appendEntry<FixtureEntry>(ENTRY_TYPE, { lines: [line] });

	pi.registerEntryRenderer<FixtureEntry>(ENTRY_TYPE, (entry) => {
		if (!entry.data) throw new Error("fixture entry has no data");
		return new Text(entry.data.lines.join("\n"), 0, 0);
	});

	// This is the production-shaped tool registration. The prototype invokes the
	// same fixture through a slash command because registered tools are LLM-only.
	pi.registerTool({
		name: "mtty_fixture",
		label: "Mobile TTY Fixture",
		description: "Render the deterministic mobile-tty terminal fixture",
		parameters: Type.Object({}),
		async execute() {
			appendFixture();
			return {
				content: [{ type: "text", text: `MTTY_FIXTURE_TOOL_ACK lines=${LINE_COUNT}` }],
				details: { lines: LINE_COUNT },
			};
		},
	});

	pi.registerCommand("mtty-fixture", {
		description: "Render deterministic terminal history without an agent turn",
		async handler() {
			appendFixture();
		},
	});

	pi.registerCommand("mtty-mark", {
		description: "Render a synchronization marker without an agent turn",
		async handler(args) {
			appendLine(`MTTY_MARK_${args.trim().toUpperCase().replaceAll("-", "_")}`);
		},
	});

	// Commands are checked before input hooks. Everything else is swallowed so a
	// typo in this fixture can never become a provider request.
	pi.on("input", () => ({ action: "handled" }));
	pi.on("session_start", (event) => {
		if (event.reason === "startup") appendLine(`MTTY_EXTENSION_READY pid=${process.pid}`);
	});
}
