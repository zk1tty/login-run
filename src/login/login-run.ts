import type {
  LoginRunCheckpoint,
  LoginRunState,
  LoginRunStatus,
  PrivateLoginRunState,
  PublicLoginRun,
  SanitizedLoginError,
  SanitizedLoginResult,
} from "./login-types";

export interface LoginRunCreateInput {
  runId: string;
  customerId: string;
  targetUrl: string;
  now: string;
}

export interface LoginRunSnapshotPatch {
  result?: SanitizedLoginResult | null;
  error?: SanitizedLoginError | null;
  checkpoint?: LoginRunCheckpoint | null;
  activeTask?: Promise<void> | null;
}

export class LoginRun {
  readonly runId: string;
  readonly customerId: string;
  readonly targetUrl: string;
  readonly createdAt: string;

  private status: LoginRunStatus;
  private state: LoginRunState;
  private result: SanitizedLoginResult | null;
  private error: SanitizedLoginError | null;
  private updatedAt: string;
  private completedAt: string | null;
  private privateState: PrivateLoginRunState;

  constructor(input: LoginRunCreateInput) {
    this.runId = input.runId;
    this.customerId = input.customerId;
    this.targetUrl = input.targetUrl;
    this.createdAt = input.now;
    this.updatedAt = input.now;
    this.completedAt = null;
    this.status = "running";
    this.state = "authing";
    this.result = null;
    this.error = null;
    this.privateState = {
      checkpoint: null,
      activeTask: null,
    };
  }

  getStatus(): LoginRunStatus {
    return this.status;
  }

  getState(): LoginRunState {
    return this.state;
  }

  getCheckpoint(): LoginRunCheckpoint | null {
    return this.privateState.checkpoint;
  }

  getActiveTask(): Promise<void> | null {
    return this.privateState.activeTask;
  }

  setActiveTask(task: Promise<void> | null): void {
    this.privateState.activeTask = task;
  }

  markRunning(now: string, patch: LoginRunSnapshotPatch = {}): void {
    this.status = "running";
    this.state = "authing";
    this.completedAt = null;
    this.applyPatch(now, patch);
  }

  markWaitingForOtp(
    now: string,
    result: SanitizedLoginResult,
    checkpoint: LoginRunCheckpoint | null
  ): void {
    this.status = "waiting_input";
    this.state = "need_otp";
    this.completedAt = null;
    this.applyPatch(now, {
      result,
      error: null,
      checkpoint,
    });
  }

  markSucceeded(
    now: string,
    result: SanitizedLoginResult,
    checkpoint: LoginRunCheckpoint | null
  ): void {
    this.status = "succeeded";
    this.state = "authed";
    this.completedAt = now;
    this.applyPatch(now, {
      result,
      error: null,
      checkpoint,
    });
  }

  markFailed(
    now: string,
    error: SanitizedLoginError,
    patch: LoginRunSnapshotPatch = {}
  ): void {
    this.status = "failed";
    this.state = "failed";
    this.completedAt = now;
    this.applyPatch(now, {
      ...patch,
      error,
    });
  }

  toPublicJson(): PublicLoginRun {
    return {
      runId: this.runId,
      customerId: this.customerId,
      targetUrl: this.targetUrl,
      status: this.status,
      state: this.state,
      nextActions:
        this.status === "waiting_input" && this.state === "need_otp"
          ? ["otp"]
          : [],
      result: this.result,
      error: this.error,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      completedAt: this.completedAt,
    };
  }

  private applyPatch(now: string, patch: LoginRunSnapshotPatch): void {
    this.updatedAt = now;

    if ("result" in patch) {
      this.result = patch.result ?? null;
    }
    if ("error" in patch) {
      this.error = patch.error ?? null;
    }
    if ("checkpoint" in patch) {
      this.privateState.checkpoint = patch.checkpoint ?? null;
    }
    if ("activeTask" in patch) {
      this.privateState.activeTask = patch.activeTask ?? null;
    }
  }
}
