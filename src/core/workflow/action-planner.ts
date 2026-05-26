import type { CandidateKind, PlanAction, PlannerInput, WorkflowStageSnapshot } from './types';

type StageInput = NonNullable<PlannerInput['stage']>;
type InventoryInput = {
  candidates?: CandidateKind[];
};

type CandidateSearchInput = {
  stage: WorkflowStageSnapshot;
  inventory: InventoryInput;
  payload: Record<string, string>;
  deliverySelection?: string;
};

type CandidateSelectorInput = {
  stage?: string;
  selection?: string;
  terminalOutcome?: string;
  candidate?: CandidateKind | null;
  inputCandidate?: CandidateKind | null;
  optionCandidate?: CandidateKind | null;
  submitCandidate?: CandidateKind | null;
};

type CandidatePayloadSelectorInput = Omit<CandidateSelectorInput, 'candidate'>;

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isButtonLike(candidate: CandidateKind): boolean {
  const tag = String(candidate.tag || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const role = String(candidate.role || '').toLowerCase();
  return (
    tag === 'button' ||
    role === 'button' ||
    (tag === 'input' && (type === 'submit' || type === 'button'))
  );
}

function findCandidateBySelector(candidates: CandidateKind[], selector: unknown): CandidateKind | null {
  const normalizedSelector = String(selector || '').trim();
  if (!normalizedSelector) {
    return null;
  }
  return candidates.find(item => String(item.selector || '') === normalizedSelector) || null;
}

function candidateSearchText(candidate: CandidateKind): string {
  return [
    candidate.text,
    candidate.ariaLabel,
    candidate.id,
    candidate.name,
    candidate.selector,
    ...(Array.isArray(candidate.label) ? candidate.label : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function candidateArea(candidate: CandidateKind): number {
  const box = candidate.boundingBox || {};
  return Number(box.width || 0) * Number(box.height || 0);
}

function scoreSubmitCandidate(candidate: CandidateKind, inputCandidate: CandidateKind): number {
  const tag = String(candidate.tag || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const role = String(candidate.role || '').toLowerCase();
  const text = candidateSearchText(candidate);
  const area = candidateArea(candidate);
  const inputIndex = asNumber(inputCandidate.index, 0);
  const candidateIndex = asNumber(candidate.index, 0);
  const indexDistance = Math.abs(candidateIndex - inputIndex);
  const isAfterInput = candidateIndex > inputIndex;
  let score = 0;

  if (tag === 'button') {
    score += 20;
  }
  if (tag === 'input' && type === 'submit') {
    score += 35;
  }
  if (type === 'submit') {
    score += 30;
  }
  if (role === 'button') {
    score += 8;
  }
  if (isAfterInput) {
    score += 12;
  }

  if (/\b(log in|login|sign in|signin|continue|submit|next|verify|confirm|send)\b/.test(text)) {
    score += 100;
  }
  if (/\b(show password|hide password|clear|help|feedback|remember)\b/.test(text)) {
    score -= 100;
  }

  if (area > 2000) {
    score += 12;
  }
  if (area > 0 && area < 800) {
    score -= 20;
  }

  score -= Math.min(indexDistance, 20);
  return score;
}

function findSubmitCandidate(candidates: CandidateKind[], inputCandidate: CandidateKind | null): CandidateKind | null {
  if (!inputCandidate) {
    return null;
  }

  const buttonLike = candidates
    .filter(item => item.visible === true && isButtonLike(item))
    .map(item => ({
      candidate: item,
      score: scoreSubmitCandidate(item, inputCandidate),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return Number(a.candidate.index || 0) - Number(b.candidate.index || 0);
    });

  return buttonLike[0]?.candidate || null;
}

function createNoopPlan(reason: string, detail: Record<string, unknown> = {}): PlanAction {
  return {
    type: 'none',
    reason,
    detail,
  };
}

function createPausePlan(reason: string, detail: Record<string, unknown> = {}): PlanAction {
  return {
    type: 'pause',
    terminalOutcome: 'need_otp',
    reason,
    detail,
  };
}

function toInputCandidatePayload(candidate: CandidateKind | null): CandidateKind | null {
  if (!candidate) {
    return null;
  }
  return {
    selector: candidate.selector,
    index: candidate.index,
    tag: candidate.tag,
    type: candidate.type,
    label: candidate.label,
    visible: candidate.visible,
    disabled: candidate.disabled,
    focusable: candidate.focusable,
    valueLength: candidate.valueLength,
  };
}

function toSubmitCandidatePayload(candidate: CandidateKind | null): CandidateKind | null {
  if (!candidate) {
    return null;
  }
  return {
    selector: candidate.selector,
    index: candidate.index,
    tag: candidate.tag,
    type: candidate.type,
    role: candidate.role,
    text: candidate.text,
    visible: candidate.visible,
    disabled: candidate.disabled,
    focusable: candidate.focusable,
  };
}

function createClickPlan(input: CandidateSelectorInput): PlanAction {
  return {
    type: 'click_candidate',
    stage: input.stage,
    selector: input.candidate?.selector,
    candidate: toSubmitCandidatePayload(input.candidate || null),
    terminalOutcome: input.terminalOutcome || '',
  };
}

function createSelectPlan(input: CandidateSelectorInput): PlanAction {
  const selection = String(input.selection || '').trim();
  return {
    type: 'select_option',
    stage: input.stage,
    selector: input.candidate?.selector,
    candidate: toInputCandidatePayload(input.candidate || null),
    selection,
    terminalOutcome: input.terminalOutcome || '',
  };
}

function createDeliveryPlan(input: CandidateSelectorInput): PlanAction {
  return {
    type: 'select_delivery_and_submit',
    stage: input.stage,
    selection: input.selection,
    optionSelector: input.optionCandidate?.selector,
    optionCandidate: toInputCandidatePayload(input.optionCandidate || null),
    submitSelector: input.submitCandidate?.selector || '',
    submitCandidate: toSubmitCandidatePayload(input.submitCandidate || null),
    terminalOutcome: 'need_otp',
  };
}

function createFillPlan(input: CandidatePayloadSelectorInput & {
  payloadKey?: string;
  payloadValue?: string;
  shouldSubmit?: boolean;
}): PlanAction {
  const payloadValue = String(input.payloadValue || '').trim();
  const submitCandidate = input.submitCandidate || null;
  return {
    type: 'fill_input_and_submit',
    stage: input.stage,
    inputSelector: input.inputCandidate?.selector,
    inputCandidate: toInputCandidatePayload(input.inputCandidate || null),
    submitSelector: submitCandidate?.selector || '',
    submitCandidate: toSubmitCandidatePayload(submitCandidate),
    payloadKey: input.payloadKey,
    typedLength: payloadValue.length,
    shouldSubmit: input.shouldSubmit,
  };
}

function optionMatchesSelection(option: { text?: string; value?: string }, selection = ''): boolean {
  const wanted = String(selection || '').trim().toLowerCase();
  if (!wanted) {
    return false;
  }
  const text = String(option.text || '').toLowerCase();
  const value = String(option.value || '').toLowerCase();
  return text.includes(wanted) || value.includes(wanted);
}

function candidateMatchesDeliverySelection(candidate: CandidateKind, selection = ''): boolean {
  const wanted = String(selection || '').trim().toLowerCase();
  if (!wanted) {
    return false;
  }
  const text = candidateSearchText(candidate);
  if (wanted === 'email') {
    return /\bemail\b/.test(text);
  }
  if (wanted === 'phone' || wanted === 'sms' || wanted === 'text') {
    return /\b(phone|sms|text message|voice call)\b/.test(text);
  }
  return text.includes(wanted);
}

function scoreDeliveryOption(candidate: CandidateKind, selection = ''): number {
  const tag = String(candidate.tag || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const text = candidateSearchText(candidate);
  let score = 0;

  if (tag === 'input' && type === 'radio') {
    score += 80;
  }
  if (candidateMatchesDeliverySelection(candidate, selection)) {
    score += 120;
  }
  if (text.includes('do not recognize') || text.includes('contact member services')) {
    score -= 200;
  }
  if (candidate.disabled === true) {
    score -= 100;
  }
  return score;
}

function findDeliveryOptionCandidate(candidates: CandidateKind[], selection: string): CandidateKind | null {
  return candidates
    .filter(item => item.disabled !== true)
    .map(item => ({
      candidate: item,
      score: scoreDeliveryOption(item, selection),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return Number(a.candidate.index || 0) - Number(b.candidate.index || 0);
    })[0]?.candidate || null;
}

function findDeliverySubmitCandidate(candidates: CandidateKind[], optionCandidate: CandidateKind | null): CandidateKind | null {
  const optionIndex = Number(optionCandidate?.index || 0);
  return candidates
    .filter(item => item.visible === true && isButtonLike(item))
    .map(item => {
      const text = candidateSearchText(item);
      let score = scoreSubmitCandidate(item, optionCandidate || item);
      if (/\b(send confirmation code|send code|send verification|continue|next)\b/.test(text)) {
        score += 150;
      }
      if (Number(item.index || 0) > optionIndex) {
        score += 20;
      }
      return { candidate: item, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return Number(a.candidate.index || 0) - Number(b.candidate.index || 0);
    })[0]?.candidate || null;
}

export function planRuntimeAction(input: PlannerInput = {}): PlanAction {
  const stage = input.stage || ({} as StageInput);
  const inventory = (input.inventory || {}) as InventoryInput;
  const payload = input.payload || {};
  const deliverySelection = String(input.deliverySelection || '').trim();
  const candidates = Array.isArray(inventory.candidates) ? inventory.candidates : [];

  if (stage.state === 'otp_code') {
    const code = String(payload.OTP_CODE || payload.LOGIN_OTP_CODE || '').trim();
    if (!code) {
      return createPausePlan('need_otp_code', {
        stage: stage.state,
        selector: stage.selector || '',
      });
    }
    const otpCandidate = findCandidateBySelector(candidates, stage.selector);
    if (!otpCandidate) {
      return createNoopPlan('otp_candidate_not_found', {
        selector: stage.selector || '',
      });
    }
    return createFillPlan({
      stage: stage.state,
      inputCandidate: otpCandidate,
      submitCandidate: findSubmitCandidate(candidates, otpCandidate),
      payloadKey: payload.OTP_CODE ? 'OTP_CODE' : 'LOGIN_OTP_CODE',
      payloadValue: code,
      shouldSubmit: true,
    });
  }

  if (stage.state === 'otp_delivery_selection') {
    const selection = deliverySelection || String(payload.OTP_DELIVERY_SELECTION || payload.OTP_SELECTION || '').trim();
    if (!selection) {
      return createPausePlan('missing_OTP_DELIVERY_SELECTION', {
        stage: stage.state,
        selector: stage.selector || '',
      });
    }
    const deliveryCandidate =
      findDeliveryOptionCandidate(candidates, selection) ||
      findCandidateBySelector(candidates, stage.selector);
    if (!deliveryCandidate) {
      return createNoopPlan('otp_delivery_candidate_not_found', {
        selector: stage.selector || '',
      });
    }

    if (String(deliveryCandidate.tag || '').toLowerCase() === 'select') {
      const options = Array.isArray(deliveryCandidate.options) ? deliveryCandidate.options : [];
      const matched = options.find(option => optionMatchesSelection(option as { text?: string; value?: string }, selection));
      if (!matched) {
        return createNoopPlan('otp_delivery_option_not_found', {
          selector: stage.selector || '',
          selection,
        });
      }
      return createSelectPlan({
        stage: stage.state,
        candidate: deliveryCandidate,
        selection,
        terminalOutcome: 'need_otp',
      });
    }

    const submitCandidate = findDeliverySubmitCandidate(candidates, deliveryCandidate);
    if (String(deliveryCandidate.tag || '').toLowerCase() === 'input' &&
        String(deliveryCandidate.type || '').toLowerCase() === 'radio') {
      return createDeliveryPlan({
        stage: stage.state,
        selection,
        optionCandidate: deliveryCandidate,
        submitCandidate,
      });
    }

    return createClickPlan({
      stage: stage.state,
      candidate: deliveryCandidate,
      terminalOutcome: 'need_otp',
    });
  }

  const isSupportedStage =
    stage.state === 'identifier' ||
    stage.state === 'id+pw' ||
    stage.state === 'password';
  if (!isSupportedStage) {
    return createNoopPlan('unsupported_stage', { stage: stage.state || 'unknown' });
  }

  if (stage.state === 'password') {
    const password = String(payload.LOGIN_PASSWORD || '').trim();
    if (!password) {
      return createNoopPlan('missing_LOGIN_PASSWORD');
    }
    const passwordCandidate = findCandidateBySelector(candidates, stage.selector);
    if (!passwordCandidate) {
      return createNoopPlan('password_candidate_not_found', {
        selector: stage.selector || '',
      });
    }
    return createFillPlan({
      stage: stage.state,
      inputCandidate: passwordCandidate,
      submitCandidate: findSubmitCandidate(candidates, passwordCandidate),
      payloadKey: 'LOGIN_PASSWORD',
      payloadValue: password,
      shouldSubmit: true,
    });
  }

  if (stage.state === 'id+pw') {
    const identifierCandidate = findCandidateBySelector(candidates, stage.identifierSelector);
    if (!identifierCandidate) {
      return createNoopPlan('identifier_candidate_not_found', {
        selector: stage.identifierSelector || '',
      });
    }

    if (Number(identifierCandidate.valueLength || 0) <= 0) {
      const username = String(payload.LOGIN_USERNAME || '').trim();
      if (!username) {
        return createNoopPlan('missing_LOGIN_USERNAME');
      }
      return createFillPlan({
        stage: stage.state,
        inputCandidate: identifierCandidate,
        submitCandidate: findSubmitCandidate(candidates, identifierCandidate),
        payloadKey: 'LOGIN_USERNAME',
        payloadValue: username,
        shouldSubmit: false,
      });
    }

    const password = String(payload.LOGIN_PASSWORD || '').trim();
    if (!password) {
      return createNoopPlan('missing_LOGIN_PASSWORD');
    }
    const passwordCandidate = findCandidateBySelector(candidates, stage.passwordSelector);
    if (!passwordCandidate) {
      return createNoopPlan('password_candidate_not_found', {
        selector: stage.passwordSelector || '',
      });
    }
    return createFillPlan({
      stage: stage.state,
      inputCandidate: passwordCandidate,
      submitCandidate: findSubmitCandidate(candidates, passwordCandidate),
      payloadKey: 'LOGIN_PASSWORD',
      payloadValue: password,
      shouldSubmit: true,
    });
  }

  const username = String(payload.LOGIN_USERNAME || '').trim();
  if (!username) {
    return createNoopPlan('missing_LOGIN_USERNAME');
  }

  const inputCandidate = findCandidateBySelector(candidates, stage.selector);
  if (!inputCandidate) {
    return createNoopPlan('identifier_candidate_not_found', {
      selector: stage.selector || '',
    });
  }

  return createFillPlan({
    stage: stage.state,
    inputCandidate,
    submitCandidate: findSubmitCandidate(candidates, inputCandidate),
    payloadKey: 'LOGIN_USERNAME',
    payloadValue: username,
    shouldSubmit: true,
  });
}
