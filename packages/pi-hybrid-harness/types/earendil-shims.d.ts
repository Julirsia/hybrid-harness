// Offline type shims for the Pi peer dependencies.
//
// The real types ship with @earendil-works/pi-* packages, which are declared as
// peerDependencies and are not installed in this repo (and may be unreachable in
// CI/offline environments). These ambient declarations let `tsc --noEmit`
// type-check the harness's own logic without the upstream packages present.
//
// They intentionally type the external surface loosely (`any`). The goal is to
// catch mistakes in *our* code, not to validate calls into the Pi API.

declare module "@earendil-works/pi-agent-core" {
	export interface AgentToolResult<T = unknown> {
		content: Array<{ type: string; text?: string }>;
		details?: T;
		isError?: boolean;
	}
}

declare module "@earendil-works/pi-coding-agent" {
	export const keyHint: (action: string, label?: string) => string;
	export interface ExtensionAPI {
		[key: string]: any;
		registerProvider(name: string, definition: any): void;
		registerMessageRenderer<T = unknown>(
			type: string,
			render: (...args: any[]) => any,
		): void;
		registerTool(definition: any): void;
		registerCommand(name: string, definition: any): void;
		registerShortcut(key: any, definition: any): void;
		on(event: string, handler: (...args: any[]) => any): void;
		sendMessage(message: any): void;
	}
}

declare module "@earendil-works/pi-tui" {
	export type Component = any;
	export type MarkdownTheme = any;
	export type SelectItem<T = unknown> = any;
	export type TUI = any;

	export const Container: any;
	export const Key: any;
	export const Markdown: any;
	export const SelectList: any;
	export type SelectList<T = unknown> = any;
	export const Spacer: any;
	export const Text: any;
	export const matchesKey: (...args: any[]) => boolean;
	export const truncateToWidth: (...args: any[]) => string;
	export const visibleWidth: (...args: any[]) => number;
	export const wrapTextWithAnsi: (...args: any[]) => string[];
}
