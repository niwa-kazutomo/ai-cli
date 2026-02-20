export interface ReviewConcern {
  severity: "P0" | "P1" | "P2" | "P3" | "P4";
  description: string;
  suggestion?: string;
}

export interface ReviewQuestion {
  question: string;
  choices: string[];
}

export interface ReviewJudgment {
  has_p3_plus_concerns: boolean;
  concerns: ReviewConcern[];
  questions_for_user: ReviewQuestion[];
  summary: string;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  env?: Record<string, string | undefined>;
}

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = typeof CODEX_SANDBOX_MODES[number];

export interface CapabilityCheckResult {
  supported: boolean;
  missingFlags: string[];
}

export interface OrchestratorOptions {
  prompt: string;
  maxPlanIterations: number;
  maxCodeIterations: number;
  claudeModel?: string;
  codexModel?: string;
  codexSandbox?: CodexSandboxMode;
  dangerous: boolean;
  verbose: boolean;
  debug: boolean;
  cwd: string;
}

export type ReplOptions = Omit<OrchestratorOptions, "prompt">;

export type PlanApprovalResult =
  | { action: "approve" }
  | { action: "modify"; instruction: string }
  | { action: "abort" };

export type LogLevel = "info" | "verbose" | "debug" | "warn" | "error";
