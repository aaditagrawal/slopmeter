import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ModelUsage, UsageSummary } from "../interfaces";
import {
  type DailyTotalsByDate,
  type ModelTokenTotals,
  addDailyTokenTotals,
  createUsageSummary,
  readJsonDocument,
} from "./utils";

const CRUSH_GLOBAL_DATA_ENV = "CRUSH_GLOBAL_DATA";
const CRUSH_HOME_SCAN_MAX_DEPTH = 8;
const CRUSH_HOME_SCAN_SKIP_DIRS = new Set([
  ".Trash",
  ".cache",
  ".cargo",
  ".git",
  ".hg",
  ".local",
  ".next",
  ".npm",
  ".pnpm-store",
  ".rustup",
  ".svn",
  "Applications",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "node_modules",
]);

interface CrushProjectRecord {
  path?: string;
  data_dir?: string;
}

interface CrushProjectList {
  projects?: CrushProjectRecord[];
}

interface CrushUsageRow {
  day: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

interface CrushModelUsageRow {
  model: string | null;
  provider: string | null;
  message_count: number | null;
}

interface CrushDatabaseUsage {
  dailyRows: CrushUsageRow[];
  modelRows: CrushModelUsageRow[];
  recentModelRows: CrushModelUsageRow[];
}

function getDefaultCrushGlobalDataDir() {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");

    return join(localAppData, "crush");
  }

  const xdgDataHome =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");

  return join(xdgDataHome, "crush");
}

function resolveCrushGlobalDataDir() {
  const explicit = process.env[CRUSH_GLOBAL_DATA_ENV]?.trim();

  if (!explicit) {
    return getDefaultCrushGlobalDataDir();
  }

  const resolved = resolve(explicit);

  return resolved.endsWith(".json") ? dirname(resolved) : resolved;
}

async function getTrackedCrushDataDirs() {
  const projectsFile = join(resolveCrushGlobalDataDir(), "projects.json");

  let projects: CrushProjectList;

  try {
    projects = await readJsonDocument<CrushProjectList>(projectsFile);
  } catch {
    return [];
  }

  return (projects.projects ?? [])
    .map((project) => {
      const projectPath = project.path?.trim();
      const dataDir = project.data_dir?.trim();

      if (!projectPath || !dataDir) {
        return null;
      }

      return isAbsolute(dataDir)
        ? resolve(dataDir)
        : resolve(projectPath, dataDir);
    })
    .filter((path): path is string => path !== null);
}

async function scanHomeForCrushDataDirs(currentDir: string, depth: number) {
  if (basename(currentDir) === ".crush") {
    return existsSync(join(currentDir, "crush.db")) ? [currentDir] : [];
  }

  if (depth >= CRUSH_HOME_SCAN_MAX_DEPTH) {
    return [];
  }

  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dataDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    if (CRUSH_HOME_SCAN_SKIP_DIRS.has(entry.name)) {
      continue;
    }

    dataDirs.push(
      ...(await scanHomeForCrushDataDirs(join(currentDir, entry.name), depth + 1)),
    );
  }

  return dataDirs;
}

async function getHomeCrushDataDirs() {
  return scanHomeForCrushDataDirs(homedir(), 0);
}

async function getCrushDatabasePaths() {
  const seen = new Set<string>();
  const databasePaths: string[] = [];
  const dataDirs = [
    resolve(".crush"),
    join(homedir(), ".crush"),
    ...(await getTrackedCrushDataDirs()),
    resolveCrushGlobalDataDir(),
    ...(await getHomeCrushDataDirs()),
  ];

  for (const dataDir of dataDirs) {
    const databasePath = join(dataDir, "crush.db");

    if (!seen.has(databasePath) && existsSync(databasePath)) {
      seen.add(databasePath);
      databasePaths.push(databasePath);
    }
  }

  return databasePaths;
}

function isSqliteLockedError(error: unknown) {
  return error instanceof Error && /database is locked/i.test(error.message);
}

async function loadSqliteModule() {
  try {
    const moduleName = "node:sqlite";

    return await import(moduleName);
  } catch {
    throw new Error(
      "Crush SQLite support requires a Node.js runtime that provides node:sqlite.",
    );
  }
}

async function withoutSqliteExperimentalWarning<T>(callback: () => Promise<T>) {
  const originalEmitWarning = process.emitWarning.bind(process);

  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningText = typeof warning === "string" ? warning : warning.message;
    const warningType =
      warning instanceof Error ? warning.name : String(args[0] ?? "");

    if (warningType === "ExperimentalWarning" && /sqlite/i.test(warningText)) {
      return;
    }

    return Reflect.apply(originalEmitWarning, process, [
      warning,
      ...args,
    ] as Parameters<typeof process.emitWarning>);
  }) as typeof process.emitWarning;

  try {
    return await callback();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

async function withDatabaseSnapshot<T>(
  databasePath: string,
  callback: (snapshotPath: string) => T,
) {
  const snapshotDir = await mkdtemp(join(tmpdir(), "slopmeter-crush-"));
  const snapshotPath = join(snapshotDir, "crush.db");

  await copyFile(databasePath, snapshotPath);

  for (const suffix of ["-shm", "-wal"]) {
    const companionPath = `${databasePath}${suffix}`;

    if (!existsSync(companionPath)) {
      continue;
    }

    await copyFile(companionPath, `${snapshotPath}${suffix}`);
  }

  try {
    return callback(snapshotPath);
  } finally {
    await rm(snapshotDir, { recursive: true, force: true });
  }
}

function getCrushModelUsageName(row: CrushModelUsageRow) {
  const model = row.model?.trim();
  const provider = row.provider?.trim();

  if (!model) {
    return undefined;
  }

  return provider ? `${model} (${provider})` : model;
}

function getTopCrushModelByMessages(
  modelRows: CrushModelUsageRow[],
): ModelUsage | undefined {
  const counts = new Map<string, number>();

  for (const row of modelRows) {
    const name = getCrushModelUsageName(row);
    const messageCount = Math.max(Math.trunc(row.message_count ?? 0), 0);

    if (!name || messageCount <= 0) {
      continue;
    }

    counts.set(name, (counts.get(name) ?? 0) + messageCount);
  }

  let bestName: string | undefined;
  let bestCount = 0;

  for (const [name, count] of counts) {
    if (count > bestCount) {
      bestName = name;
      bestCount = count;
    }
  }

  if (!bestName || bestCount <= 0) {
    return undefined;
  }

  return {
    name: bestName,
    tokens: {
      input: 0,
      output: 0,
      cache: { input: 0, output: 0 },
      total: 0,
    },
    metric: {
      unit: "messages",
      value: bestCount,
    },
  };
}

async function readCrushUsageRows(databasePath: string, recentWindowStart: number) {
  return withoutSqliteExperimentalWarning(async () => {
    const { DatabaseSync } = await loadSqliteModule();
    const database = new DatabaseSync(databasePath, { readOnly: true });

    try {
      const dailyQuery = database.prepare(`
        SELECT
          date(created_at, 'unixepoch') AS day,
          SUM(prompt_tokens) AS prompt_tokens,
          SUM(completion_tokens) AS completion_tokens
        FROM sessions
        WHERE parent_session_id IS NULL
        GROUP BY date(created_at, 'unixepoch')
        ORDER BY day ASC
      `);

      const modelQuery = database.prepare(`
        SELECT
          model,
          provider,
          COUNT(*) AS message_count
        FROM messages
        WHERE role = 'assistant'
        GROUP BY model, provider
        ORDER BY message_count DESC, model ASC, provider ASC
      `);

      const recentModelQuery = database.prepare(`
        SELECT
          model,
          provider,
          COUNT(*) AS message_count
        FROM messages
        WHERE role = 'assistant' AND created_at >= ?
        GROUP BY model, provider
        ORDER BY message_count DESC, model ASC, provider ASC
      `);

      return {
        dailyRows: [...(dailyQuery.iterate() as Iterable<CrushUsageRow>)],
        modelRows: [...(modelQuery.iterate() as Iterable<CrushModelUsageRow>)],
        recentModelRows: recentModelQuery.all(
          recentWindowStart,
        ) as CrushModelUsageRow[],
      } satisfies CrushDatabaseUsage;
    } finally {
      database.close();
    }
  });
}

async function loadCrushUsageRows(databasePath: string, recentWindowStart: number) {
  try {
    return await readCrushUsageRows(databasePath, recentWindowStart);
  } catch (error) {
    if (!isSqliteLockedError(error)) {
      throw error;
    }

    return withDatabaseSnapshot(databasePath, async (snapshotPath) =>
      readCrushUsageRows(snapshotPath, recentWindowStart),
    );
  }
}

export async function loadCrushRows(
  start: Date,
  end: Date,
): Promise<UsageSummary> {
  const totals: DailyTotalsByDate = new Map();
  const modelTotals = new Map<string, ModelTokenTotals>();
  const recentModelTotals = new Map<string, ModelTokenTotals>();
  const modelUsageRows: CrushModelUsageRow[] = [];
  const recentModelUsageRows: CrushModelUsageRow[] = [];
  const databasePaths = await getCrushDatabasePaths();
  const recentWindowStart = new Date(end);

  recentWindowStart.setDate(recentWindowStart.getDate() - 29);
  recentWindowStart.setHours(0, 0, 0, 0);

  for (const databasePath of databasePaths) {
    const databaseUsage = await loadCrushUsageRows(
      databasePath,
      Math.floor(recentWindowStart.getTime() / 1000),
    );

    modelUsageRows.push(...databaseUsage.modelRows);
    recentModelUsageRows.push(...databaseUsage.recentModelRows);

    for (const row of databaseUsage.dailyRows) {
      if (!row.day) {
        continue;
      }

      const date = new Date(`${row.day}T00:00:00`);

      if (Number.isNaN(date.getTime()) || date < start || date > end) {
        continue;
      }

      const input = Math.max(Math.trunc(row.prompt_tokens ?? 0), 0);
      const output = Math.max(Math.trunc(row.completion_tokens ?? 0), 0);

      addDailyTokenTotals(totals, date, {
        input,
        output,
        cache: { input: 0, output: 0 },
        total: input + output,
      });
    }
  }

  const summary = createUsageSummary(
    "crush",
    totals,
    modelTotals,
    recentModelTotals,
    end,
  );

  summary.insights = {
    ...summary.insights,
    mostUsedModel: getTopCrushModelByMessages(modelUsageRows),
    recentMostUsedModel: getTopCrushModelByMessages(recentModelUsageRows),
  };

  return summary;
}
