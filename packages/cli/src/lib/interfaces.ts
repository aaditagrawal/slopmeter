export type ProviderId =
  | "amp"
  | "claude"
  | "codex"
  | "cursor"
  | "crush"
  | "gemini"
  | "opencode"
  | "pi";

export const providerIds: ProviderId[] = [
  "amp",
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "pi",
  "crush",
];

export const defaultProviderIds: ProviderId[] = ["claude", "codex", "cursor"];

export const providerStatusLabel: Record<ProviderId, string> = {
  amp: "Amp",
  claude: "Claude code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "Open Code",
  pi: "Pi Coding Agent",
  crush: "Crush",
};
