'use strict';
const fs = require('fs'), path = require('path');
const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MOST_TOAST_DATA)) | ConvertFrom-Json
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($data.title)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode($data.text)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
`;
async function notify(title, text, state = require('./paths').stateDir) {
  const record = { at: new Date().toISOString(), title: String(title), text: String(text) };
  try {
    const mode = process.env.MOST_NOTIFY;
    if (mode === 'off') record.result = 'отключено';
    else if (mode?.startsWith('file:')) {
      fs.appendFileSync(mode.slice(5), JSON.stringify(record) + '\n'); record.result = 'передано системе';
    } else if (process.platform !== 'win32') record.result = 'ошибка: уведомления Windows недоступны';
    else {
      await new Promise((resolve, reject) => require('child_process').execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
          windowsHide: true, timeout: 10000, env: { ...process.env, MOST_TOAST_DATA: Buffer.from(JSON.stringify(record)).toString('base64') },
        }, e => e ? reject(Error('не удалось показать уведомление')) : resolve()));
      record.result = 'передано системе';
    }
  } catch { record.result = 'ошибка: не удалось показать уведомление'; }
  try { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'notify.log'), JSON.stringify(record) + '\n'); }
  catch { record.result += '; ошибка записи журнала'; }
  return record.result;
}
function transition(who, before, job) {
  if (require('./access').guest()) return;
  const work = job.workName || (typeof job.work === 'string' ? job.work : '');
  if (before?.status !== job.status) {
    if (job.status === 'waiting_quota') void notify(who + ' ждёт квоту', `Поручение ${job.id} (работа ${work || 'не указана'}) продолжится само в ${job.nextAttemptAt}. Вам ничего делать не нужно.`);
    if (before?.status === 'waiting_quota' && job.status === 'running') void notify(`${who} продолжил поручение ${job.id}`, work);
    if (job.status === 'failed') void notify(`${who}: поручение ${job.id} не выполнено — ${job.error || job.problems?.join('; ') || 'ошибка'}. Решение за Claude.`, work);
    if (job.status === 'needs_decision' && job.retryKind === 'quota') void notify(`Codex: поручение ${job.id} с записью остановлено из-за квоты. Решение за Claude; вам ничего делать не нужно.`, work);
  }
}
module.exports = { notify, transition, script };
