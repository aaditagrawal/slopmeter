export type ProviderId = "claude" | "codex" | "opencode" | "pi";

export const providerIds: ProviderId[] = ["claude", "codex", "opencode", "pi"];

export const providerStatusLabel: Record<ProviderId, string> = {
  claude: "Claude code",
  codex: "Codex",
  opencode: "Open Code",
  pi: "Pi Coding Agent",
};
