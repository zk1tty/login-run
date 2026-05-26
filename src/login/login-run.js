class LoginRun {
  constructor(input) {
    this.runId = input.runId;
    this.customerId = input.customerId;
    this.targetUrl = input.targetUrl;
    this.createdAt = input.now;
    this.updatedAt = input.now;
    this.completedAt = null;
    this.status = 'running';
    this.state = 'authing';
    this.result = null;
    this.error = null;
    this.privateState = {
      checkpoint: null,
      activeTask: null,
    };
  }

  getStatus() {
    return this.status;
  }

  getState() {
    return this.state;
  }

  getCheckpoint() {
    return this.privateState.checkpoint;
  }

  getActiveTask() {
    return this.privateState.activeTask;
  }

  setActiveTask(task) {
    this.privateState.activeTask = task;
  }

  markRunning(now, patch = {}) {
    this.status = 'running';
    this.state = 'authing';
    this.completedAt = null;
    this.applyPatch(now, patch);
  }

  markWaitingForOtp(now, result, checkpoint) {
    this.status = 'waiting_input';
    this.state = 'need_otp';
    this.completedAt = null;
    this.applyPatch(now, {
      result,
      error: null,
      checkpoint,
    });
  }

  markSucceeded(now, result, checkpoint) {
    this.status = 'succeeded';
    this.state = 'authed';
    this.completedAt = now;
    this.applyPatch(now, {
      result,
      error: null,
      checkpoint,
    });
  }

  markFailed(now, error, patch = {}) {
    this.status = 'failed';
    this.state = 'failed';
    this.completedAt = now;
    this.applyPatch(now, {
      ...patch,
      error,
    });
  }

  toPublicJson() {
    return {
      runId: this.runId,
      customerId: this.customerId,
      targetUrl: this.targetUrl,
      status: this.status,
      state: this.state,
      nextActions:
        this.status === 'waiting_input' && this.state === 'need_otp'
          ? ['otp']
          : [],
      result: this.result,
      error: this.error,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      completedAt: this.completedAt,
    };
  }

  applyPatch(now, patch) {
    this.updatedAt = now;

    if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
      this.result = patch.result ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) {
      this.error = patch.error ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'checkpoint')) {
      this.privateState.checkpoint = patch.checkpoint ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'activeTask')) {
      this.privateState.activeTask = patch.activeTask ?? null;
    }
  }
}

module.exports = {
  LoginRun,
};
