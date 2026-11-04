const { runUserPipeline } = require('./user-pipeline');
const { runVideoPipeline } = require('./video-pipeline');
const { runDmPhase, runDmTest, runDmDispatch } = require('./dm-phase');

/**
 * AI拓客入口：按 type 分线
 * @param {number} accountId
 * @param {object} payload
 */
async function runAiLead(accountId, payload = {}) {
  const type = String(payload.type || 'user').toLowerCase();
  if (type === 'video') {
    return runVideoPipeline(accountId, payload);
  }
  if (type === 'dm' || type === 'dm_test' || type === 'ai_lead_dm') {
    return runDmTest(accountId, payload);
  }
  return runUserPipeline(accountId, payload);
}

const { abortLeadRun, isAbortError, AbortError } = require('./pipeline-base');

module.exports = {
  runAiLead,
  runUserPipeline,
  runVideoPipeline,
  runDmPhase,
  runDmTest,
  runDmDispatch,
  abortLeadRun,
  isAbortError,
  AbortError,
};
