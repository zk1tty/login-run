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

export type LoginRunLifecycleEventType =
  | "login.updated"
  | "login.waiting_input"
  | "login.completed"
  | "login.failed";

export type LoginEventType =
  | LoginRunLifecycleEventType
  | "login.screenshot";

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

export interface LoginRunListResponse {
  runs: PublicLoginRun[];
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

export interface LoginScreenshotArtifact {
  fileName: string;
  label: string;
  createdAt: string;
  url: string;
}

export interface LoginScreenshotEventData extends LoginScreenshotArtifact {
  runId: string;
  phase: string;
  sequence: number;
}

export interface LoginScreenshotArtifactList {
  runId: string;
  screenshots: LoginScreenshotArtifact[];
}

export interface LoginScreenshotArtifactFile {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

export interface LoginRunEvent {
  type: LoginRunLifecycleEventType;
  data: PublicLoginRun;
}

export interface LoginScreenshotEvent {
  type: "login.screenshot";
  data: LoginScreenshotEventData;
}

export type LoginEvent = LoginRunEvent | LoginScreenshotEvent;

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
  reconnect(runId: string): PublicLoginRun;
  listRuns(): LoginRunListResponse;
  getRun(runId: string): PublicLoginRun;
  listScreenshots(runId: string): LoginScreenshotArtifactList;
  getScreenshot(runId: string, fileName: string): LoginScreenshotArtifactFile;
  subscribe(runId: string, listener: LoginEventListener): () => void;
  whenSettled(runId: string): Promise<PublicLoginRun>;
  close(): Promise<void>;
}
