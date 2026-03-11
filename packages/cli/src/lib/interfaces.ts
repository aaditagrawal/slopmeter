export type ProviderId = "claude" | "codex" | "cursor" | "opencode" | "crush";

export const providerIds: ProviderId[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "crush",
];

export const providerStatusLabel: Record<ProviderId, string> = {
  claude: "Claude code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "Open Code",
  crush: "Crush",
};
