'use strict';
// Transport observations are declarations, not cryptographic model attestations.
const { family } = require('./model-family');
const UNKNOWN = 'unknown';
const TOOL_NAMES = new Set(['invoke_subagent', 'generate_image', 'image-generator', 'read_file', 'list_directory', 'grep_search', 'find_by_name', 'run_command', 'write_to_file', 'replace_file_content', 'call_mcp_tool', 'team_status', 'team_rules', 'team_work', 'codex_send', 'codex_status', 'codex_result', 'grok_send', 'grok_status', 'grok_result', 'web_search', 'command_execution', 'mcp_tool_call', 'web_search_call', 'file_change']);
const id = v => typeof v === 'string' && v !== UNKNOWN && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(v) ? v : null;
function toolNames(calls) {
  if (!Array.isArray(calls)) calls = calls ? [calls] : [];
  return [...new Set(calls.map(c => typeof c === 'string' ? c : c?.name || c?.tool || c?.function?.name).filter(n => TOOL_NAMES.has(n)))].slice(0, 64);
}
function forJob(job = {}, who = 'unknown') {
  const p = job.provenance || {};
  const requested = id(p.requested_text_model) || id(job.modelId) || id(job.requestedModel) || id(job.model);
  const reported = p.evidence_level === 'provider_reported' ? id(p.provider_reported_text_model) : null;
  const client = id(job.from) || id(p.authenticated_client) || UNKNOWN;
  return {
    schema_version: 1,
    orchestration_role: ['совет', 'проверка', 'текст'].includes(job.role) ? job.role : UNKNOWN,
    authenticated_client: client,
    client_identity_evidence: 'configured_client_label_not_authentication',
    agent_instance: id(job.threadId) || id(job.id) || UNKNOWN,
    transport: ({antigravity: 'agy-cli', codex: 'codex-cli', grok: 'grok-webhook'})[who] || UNKNOWN,
    requested_text_model: requested || UNKNOWN,
    provider_reported_text_model: reported || UNKNOWN,
    evidence_level: reported ? 'provider_reported' : requested ? 'requested_only' : UNKNOWN,
    delegated_tool_chain: toolNames(p.delegated_tool_chain),
    delegation_evidence: p.delegation_evidence === 'structured_cli_events' ? p.delegation_evidence : UNKNOWN,
    artifact_generator_service: UNKNOWN,
    provider_reported_artifact_model: UNKNOWN,
  };
}
function observe(job, who, observation = {}) {
  const p = forJob(job, who);
  // Caller must supply a documented structured protocol field, never model prose.
  if (observation.source === 'structured_provider_model_field' && id(observation.reportedModel)) {
    p.provider_reported_text_model = observation.reportedModel;
    p.evidence_level = 'provider_reported';
  }
  const names = toolNames(observation.toolNames);
  p.delegated_tool_chain = toolNames([...p.delegated_tool_chain, ...names]);
  if (names.length) p.delegation_evidence = 'structured_cli_events';
  job.provenance = p;
  return p;
}
function agyObservation(raw, obj) {
  const calls = [...(Array.isArray(obj?.tool_calls || obj?.toolCalls) ? obj.tool_calls || obj.toolCalls : [])];
  for (const line of String(raw || '').split(/\r?\n/)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.event === 'step_update' && e.step_update?.step_type === 'tool')
      calls.push({ name: e.step_update.tool_info?.name || e.step_update.tool_name });
  }
  // Current agy schema has no documented provider-reported model field.
  return { toolNames: toolNames(calls) };
}
function codexObservation(e) {
  return { toolNames: ['item.started', 'item.completed'].includes(e?.type) ? toolNames([{name: e.item?.type}]) : [] };
}
function reviewerInfo(job, who) {
  const p = forJob(job, who);
  const requested = family(p.requested_text_model), reported = family(p.provider_reported_text_model);
  // Model aliases may differ within a family; unknown reported families cannot corroborate requests.
  const mismatch = !!(requested && p.evidence_level === 'provider_reported' && requested !== reported);
  const routeFamily = ({codex: 'openai', grok: 'xai'})[who] || null;
  return { ...p, family: reported || requested || routeFamily, family_evidence: reported ? 'provider_reported' : requested ? 'requested_only' : routeFamily ? 'configured_route' : UNKNOWN, mismatch };
}
function format(job, who) {
  const p = reviewerInfo(job, who);
  return `Роль: ${p.orchestration_role}; клиент: ${p.authenticated_client} (метка конфигурации); маршрут: ${p.transport}; запрошено: ${p.requested_text_model}; объявлено провайдером: ${p.provider_reported_text_model}; доказательство: ${p.evidence_level}; семья: ${p.family || UNKNOWN} (${p.family_evidence})${p.mismatch ? '; НЕСОВПАДЕНИЕ СЕМЬИ' : ''}${job?.cancellation ? '; остановка вложенных исполнителей: неизвестна' : ''}.`;
}
module.exports = { forJob, observe, reviewerInfo, format, agyObservation, codexObservation, toolNames };
