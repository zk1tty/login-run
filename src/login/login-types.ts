export type LoginRunStatus =
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed";

export type LoginRunState =
  | "authing"
  | "need_otp"
  | "authed"
  | "failed";

export type LoginEventType =
  | "login.updated"
  | "login.waiting_input"
  | "login.completed"
  | "login.failed";

export type LoginNextAction = "otp";

export interface StartLoginRequest {
  customerId: string;
  targetUrl: string;
  username: string;
  password: string;
  otpDeliverySelection?: string;
}

export interface SubmitOtpRequest {
  code: string;
}

export interface LoginRunAcceptedResponse {
  runId: string;
  status: LoginRunStatus;
  state: LoginRunState;
  statusUrl: string;
  eventsUrl: string;
}

export interface LoginStageSnapshot {
  state: string;
  phase: string;
  reason: string;
  selector?: string;
}

export interface LoginSessionSnapshot {
  id: string;
  ttlMs: number;
  processKeepAliveMs: number;
  created: boolean;
}

export interface SanitizedLoginResult {
  phase: string;
  targetUrl: string;
  currentUrl: string;
  pageTitle: string;
  terminalOutcome: string;
  stage: LoginStageSnapshot | null;
  session: LoginSessionSnapshot;
}

export interface SanitizedLoginError {
  message: string;
  stage?: LoginStageSnapshot | null;
}

export interface PublicLoginRun {
  runId: string;
  customerId: string;
  targetUrl: string;
  status: LoginRunStatus;
  state: LoginRunState;
  nextActions: LoginNextAction[];
  result: SanitizedLoginResult | null;
  error: SanitizedLoginError | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface LoginEvent {
  type: LoginEventType;
  data: PublicLoginRun;
}

export interface BrowserlessCheckpointSession {
  id?: string;
  connect?: string;
  ttlMs?: number;
  processKeepAliveMs?: number;
}

export interface LoginRunCheckpoint {
  phase?: string;
  targetUrl?: string;
  currentUrl?: string;
  pageTitle?: string;
  detachedAt?: string;
  observed?: unknown;
  stage?: unknown;
  session?: BrowserlessCheckpointSession;
}

export interface PrivateLoginRunState {
  checkpoint: LoginRunCheckpoint | null;
  activeTask: Promise<void> | null;
}

export interface LoginRunRecord {
  runId: string;
  customerId: string;
  targetUrl: string;
  status: LoginRunStatus;
  state: LoginRunState;
  result: SanitizedLoginResult | null;
  error: SanitizedLoginError | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  private: PrivateLoginRunState;
}

export type LoginEventListener = (event: LoginEvent) => void;

export interface LoginRunService {
  startLogin(input: StartLoginRequest): PublicLoginRun;
  submitOtp(runId: string, input: SubmitOtpRequest): PublicLoginRun;
  getRun(runId: string): PublicLoginRun;
  subscribe(runId: string, listener: LoginEventListener): () => void;
  whenSettled(runId: string): Promise<PublicLoginRun>;
  close(): Promise<void>;
}
