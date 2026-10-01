import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Clock3, LayoutDashboard, Plus, ShieldCheck, Trophy, Users, WalletCards, X } from 'lucide-react';
import { translate as t } from './i18n';

type Props = { token: string; flash: (message: string) => void };
type QuestionTranslationDraft = { prompt: string; options: string[] };
type QuestionDraft = { id?: string; prompt: string; options: string[]; translations: Record<'kck' | 'ta', QuestionTranslationDraft>; correct_index: number; points: number; category: string; difficulty: string };
const emptyTranslations = (count = 4): Record<'kck' | 'ta', QuestionTranslationDraft> => ({ kck: { prompt: '', options: Array(count).fill('') }, ta: { prompt: '', options: Array(count).fill('') } });
const api = async (path: string, options: RequestInit = {}, token?: string) => {
  const response = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};
const dateFmt = (date: string) => new Date(date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = (date: string) => new Date(date).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const numberFmt = (value: unknown) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function AdminDashboard({ token, flash }: Props) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState('overview');
  const [settings, setSettings] = useState<any>({});
  const [newQuestion, setNewQuestion] = useState<QuestionDraft | null>(null);
  const [searchText, setSearchText] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [questionCategory, setQuestionCategory] = useState('all');
  const [detail, setDetail] = useState<any>(null);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<any>(null);

  const reload = async () => {
    const overview = await api('/admin/overview', {}, token);
    setData(overview);
    setSettings(overview.settings);
  };
  useEffect(() => { if (token) void reload().catch(error => flash((error as Error).message)); }, [token]);

  if (!token) return <div className="page-wrap"><div className="center-card"><span className="feature-icon"><ShieldCheck /></span><h2>Admin sign-in required.</h2><p>Use the organizer account configured for this site to manage your challenge.</p></div></div>;
  if (!data) return <div className="page-wrap"><div className="center-card"><h2>Loading your dashboard…</h2></div></div>;

  const search = searchText.trim().toLowerCase();
  const filteredParticipants = data.participantsList.filter((row: any) => {
    const matchesSearch = [row.name, row.email, row.church, row.district].some(value => String(value || '').toLowerCase().includes(search));
    const matchesActive = activeFilter === 'all' || (activeFilter === 'active' ? Boolean(row.active) : !row.active);
    const matchesPayment = paymentFilter === 'all' || (paymentFilter === 'unpaid' ? !row.payment_id : row.payment === paymentFilter);
    return matchesSearch && matchesActive && matchesPayment;
  });
  const filteredQuestions = data.questionsList.filter((question: any) => questionCategory === 'all' || question.category === questionCategory);

  const saveSettings = async () => {
    try { await api('/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }, token); await reload(); flash('Competition settings saved.'); }
    catch (error) { flash((error as Error).message); }
  };
  const saveQuestion = async (question: QuestionDraft) => {
    try {
      const optionIndexes = question.options.map((option, index) => option.trim() ? index : -1).filter(index => index >= 0);
      const payload = { ...question, options: optionIndexes.map(index => question.options[index]), translations: { kck: { prompt: question.translations.kck.prompt, options: optionIndexes.map(index => question.translations.kck.options[index] || '') }, ta: { prompt: question.translations.ta.prompt, options: optionIndexes.map(index => question.translations.ta.options[index] || '') } } };
      await api('/admin/questions', { method: 'POST', body: JSON.stringify(payload) }, token);
      setNewQuestion(null); await reload(); flash(question.id ? 'Question updated.' : 'Question added.');
    } catch (error) { flash((error as Error).message); }
  };
  const deleteQuestion = async (id: string) => {
    if (!window.confirm('Delete this question from the question bank?')) return;
    try { await api('/admin/questions/' + id, { method: 'DELETE' }, token); await reload(); flash('Question deleted.'); }
    catch (error) { flash((error as Error).message); }
  };
  const resendEmail = async (id: string, type: 'payment' | 'access_code') => {
    try {
      const result = await api('/admin/participants/' + id + '/resend-email', { method: 'POST', body: JSON.stringify({ type }) }, token);
      await reload(); flash(result.status === 'sent' ? 'Email sent successfully.' : 'Email could not be delivered. Check email configuration and delivery status.');
    } catch (error) { flash((error as Error).message); }
  };
  const showParticipant = async (id: string) => {
    try { setDetail(await api('/admin/participants/' + id, {}, token)); }
    catch (error) { flash((error as Error).message); }
  };
  const resetAttempt = async (row: any) => {
    if (!window.confirm(`Reset ${row.name}'s quiz attempt and allow a retake? The current answers and score will be cleared.`)) return;
    try { await api('/admin/participants/' + row.id + '/reset', { method: 'POST' }, token); await reload(); if (detail?.participant?.id === row.id) await showParticipant(row.id); flash('Attempt reset. The participant can retake the quiz.'); }
    catch (error) { flash((error as Error).message); }
  };
  const toggleParticipant = async (row: any) => {
    const active = !Boolean(row.active);
    if (!window.confirm(`${active ? 'Enable' : 'Disable'} ${row.name}'s participant account?`)) return;
    try { await api('/admin/participants/' + row.id + '/status', { method: 'PUT', body: JSON.stringify({ active }) }, token); await reload(); flash(`Participant ${active ? 'enabled' : 'disabled'}.`); }
    catch (error) { flash((error as Error).message); }
  };
  const deleteParticipant = async (row: any) => {
    if (!window.confirm(`Permanently delete ${row.name} and their local participant, payment, email, and submission records? This does not refund an external payment.`)) return;
    try { await api('/admin/participants/' + row.id, { method: 'DELETE' }, token); setDetail(null); await reload(); flash('Participant and local records deleted.'); }
    catch (error) { flash((error as Error).message); }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { flash('Choose a file smaller than 5 MB.'); return; }
    setImporting(true); setImportSummary(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the selected file.')); reader.readAsDataURL(file); });
      const result = await api('/admin/questions/import', { method: 'POST', body: JSON.stringify({ fileName: file.name, content: dataUrl.slice(dataUrl.indexOf(',') + 1) }) }, token);
      setImportSummary(result); await reload(); flash(`Imported ${result.imported} question${result.imported === 1 ? '' : 's'}; ${result.failed} row${result.failed === 1 ? '' : 's'} failed.`);
    } catch (error) { flash((error as Error).message); }
    finally { setImporting(false); }
  };
  const downloadTemplate = () => {
    const csv = 'question_en,question_kuki,question_ta,option_a_en,option_a_kuki,option_a_ta,option_b_en,option_b_kuki,option_b_ta,option_c_en,option_c_kuki,option_c_ta,option_d_en,option_d_kuki,option_d_ta,correct_index,category,difficulty,points\n"Who built an ark at God’s command?",,,Abraham,,,Noah,,,Moses,,,David,,,1,Genesis,Easy,1\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'bible-competition-question-template.csv'; link.click(); URL.revokeObjectURL(url);
  };
  const downloadExport = () => {
    const headers = ['question_en','question_kuki','question_ta','option_a_en','option_a_kuki','option_a_ta','option_b_en','option_b_kuki','option_b_ta','option_c_en','option_c_kuki','option_c_ta','option_d_en','option_d_kuki','option_d_ta','correct_index','category','difficulty','points'];
    const quote = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    const rows = data.questionsList.map((question: any) => {
      const versions = question.translations || {}, english = versions.en || { prompt: question.prompt, options: question.options };
      const kuki = versions.kck || {}, tamil = versions.ta || {};
      const fields: unknown[] = [english.prompt || question.prompt,kuki.prompt,tamil.prompt];
      for (let index = 0; index < 4; index++) fields.push(english.options?.[index],kuki.options?.[index],tamil.options?.[index]);
      fields.push(question.correct_index,question.category,question.difficulty,question.custom_points ? question.points : 0);
      return fields.map(quote).join(',');
    });
    const url = URL.createObjectURL(new Blob(['\ufeff'+[headers.map(quote).join(','),...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'bible-competition-questions.csv'; link.click(); URL.revokeObjectURL(url);
  };
  const addCategory = async () => {
    const name = window.prompt('New category name'); if (!name?.trim()) return;
    try { await api('/admin/categories', { method: 'POST', body: JSON.stringify({ name }) }, token); await reload(); flash('Category created.'); }
    catch (error) { flash((error as Error).message); }
  };
  const editCategory = async (category: any) => {
    const name = window.prompt('Edit category name', category.name); if (!name?.trim() || name.trim() === category.name) return;
    try { await api('/admin/categories/' + category.id, { method: 'PUT', body: JSON.stringify({ name }) }, token); await reload(); flash('Category updated.'); }
    catch (error) { flash((error as Error).message); }
  };
  const deleteCategory = async (category: any) => {
    if (!window.confirm(`Delete ${category.name}? Its questions will move to General.`)) return;
    try { await api('/admin/categories/' + category.id, { method: 'DELETE' }, token); await reload(); flash('Category deleted.'); }
    catch (error) { flash((error as Error).message); }
  };

  const tabs: [string, any, string][] = [['overview', LayoutDashboard, t('overview')], ['participants', Users, t('participants')], ['questions', BookOpen, t('questions')], ['categories', BookOpen, t('categories')], ['analytics', Trophy, t('analytics')], ['settings', Clock3, t('competitionSetup')]];
  const stats = [[t('participants'), data.participants.n, Users], [t('paidParticipants'), data.paid.n, WalletCards], [t('questions'), data.questions.n, BookOpen], [t('totalSubmissions'), data.submitted.n, Check]];
  return <div className="page-wrap admin-wrap">
    <div className="admin-header"><div><div className="section-kicker">{t('organizerSpace').toUpperCase()}</div><h1>{t('admin')}.</h1><p>{t('adminSubtitle')}</p></div><span className="admin-badge"><ShieldCheck size={16} /> ADMIN</span></div>
    <div className="admin-layout"><aside className="admin-menu">{tabs.map(([id, Icon, label]) => <button key={id} className={tab === id ? 'admin-tab active-admin-tab' : 'admin-tab'} onClick={() => setTab(id)}><Icon size={17} />{label}</button>)}</aside><section className="admin-main">
      {tab === 'overview' && <><div className="stats-grid">{stats.map(([label, value, Icon]: any) => <div className="stat-card" key={label}><span><Icon size={17} /></span><small>{label}</small><strong>{numberFmt(value?.n ?? value)}</strong></div>)}</div><div className="admin-panel"><div className="panel-title"><div><h2>{t('recentParticipants')}</h2><p>{t('recentSummary')}</p></div><button className="text-link" onClick={() => setTab('participants')}>{t('manageParticipants')} <ArrowRight size={15} /></button></div><AdminParticipantTable rows={data.participantsList.slice(0, 5)} onView={showParticipant} onResend={resendEmail} onReset={resetAttempt} onToggle={toggleParticipant} onDelete={deleteParticipant} /></div><div className="admin-panel"><div className="panel-title"><div><h2>{t('schedule')}</h2><p>{t('scheduleHelp')}</p></div><button className="btn btn-outline" onClick={() => setTab('settings')}>{t('editSchedule')}</button></div><div className="schedule-summary"><Clock3 size={18} /><strong>{dateFmt(settings.competition_date)}</strong><span>{timeFmt(settings.competition_date)} – {timeFmt(settings.competition_end)}</span></div></div></>}

      {tab === 'participants' && <div className="admin-panel"><div className="panel-title"><div><h2>{t('manageParticipants')}</h2><p>{t('participantActionsHelp')}</p></div><span className="status-pill">{filteredParticipants.length} {t('matching').toUpperCase()}</span></div><div className="participant-filters"><label>{t('search')}<input value={searchText} onChange={event => setSearchText(event.target.value)} placeholder={t('searchPlaceholder')} /></label><label>{t('accountFilter')}<select value={activeFilter} onChange={event => setActiveFilter(event.target.value)}><option value="all">{t('allAccounts')}</option><option value="active">{t('enabled')}</option><option value="disabled">{t('disabled')}</option></select></label><label>{t('paymentFilter')}<select value={paymentFilter} onChange={event => setPaymentFilter(event.target.value)}><option value="all">{t('allPaymentStatuses')}</option><option value="paid">{t('paid')}</option><option value="pending">{t('pending')}</option><option value="failed">{t('failed')}</option><option value="refunded">{t('refunded')}</option><option value="unpaid">{t('unpaid')}</option></select></label></div><AdminParticipantTable rows={filteredParticipants} onView={showParticipant} onResend={resendEmail} onReset={resetAttempt} onToggle={toggleParticipant} onDelete={deleteParticipant} /></div>}

      {tab === 'questions' && <div className="admin-panel"><div className="panel-title question-tools"><div><h2>{t('questionBank')}</h2><p>{data.questionsList.length} of 1,000 questions · randomized order per participant.</p></div><div className="question-toolbar"><label>{t('filterCategory')}<select value={questionCategory} onChange={event => setQuestionCategory(event.target.value)}><option value="all">{t('allCategories')}</option>{data.categories.map((item: any) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><button className="btn btn-dark btn-sm" disabled={data.questionsList.length >= 1000} onClick={() => setNewQuestion({ prompt: '', options: ['', '', '', ''], translations: emptyTranslations(), correct_index: 0, points: 0, category: data.categories[0]?.name || 'General', difficulty: 'medium' })}><Plus size={15} /> {t('addQuestion')}</button></div></div><div className="bulk-import"><div><strong>{t('importQuestions')}</strong><small>{t('questionImportLimit')}</small><button className="text-link" onClick={downloadTemplate}>{t('downloadTemplate')}</button></div><div className="question-export-actions"><button className="btn btn-outline" onClick={downloadExport}>Export all questions</button><label className="btn btn-outline import-button">{importing ? 'Importing…' : t('chooseCsvExcel')}<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={importing} onChange={event => { void importFile(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label></div></div>{importSummary && <div className="import-summary" role="status"><strong>{importSummary.imported} imported · {importSummary.failed} failed · {importSummary.totalRows} total rows</strong>{importSummary.failedRows.length > 0 && <ul>{importSummary.failedRows.map((row: any) => <li key={row.rowNumber}>Row {row.rowNumber}: {row.errors.join(' ')}</li>)}</ul>}</div>}<div className="question-admin-list">{filteredQuestions.map((item: any) => <article className="question-admin" key={item.id}><div><span className="question-points">{item.effective_points} PT · {item.difficulty.toUpperCase()}</span><h3>{item.prompt}</h3><small>{item.category} · {item.options.length} options · Correct: {item.options[item.correct_index]}</small></div><div className="question-actions"><button className="text-link" onClick={() => setNewQuestion({ ...item, points: item.custom_points ? item.points : 0, options: [...item.options], translations: { kck: item.translations?.kck || emptyTranslations(item.options.length).kck, ta: item.translations?.ta || emptyTranslations(item.options.length).ta } })}>{t('edit')}</button><button className="delete-btn" onClick={() => void deleteQuestion(item.id)}>{t('delete')}</button></div></article>)}{filteredQuestions.length === 0 && <div className="table-empty">{t('noQuestionsInCategory')}</div>}</div></div>}

      {tab === 'categories' && <div className="admin-panel"><div className="panel-title"><div><h2>{t('questionCategories')}</h2><p>{t('categoryHelp')}</p></div><button className="btn btn-dark btn-sm" onClick={() => void addCategory()}><Plus size={15} /> {t('addCategory')}</button></div><div className="category-list">{data.categories.map((category: any) => <div className="category-row" key={category.id}><div><strong>{category.name}</strong><small>{data.questionsList.filter((question: any) => question.category === category.name).length} questions</small></div><div><button className="text-link" disabled={category.name.toLowerCase() === 'general'} onClick={() => void editCategory(category)}>{t('rename')}</button><button className="delete-btn" disabled={category.name.toLowerCase() === 'general'} onClick={() => void deleteCategory(category)}>{t('delete')}</button></div></div>)}</div></div>}

      {tab === 'analytics' && <AnalyticsDashboard analytics={data.analytics} />}

      {tab === 'settings' && <div className="admin-panel settings-panel"><div className="panel-title"><div><h2>{t('competitionSetup')}</h2><p>Configure the event, entry contribution, and scoring rules.</p></div></div><div className="settings-form"><label>{t('competitionTitle')}<input value={settings.competition_title || ''} onChange={event => setSettings({ ...settings, competition_title: event.target.value })} /></label><label>{t('startsAt')}<input type="datetime-local" value={new Date(settings.competition_date).toISOString().slice(0, 16)} onChange={event => setSettings({ ...settings, competition_date: new Date(event.target.value).toISOString() })} /></label><label>{t('endsAt')}<input type="datetime-local" value={new Date(settings.competition_end).toISOString().slice(0, 16)} onChange={event => setSettings({ ...settings, competition_end: new Date(event.target.value).toISOString() })} /></label><div className="two-inputs"><label>{t('entryFee')}<input type="number" min="1" step="1" value={settings.entry_fee} onChange={event => setSettings({ ...settings, entry_fee: event.target.value })} /></label><label>{t('currency')}<input value={settings.currency} maxLength={3} onChange={event => setSettings({ ...settings, currency: event.target.value.toUpperCase() })} /></label></div><div className="scoring-settings"><h3>{t('scoringRules')}</h3><p>{t('scoringHelp')}</p><div className="two-inputs"><label>{t('correctPoints')}<input type="number" min="0" max="100" step="0.25" value={settings.correct_answer_points} onChange={event => setSettings({ ...settings, correct_answer_points: event.target.value })} /></label><label>{t('wrongPenalty')}<input type="number" min="0" max="100" step="0.25" value={settings.wrong_answer_penalty} onChange={event => setSettings({ ...settings, wrong_answer_penalty: event.target.value })} /></label><label>{t('unansweredPenalty')}<input type="number" min="0" max="100" step="0.25" value={settings.unanswered_penalty} onChange={event => setSettings({ ...settings, unanswered_penalty: event.target.value })} /></label></div><small>{t('currentDefaults')}</small></div><label className="toggle-row"><span><strong>{t('registrationOpen')}</strong><small>{t('registrationHelp')}</small></span><input type="checkbox" checked={settings.registration_open === 'true'} onChange={event => setSettings({ ...settings, registration_open: String(event.target.checked) })} /></label><button className="btn btn-green" onClick={() => void saveSettings()}>{t('saveCompetitionSettings')} <Check size={16} /></button></div></div>}
    </section></div>
    {newQuestion && <QuestionEditor question={newQuestion} categories={data.categories} onClose={() => setNewQuestion(null)} onSave={saveQuestion} />}
    {detail && <ParticipantDetail detail={detail} onClose={() => setDetail(null)} />}
  </div>;
}

function AdminParticipantTable({ rows, onView, onResend, onReset, onToggle, onDelete }: { rows: any[]; onView: (id: string) => void; onResend: (id: string, type: 'payment' | 'access_code') => void; onReset: (row: any) => void; onToggle: (row: any) => void; onDelete: (row: any) => void }) {
  const languageName=(code:string)=>({en:'English',english:'English',kck:'Kuki',kuki:'Kuki',ta:'Tamil',tamil:'Tamil'} as Record<string,string>)[code]||'English';
  return <div className="participant-table"><div className="participant-head"><span>{t('participantLabel').toUpperCase()}</span><span>{t('phone').toUpperCase()}</span><span>{t('church').toUpperCase()}</span><span>{t('district').toUpperCase()} / {t('state').toUpperCase()}</span><span>LANGUAGE</span><span>{t('registeredLabel').toUpperCase()}</span><span>{t('paymentCodeLabel').toUpperCase()}</span><span>{t('emailStatus').toUpperCase()}</span><span>{t('score').toUpperCase()}</span><span>{t('actions').toUpperCase()}</span></div>{rows.length ? rows.map(row => <div className="participant-row" key={row.id}>
     <span data-label={t('participantLabel')}><strong>{row.name}</strong><small>{row.email}</small>{!row.active && <em className="disabled-label">DISABLED</em>}</span><span data-label={t('phone')}>{row.phone || '—'}</span><span data-label={t('church')}>{row.church || '—'}</span><span data-label={t('district') + ' / ' + t('state')}>{row.district || '—'} / {row.state || '—'}</span><span data-label="Language">{languageName(row.competition_language||row.preferred_language)}</span><span data-label={t('registeredLabel')}>{row.registration_date ? new Date(String(row.registration_date).replace(' ', 'T') + 'Z').toLocaleDateString('en-IN') : '—'}</span>
    <span data-label={t('paymentCodeLabel')} className={'payment-status ' + row.payment}>{String(row.payment || 'unpaid').toUpperCase()}{row.payment_id && <small>Payment ID: {row.payment_id}</small>}{row.payment_paid_at && <small>Paid: {new Date(row.payment_paid_at).toLocaleString('en-IN')}</small>}{row.code && <small>{row.payment === 'paid' ? 'Code: ' : 'Inactive code: '}{row.code}</small>}</span>
    <span data-label={t('emailStatus')} className="email-status-cell"><small>{t('registrationEmail')}: {row.registration_email_status || 'not sent'}</small><small>{t('paymentEmail')}: {row.payment_email_status || 'not sent'}</small><small>{t('submissionEmail')}: {row.submission_email_status || 'not sent'}</small>{row.payment === 'paid' && <><button onClick={() => onResend(row.id, 'access_code')}>{t('resendCodeEmail')}</button><button onClick={() => onResend(row.id, 'payment')}>{t('resendPaymentEmail')}</button></>}</span>
    <span data-label={t('score')}>{row.submitted_at ? numberFmt(row.score) + ' ' + t('points') : '—'}{row.warning_count > 0 && <small>{row.warning_count} {t('warnings')}</small>}</span>
    <span data-label={t('actions')} className="participant-actions"><button onClick={() => onView(row.id)}>{t('viewResults')}</button><button onClick={() => onReset(row)}>{t('resetRetake')}</button><button onClick={() => onToggle(row)}>{row.active ? t('disable') : t('enable')}</button><button className="delete-btn" onClick={() => onDelete(row)}>{t('delete')}</button></span>
  </div>) : <div className="table-empty">{t('noMatchingParticipants')}</div>}</div>;
}

function QuestionEditor({ question, categories, onClose, onSave }: { question: QuestionDraft; categories: any[]; onClose: () => void; onSave: (question: QuestionDraft) => void }) {
  const [draft, setDraft] = useState<QuestionDraft>({ ...question, options: [...question.options], translations: { kck: { prompt: question.translations?.kck?.prompt || '', options: question.options.map((_, index) => question.translations?.kck?.options?.[index] || '') }, ta: { prompt: question.translations?.ta?.prompt || '', options: question.options.map((_, index) => question.translations?.ta?.options?.[index] || '') } } });
  const [activeLanguage,setActiveLanguage]=useState<'en'|'kck'|'ta'>('en');
  const updateOption = (index: number, value: string) => setDraft(current => ({ ...current, options: current.options.map((option, position) => position === index ? value : option) }));
  const updateTranslationPrompt = (language: 'kck' | 'ta', prompt: string) => setDraft(current => ({ ...current, translations: { ...current.translations, [language]: { ...current.translations[language], prompt } } }));
  const updateTranslationOption = (language: 'kck' | 'ta', index: number, value: string) => setDraft(current => ({ ...current, translations: { ...current.translations, [language]: { ...current.translations[language], options: current.translations[language].options.map((option, position) => position === index ? value : option) } } }));
  const setOptionCount = (count: number) => setDraft(current => ({ ...current, options: current.options.slice(0, count).concat(Array(Math.max(0, count - current.options.length)).fill('')), translations: { kck: { ...current.translations.kck, options: current.translations.kck.options.slice(0, count).concat(Array(Math.max(0, count - current.translations.kck.options.length)).fill('')) }, ta: { ...current.translations.ta, options: current.translations.ta.options.slice(0, count).concat(Array(Math.max(0, count - current.translations.ta.options.length)).fill('')) } }, correct_index: Math.min(current.correct_index, count - 1) }));
  const incomplete=activeLanguage!=='en'&&(!draft.translations[activeLanguage].prompt.trim()||draft.translations[activeLanguage].options.some(option=>!option.trim()));
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><form className="auth-modal question-modal" onSubmit={event => { event.preventDefault(); onSave(draft); }}><button type="button" className="modal-close" onClick={onClose}><X /></button><div className="section-kicker">QUESTION BANK</div><h2>{draft.id ? 'Edit question.' : 'Add a question.'}</h2><div className="language-editor-tabs" role="tablist" aria-label="Question language">{([['en','English'],['kck','Kuki'],['ta','Tamil']] as const).map(([code,label])=><button key={code} type="button" role="tab" aria-selected={activeLanguage===code} className={activeLanguage===code?'active':''} onClick={()=>setActiveLanguage(code)}>{label}{code!=='en'&&(!draft.translations[code].prompt.trim()||draft.translations[code].options.some(option=>!option.trim()))&&<small> · Missing</small>}</button>)}</div>{activeLanguage==='en'?<fieldset className="translation-section"><legend>{t('englishQuestion')}</legend><label>{t('englishQuestion')}<input autoFocus minLength={5} maxLength={500} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} required /></label>{draft.options.map((option, index) => <label className="option-edit" key={index}><span>OPTION {String.fromCharCode(65 + index)} {draft.correct_index === index && <i>· CORRECT ANSWER</i>}</span><input maxLength={250} value={option} onChange={event => updateOption(index, event.target.value)} required /><input type="radio" name="correct-answer" checked={draft.correct_index === index} onChange={() => setDraft({ ...draft, correct_index: index })} /></label>)}</fieldset>:<fieldset className="translation-section"><legend>{activeLanguage==='kck'?'Kuki':'Tamil'}</legend><small>{t('translationFallback')}</small>{incomplete&&<div className="translation-warning" role="status">Translation is incomplete. Missing fields will use the English version during the exam.</div>}<label>{activeLanguage==='kck'?t('kukiQuestion'):t('tamilQuestion')}<input maxLength={500} value={draft.translations[activeLanguage].prompt} onChange={event => updateTranslationPrompt(activeLanguage, event.target.value)} /></label>{draft.options.map((_, index) => <label key={index}>OPTION {String.fromCharCode(65 + index)} · {activeLanguage==='kck'?'Kuki':'Tamil'}<input maxLength={250} value={draft.translations[activeLanguage].options[index] || ''} onChange={event => updateTranslationOption(activeLanguage, index, event.target.value)} /></label>)}</fieldset>}{draft.options.length < 8 && <button type="button" className="text-link" onClick={() => setOptionCount(draft.options.length + 1)}>Add option</button>}{draft.options.length > 2 && <button type="button" className="text-link" onClick={() => setOptionCount(draft.options.length - 1)}>Remove last option</button>}<div className="two-inputs"><label>Category<select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}>{categories.map((category: any) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label><label>Difficulty<select value={draft.difficulty} onChange={event => setDraft({ ...draft, difficulty: event.target.value })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label></div><label>Question points<input type="number" min="0" max="100" step="1" value={draft.points} onChange={event => setDraft({ ...draft, points: Number(event.target.value) })} /><small>0 uses the global correct-answer points setting.</small></label><button className="btn btn-dark auth-submit">Save question <Check size={16} /></button></form></div>;
}

function ParticipantDetail({ detail, onClose }: { detail: any; onClose: () => void }) {
  const { participant, payment, accessCode, submission, emails } = detail;
   return <div className="modal-backdrop detail-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="participant-detail"><button className="modal-close" onClick={onClose}><X /></button><div className="section-kicker">PARTICIPANT RECORD</div><h2>{participant.name}</h2><p>{participant.email} · {participant.phone || 'No phone'}</p><div className="detail-grid"><div><small>CHURCH</small><strong>{participant.church || '—'}</strong></div><div><small>DISTRICT / STATE</small><strong>{participant.district || '—'} / {participant.state || '—'}</strong></div><div><small>LANGUAGE</small><strong>{({en:'English',english:'English',kck:'Kuki',kuki:'Kuki',ta:'Tamil',tamil:'Tamil'} as Record<string,string>)[participant.competition_language||participant.preferred_language]||'English'}</strong></div><div><small>PAYMENT</small><strong>{payment ? `${payment.status.toUpperCase()} · ${payment.currency || ''} ${numberFmt(payment.amount)}` : 'UNPAID'}</strong><small>{payment?.id || ''}{payment?.paid_at ? ' · ' + new Date(payment.paid_at).toLocaleString('en-IN') : ''}</small></div><div><small>ACCESS CODE</small><strong>{accessCode?.status === 'paid' ? accessCode.code : 'No active code'}</strong><small>{accessCode?.language ? `${accessCode.language} · ${accessCode.used_status ? 'used' : 'unused'}` : ''}</small></div></div><div className="detail-section"><h3>Quiz score</h3>{submission ? <><p>{numberFmt(submission.score)} points · {submission.submittedAt ? 'Submitted ' + new Date(submission.submittedAt).toLocaleString('en-IN') : 'Not submitted'} · {submission.warningCount} warnings</p><div className="answer-review">{submission.answers.map((answer: any, index: number) => <article key={answer.questionId}><div className="question-meta"><span>{index + 1}. {answer.category} · {answer.difficulty}</span><strong className={'answer-result ' + answer.result}>{answer.result.toUpperCase()} · {answer.points > 0 ? '+' : ''}{numberFmt(answer.points)}</strong></div><h4>{answer.prompt}</h4><small>Participant: {answer.selectedAnswer === null ? 'Unanswered' : answer.options[answer.selectedAnswer]} · Correct: {answer.options[answer.correctAnswer]}</small></article>)}</div></> : <p>No quiz attempt has been started.</p>}</div><div className="detail-section"><h3>Email delivery history</h3>{emails.length ? emails.map((email: any) => <div className="delivery-row" key={email.type + email.created_at}><span>{email.type} → {email.to_email}</span><strong className={'delivery-' + email.status}>{email.status}</strong></div>) : <p>No emails recorded yet.</p>}</div></section></div>;
}

function AnalyticsDashboard({ analytics }: { analytics: any }) {
  const metrics = [[t('totalParticipants'), analytics.totalParticipants], [t('totalSubmissions'), analytics.totalSubmissions], [t('averageScore'), numberFmt(analytics.averageScore)], [t('highestScore'), numberFmt(analytics.highestScore)], [t('lowestScore'), numberFmt(analytics.lowestScore)], [t('averageCompletion'), `${Math.floor(analytics.averageCompletionSeconds / 60)}m ${Math.round(analytics.averageCompletionSeconds % 60)}s`], [t('paidParticipants'), analytics.paidParticipants], [t('unpaidParticipants'), analytics.unpaidParticipants]];
  return <div className="analytics-view"><div className="analytics-grid">{metrics.map(([label, value]) => <div className="analytics-card" key={String(label)}><small>{label}</small><strong>{value}</strong></div>)}</div><div className="analytics-columns"><div className="admin-panel"><h2>{t('difficultyAnalysis')}</h2><BarRows rows={analytics.difficultyAnalysis.map((row: any) => ({ label: row.difficulty, value: row.accuracyPercent, suffix: '% accuracy' }))} /></div><div className="admin-panel"><h2>{t('categoryPerformance')}</h2><BarRows rows={analytics.categoryPerformance.map((row: any) => ({ label: row.category, value: row.accuracyPercent, suffix: `% · ${row.questions} questions` }))} /></div></div><div className="analytics-columns">{[[t('mostCorrectlyAnswered'), analytics.mostCorrectlyAnswered], [t('mostIncorrectlyAnswered'), analytics.mostIncorrectlyAnswered], [t('mostSkipped'), analytics.mostSkipped]].map(([title, rows]: any) => <div className="admin-panel" key={title}><h2>{title}</h2>{rows.length ? rows.map((row: any) => <div className="question-stat-row" key={row.id}><span>{row.prompt}<small>{row.category}</small></span><strong>{row.count}</strong></div>) : <p className="analytics-empty">{t('noSubmissions')}</p>}</div>)}</div></div>;
}

function BarRows({ rows }: { rows: { label: string; value: number; suffix: string }[] }) {
  return <div className="analytics-bars">{rows.length ? rows.map(row => <div className="analytics-bar-row" key={row.label}><div><span>{row.label}</span><strong>{numberFmt(row.value)}{row.suffix.startsWith('%') ? '%' : ''}</strong></div><div className="analytics-bar"><i style={{ width: `${Math.max(0, Math.min(100, row.value))}%` }} /></div><small>{row.suffix}</small></div>) : <p className="analytics-empty">No question data yet.</p>}</div>;
}
