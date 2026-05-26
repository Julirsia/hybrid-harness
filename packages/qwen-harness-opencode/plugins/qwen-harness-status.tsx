import type { TuiPlugin, TuiPluginModule, TuiTheme } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import {
  HARNESS_DIRS,
  formatTimestamp,
  formatTokenCount,
  loadHarnessSummary,
} from "./qwen-harness-status-core.mjs";

type HarnessSummary = ReturnType<typeof loadHarnessSummary>;
type ElementProps = Record<string, unknown>;

const WATCHED_FILES = [
  "state.json",
  "progress.json",
  "implementation-plan.json",
  "events.jsonl",
];

const plugin: TuiPluginModule = {
  id: "qwen-harness-status:tui",
  tui: async (api) => {
    let worktree = api.state.path.worktree;
    let summary = loadHarnessSummary(worktree);
    let watchers: FSWatcher[] = [];
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const closeWatchers = () => {
      for (const watcher of watchers) watcher.close();
      watchers = [];
    };

    const installWatchers = () => {
      closeWatchers();
      watchIfExists(worktree, watchers, scheduleRefresh);
      for (const harnessDirName of HARNESS_DIRS) {
        const harnessDir = join(worktree, harnessDirName);
        watchIfExists(harnessDir, watchers, scheduleRefresh);
        for (const file of WATCHED_FILES) {
          watchIfExists(join(harnessDir, file), watchers, scheduleRefresh);
        }
      }
    };

    const refresh = () => {
      const nextWorktree = api.state.path.worktree;
      if (nextWorktree !== worktree) {
        worktree = nextWorktree;
        installWatchers();
      }
      summary = loadHarnessSummary(worktree);
      api.renderer.requestRender();
    };

    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 80);
    }

    installWatchers();
    const interval = setInterval(refresh, 5000);

    api.lifecycle.onDispose(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(interval);
      closeWatchers();
    });

    api.slots.register({
      order: 850,
      slots: {
        sidebar_content: (ctx) => renderSidebar(summary, ctx.theme),
      },
    });
  },
};

export const tui: TuiPlugin = plugin.tui;
export default plugin;

function renderSidebar(summary: HarnessSummary, theme: TuiTheme): JSX.Element {
  return box(
    { flexDirection: "column", paddingTop: 1, paddingLeft: 1, paddingRight: 1, gap: 0 },
    [
      text({ fg: theme.current.accent }, ["Qwen Harness"]),
      summary.active ? renderActiveHarness(summary, theme) : renderInactiveHarness(theme),
    ],
  );
}

function renderActiveHarness(summary: HarnessSummary, theme: TuiTheme): JSX.Element {
  const muted = theme.current.textMuted;
  const current = summary.currentSlice;
  const next = summary.nextSlice;
  const efficiency = summary.tokenEfficiency;

  const children: JSX.Element[] = [
    line("Phase: ", summary.phase, muted),
    line("Current: ", summary.currentSliceId ?? "none", muted),
    line("Progress: ", `${summary.completedSlices} / ${summary.totalSlices} slices`, muted),
  ];

  if (current) {
    children.push(
      section("Current slice:", muted, [
        text({}, [`${current.id} - ${current.title}`]),
        line("risk: ", current.risk ?? "n/a", muted),
        line("owner: ", current.owner ?? "n/a", muted),
      ]),
    );
  }

  children.push(
    section("Next:", muted, [
      text({}, [next ? `${next.id} - ${next.title}` : "none"]),
    ]),
    section(
      "Blockers:",
      muted,
      summary.blockers.length > 0
        ? summary.blockers.map((blocker) => text({}, [`- ${blocker}`]))
        : [text({}, ["none"])],
    ),
    renderTokens(summary, muted),
  );

  if (summary.updatedAt) {
    children.push(text({ fg: muted }, [`Updated: ${formatTimestamp(summary.updatedAt)}`]));
  }

  return box({ flexDirection: "column", gap: 0 }, children);
}

function renderInactiveHarness(theme: TuiTheme): JSX.Element {
  return box({ flexDirection: "column", marginTop: 1, gap: 0 }, [
    text({ fg: theme.current.textMuted }, ["No qwen harness active"]),
    text({ fg: theme.current.textMuted }, [".qwen-harness or .pi-harness"]),
  ]);
}

function renderTokens(summary: HarnessSummary, muted: unknown): JSX.Element {
  const efficiency = summary.tokenEfficiency;
  const tokenLines = efficiency.hasData
    ? [
        line("total: ", formatTokenCount(summary.tokenUsage.total), muted),
        line(
          "local: ",
          `${formatTokenCount(summary.tokenUsage.local.total)} (${efficiency.localSharePercent}%)`,
          muted,
        ),
        line("frontier: ", formatTokenCount(summary.tokenUsage.frontier.total), muted),
        line(
          "efficiency: ",
          `${efficiency.label}${efficiency.localToFrontierRatio ? ` ${efficiency.localToFrontierRatio}x` : ""}`,
          muted,
        ),
      ]
    : [text({}, ["not recorded"])];

  return section("Tokens:", muted, tokenLines);
}

function section(title: string, muted: unknown, children: JSX.Element[]): JSX.Element {
  return box({ flexDirection: "column", marginTop: 1, gap: 0 }, [
    text({ fg: muted }, [title]),
    ...children,
  ]);
}

function line(label: string, value: string, muted: unknown): JSX.Element {
  return text({}, [span({ fg: muted }, [label]), value]);
}

function box(props: ElementProps, children: Array<JSX.Element | string | null | undefined> = []): JSX.Element {
  return element("box", props, children);
}

function text(props: ElementProps, children: Array<JSX.Element | string | null | undefined>): JSX.Element {
  return element("text", props, children);
}

function span(props: ElementProps, children: Array<JSX.Element | string | null | undefined>): JSX.Element {
  return element("span", props, children);
}

function element(
  tag: string,
  props: ElementProps,
  children: Array<JSX.Element | string | null | undefined>,
): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) setProp(node, key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    insert(node, child);
  }
  return node;
}

function watchIfExists(path: string, watchers: FSWatcher[], onChange: () => void) {
  if (!existsSync(path)) return;
  try {
    watchers.push(watch(path, { persistent: false }, onChange));
  } catch {
    // Some filesystems reject watches; the polling interval still refreshes.
  }
}
