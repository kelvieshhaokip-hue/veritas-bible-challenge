export type EmailTemplateKind = 'registration' | 'payment' | 'access_code' | 'submission';

export type EmailTemplateData = {
  participantName: string;
  competitionName: string;
  accessCode?: string;
  score?: number;
  competitionDate?: string;
  competitionEnd?: string;
  appUrl?: string;
};

export function renderEmailTemplate(kind: EmailTemplateKind, data: EmailTemplateData) {
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
  const subjectCompetition = String(data.competitionName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
  const name = escapeHtml(data.participantName);
  const competition = escapeHtml(data.competitionName);
  const appUrl = escapeHtml(data.appUrl || '');
  let subject = '';
  let heading = '';
  let message = '';
  let details = '';

  if (kind === 'registration') {
    subject = 'Welcome to ' + subjectCompetition;
    heading = 'Welcome, ' + name + '!';
    message = 'Your registration is complete. We are glad you will be part of ' + competition + '.';
    details = 'You can sign in any time to review your participant profile and entry status.';
  } else if (kind === 'payment' || kind === 'access_code') {
    subject = kind === 'payment' ? 'Payment confirmed for ' + subjectCompetition : 'Your access code for ' + subjectCompetition;
    heading = kind === 'payment' ? 'Payment confirmed' : 'Your competition access code';
    message = 'Hello ' + name + ', your entry for ' + competition + ' is confirmed.';
    details = '<p><strong>Access code:</strong> ' + escapeHtml(data.accessCode || '') + '</p><p>Sign in, open Competition, and enter your access code when the event window opens.' + (data.competitionDate ? ' The competition begins ' + escapeHtml(data.competitionDate) + (data.competitionEnd ? ' and ends ' + escapeHtml(data.competitionEnd) : '') + '.' : '') + '</p>';
  } else {
    subject = 'Your ' + subjectCompetition + ' submission is complete';
    heading = 'Submission received';
    message = 'Thank you, ' + name + '. Your answers for ' + competition + ' have been submitted.';
    details = '<p><strong>Your score:</strong> ' + Number(data.score || 0) + ' points</p><p>Results and rankings are available on the competition leaderboard.</p>';
  }

  const textDetails = kind === 'payment' || kind === 'access_code'
    ? 'Access code: ' + (data.accessCode || '') + '\nSign in, open Competition, and enter your access code when the event window opens.' + (data.competitionDate ? '\nCompetition: ' + data.competitionDate + (data.competitionEnd ? ' – ' + data.competitionEnd : '') : '')
    : kind === 'submission'
      ? 'Your score: ' + Number(data.score || 0) + ' points. Results and rankings are available on the competition leaderboard.'
      : 'You can sign in any time to review your participant profile and entry status.';

  const html = '<!doctype html><html><body style="margin:0;padding:32px;background:#f3f4ee;font-family:Arial,sans-serif;color:#304437"><main style="max-width:600px;margin:auto;padding:32px;background:#fffefa;border:1px solid #e3e6dd"><p style="font-size:12px;letter-spacing:2px;color:#718075">' + competition + '</p><h1 style="font-size:26px">' + heading + '</h1><p style="line-height:1.7">' + message + '</p>' + details + (appUrl ? '<p><a href="' + appUrl + '" style="color:#52735c">Open your participant dashboard</a></p>' : '') + '<p style="margin-top:30px;color:#758075;font-size:12px">Rooted in the Word. Growing together.</p></main></body></html>';
  const text = data.competitionName + '\n\n' + heading.replace(/<[^>]*>/g, '') + '\n' + message.replace(/<[^>]*>/g, '') + '\n\n' + textDetails + (data.appUrl ? '\n\nParticipant dashboard: ' + data.appUrl : '');
  return { subject, html, text };
}
