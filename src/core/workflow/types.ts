import type { PuppeteerPageAdapterLike } from '../puppeteer/types';

export type CandidateKind = {
  tag?: string;
  type?: string;
  role?: string;
  selector?: string;
  index?: number;
  text?: string;
  ariaLabel?: string;
  id?: string;
  name?: string;
  label?: string;
  value?: string;
  visible?: boolean;
  disabled?: boolean;
  focusable?: boolean;
  valueLength?: number;
  boundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  options?: Array<{
    value?: string;
    text?: string;
  }>;
};

export type WorkflowStageSnapshot = {
  state?: string;
  phase?: string;
  reason?: string;
  selector?: string;
  terminalOutcome?: string;
};

export type RuntimeInventory = {
  stage?: WorkflowStageSnapshot;
  candidates?: CandidateKind[];
  challenge?: {
    visible?: boolean;
    challengeVisible?: boolean;
    textLength?: number;
  };
  pageTitle?: string;
  currentUrl?: string;
  currentTitle?: string;
  observed?: unknown;
};

export type PlanAction = {
  type:
    | 'none'
    | 'pause'
    | 'fill_input_and_submit'
    | 'click_candidate'
    | 'select_option'
    | 'select_delivery_and_submit';
  stage?: string;
  selector?: string;
  candidate?: CandidateKind | null;
  inputSelector?: string;
  inputCandidate?: CandidateKind | null;
  submitSelector?: string;
  submitCandidate?: CandidateKind | null;
  optionSelector?: string;
  optionCandidate?: CandidateKind | null;
  payloadKey?: string;
  payloadValue?: string;
  typedLength?: number;
  shouldSubmit?: boolean;
  terminalOutcome?: string;
  reason?: string;
  detail?: Record<string, unknown>;
  selection?: string;
};

export type PlannerInput = {
  stage?: WorkflowStageSnapshot;
  inventory?: RuntimeInventory;
  payload?: Record<string, string>;
  deliverySelection?: string;
};

export type ExecutorInput = {
  plan: PlanAction;
  runtime: {
    getDriverPage: () => PuppeteerPageAdapterLike | null;
  };
  payload?: Record<string, string>;
};

export type PageStableInput = {
  timeoutMs?: number;
  pollMs?: number;
  quietMs?: number;
  minStablePolls?: number;
  selectors?: string[];
};

export type PageStableTarget = {
  selector: string;
  inputSelector?: string;
  optionSelector?: string;
  submitSelector?: string;
  candidate?: CandidateKind;
  inputCandidate?: CandidateKind;
  optionCandidate?: CandidateKind;
  submitCandidate?: CandidateKind;
};

export type CaptchaSnapshot = {
  title?: string;
  url?: string;
  iframeCount?: number;
  tokenLength?: number;
  hasChallengeText?: boolean;
  hasVerifyingText?: boolean;
  hasSecurityCheckPassedText?: boolean;
  challengeVisible?: boolean;
};

export type ManualSolverResult = {
  solved: boolean;
  reason?: string;
  detail?: string;
  elapsedMs?: number;
};

export type WorkflowCheckpointSession = {
  id?: string;
  connect?: string;
  stop?: string;
  ttlMs?: number;
  processKeepAliveMs?: number;
};

export type WorkflowCheckpoint = {
  version?: number;
  createdAt?: string;
  mode?: string;
  phase?: string;
  targetUrl?: string;
  currentUrl?: string;
  pageTitle?: string;
  detachedAt?: string;
  observed?: WorkflowObservedSummary;
  stage?: WorkflowStageSnapshot;
  session?: WorkflowCheckpointSession;
  runDir?: string;
};

export type WorkflowObservedSummary = {
  candidateCount?: number;
  visibleCandidateCount?: number;
  visibleEnabledCandidateCount?: number;
  inputCount?: number;
  visibleEnabledInputCount?: number;
  buttonLikeCount?: number;
  visibleEnabledButtonLikeCount?: number;
};

export type WorkflowResult = {
  phase?: string;
  targetUrl?: string;
  currentUrl?: string;
  pageTitle?: string;
  terminalOutcome?: string;
  stage?: WorkflowStageSnapshot | null;
  session?: WorkflowCheckpointSession;
  detachedAt?: string;
  observed?: WorkflowObservedSummary;
};

export type RuntimeRunInput = {
  targetUrl: string;
  waitMs?: number;
  phase?: 'bootstrap' | 'reconnect';
  connectTimeoutMs?: number | string;
  payload?: Record<string, string>;
  checkpoint?: WorkflowCheckpoint | null;
  workflowEnabled?: boolean;
  maxActions?: number | string;
  actionWaitMs?: number | string;
  ttlMs?: number | string;
  processKeepAliveMs?: number | string;
};

export type RuntimeRunResult = WorkflowResult;
