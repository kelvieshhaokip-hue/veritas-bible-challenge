import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderEmailTemplate, type EmailTemplateKind } from './email.js';
import { parseQuestionImport } from './question-import.js';

const app = express();
const port = Number(process.env.PORT || 3001);
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) console.warn('Set JWT_SECRET to a random value of at least 32 characters before deployment.');
const jwtSecret = secret || 'local-demo-only-secret-change-before-deployment';
const dbPath = resolve(process.env.DATABASE_PATH || './server/data/competition.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'participant', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, phone TEXT, church TEXT, district TEXT, state TEXT, active INTEGER NOT NULL DEFAULT 1, preferred_language TEXT NOT NULL DEFAULT 'en', competition_language TEXT NOT NULL DEFAULT 'english');
  CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, options TEXT NOT NULL, correct_index INTEGER NOT NULL, points INTEGER NOT NULL DEFAULT 1, category TEXT NOT NULL DEFAULT 'General', difficulty TEXT NOT NULL DEFAULT 'medium', custom_points INTEGER NOT NULL DEFAULT 0, english_question TEXT NOT NULL DEFAULT '', kuki_question TEXT NOT NULL DEFAULT '', tamil_question TEXT NOT NULL DEFAULT '', english_options TEXT NOT NULL DEFAULT '[]', kuki_options TEXT NOT NULL DEFAULT '[]', tamil_options TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS language_selections (id TEXT PRIMARY KEY, preferred_language TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, provider_ref TEXT, provider_txn TEXT, status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','refunded')), amount INTEGER NOT NULL, currency TEXT, competition_id TEXT, language TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT, refunded_at TEXT);
  CREATE TABLE IF NOT EXISTS access_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id), competition_id TEXT, language TEXT, payment_status TEXT NOT NULL DEFAULT 'pending', used INTEGER NOT NULL DEFAULT 0, used_status INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), answers TEXT NOT NULL DEFAULT '{}', answers_updated_at TEXT, score REAL NOT NULL DEFAULT 0, score_breakdown TEXT, submitted_at TEXT, quiz_order TEXT, current_question_index INTEGER NOT NULL DEFAULT 0, question_started_at TEXT, started_at TEXT, question_language TEXT, warning_count INTEGER NOT NULL DEFAULT 0, warning_events TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS email_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), payment_id TEXT REFERENCES payments(id), type TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')), provider_ref TEXT, error TEXT, dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS security_events (id TEXT PRIMARY KEY, user_id TEXT, event TEXT NOT NULL, ip TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
// Add profile columns to databases created before participant profiles were introduced.
const userColumns = new Set((db.prepare('PRAGMA table_info(users)').all() as {name:string}[]).map(column=>column.name));
for (const column of ['phone','church','district','state']) if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
if (!userColumns.has('active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
if (!userColumns.has('preferred_language')) db.exec("ALTER TABLE users ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'en'");
if (!userColumns.has('competition_language')) db.exec("ALTER TABLE users ADD COLUMN competition_language TEXT NOT NULL DEFAULT 'english'");
const questionColumns = new Set((db.prepare('PRAGMA table_info(questions)').all() as {name:string}[]).map(column=>column.name));
for (const [column,definition] of Object.entries({category:"TEXT NOT NULL DEFAULT 'General'",difficulty:"TEXT NOT NULL DEFAULT 'medium'",custom_points:'INTEGER NOT NULL DEFAULT 0',english_question:"TEXT NOT NULL DEFAULT ''",kuki_question:"TEXT NOT NULL DEFAULT ''",tamil_question:"TEXT NOT NULL DEFAULT ''",english_options:"TEXT NOT NULL DEFAULT '[]'",kuki_options:"TEXT NOT NULL DEFAULT '[]'",tamil_options:"TEXT NOT NULL DEFAULT '[]'"})) if (!questionColumns.has(column)) db.exec(`ALTER TABLE questions ADD COLUMN ${column} ${definition}`);
const legacyQuestionTranslations = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='question_translations'").get();
if (legacyQuestionTranslations) {
  const legacyRows = db.prepare('SELECT question_id,language,prompt,options FROM question_translations').all() as {question_id:string;language:string;prompt:string;options:string}[];
  for (const row of legacyRows) {
    const fields:Record<string,[string,string]>={kck:['kuki_question','kuki_options'],ta:['tamil_question','tamil_options']};
    const target=fields[row.language];
    if(target)db.prepare(`UPDATE questions SET ${target[0]}=CASE WHEN ${target[0]}='' THEN ? ELSE ${target[0]} END,${target[1]}=CASE WHEN ${target[1]}='[]' THEN ? ELSE ${target[1]} END WHERE id=?`).run(row.prompt,row.options,row.question_id);
  }
  db.exec('DROP TABLE question_translations');
}
db.prepare("UPDATE questions SET english_question=prompt WHERE english_question=''").run();
db.prepare("UPDATE questions SET english_options=options WHERE english_options='[]' OR english_options=''").run();
// Persist participant quiz state while upgrading existing competition databases.
const submissionColumns = new Set((db.prepare('PRAGMA table_info(submissions)').all() as {name:string}[]).map(column=>column.name));
const submissionMigrations: Record<string,string> = { answers_updated_at:'TEXT', score_breakdown:'TEXT', quiz_order:'TEXT', current_question_index:'INTEGER NOT NULL DEFAULT 0', question_started_at:'TEXT', started_at:'TEXT', question_language:'TEXT', warning_count:'INTEGER NOT NULL DEFAULT 0', warning_events:"TEXT NOT NULL DEFAULT '[]'" };
for (const [column,definition] of Object.entries(submissionMigrations)) if (!submissionColumns.has(column)) db.exec(`ALTER TABLE submissions ADD COLUMN ${column} ${definition}`);
db.exec("UPDATE submissions SET question_language=COALESCE((SELECT preferred_language FROM users WHERE users.id=submissions.user_id),'en') WHERE started_at IS NOT NULL AND question_language IS NULL");
const paymentColumns = new Set((db.prepare('PRAGMA table_info(payments)').all() as {name:string}[]).map(column=>column.name));
const paymentMigrations: Record<string,string> = { provider_txn:'TEXT', currency:'TEXT', competition_id:'TEXT', language:'TEXT', updated_at:'TEXT', paid_at:'TEXT', refunded_at:'TEXT' };
for (const [column,definition] of Object.entries(paymentMigrations)) if (!paymentColumns.has(column)) db.exec(`ALTER TABLE payments ADD COLUMN ${column} ${definition}`);
const accessCodeColumns = new Set((db.prepare('PRAGMA table_info(access_codes)').all() as {name:string}[]).map(column=>column.name));
const accessCodeMigrations: Record<string,string> = { competition_id:'TEXT', language:'TEXT', payment_status:"TEXT NOT NULL DEFAULT 'pending'", used_status:'INTEGER NOT NULL DEFAULT 0' };
for (const [column,definition] of Object.entries(accessCodeMigrations)) if (!accessCodeColumns.has(column)) db.exec(`ALTER TABLE access_codes ADD COLUMN ${column} ${definition}`);
db.exec('UPDATE payments SET updated_at=COALESCE(updated_at,created_at)');
db.exec("UPDATE payments SET paid_at=COALESCE(paid_at,created_at) WHERE status='paid'");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS access_codes_payment_id_unique ON access_codes(payment_id)');
const defaults: Record<string, string> = { competition_id:randomUUID(), competition_title: 'The Word & Wisdom Bible Challenge', competition_date: '2026-10-18T10:00:00+05:30', competition_end: '2026-10-18T11:00:00+05:30', entry_fee: process.env.ENTRY_FEE || '250', currency: process.env.CURRENCY || 'INR', access_code: 'WORD2026', registration_open: 'true', correct_answer_points: '1', wrong_answer_penalty: '0.25', unanswered_penalty: '0' };
const setDefault = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
for (const [k,v] of Object.entries(defaults)) setDefault.run(k,v);
db.exec("UPDATE users SET competition_language=CASE preferred_language WHEN 'kck' THEN 'kuki' WHEN 'ta' THEN 'tamil' ELSE 'english' END");
db.exec("UPDATE payments SET competition_id=COALESCE(competition_id,(SELECT value FROM settings WHERE key='competition_id')),language=COALESCE(language,(SELECT CASE u.preferred_language WHEN 'kck' THEN 'kuki' WHEN 'ta' THEN 'tamil' ELSE 'english' END FROM users u WHERE u.id=payments.user_id))");
db.exec("UPDATE access_codes SET competition_id=COALESCE(competition_id,(SELECT p.competition_id FROM payments p WHERE p.id=access_codes.payment_id)),language=COALESCE(language,(SELECT p.language FROM payments p WHERE p.id=access_codes.payment_id)),payment_status=COALESCE((SELECT p.status FROM payments p WHERE p.id=access_codes.payment_id),payment_status),used_status=used");
db.prepare("INSERT OR IGNORE INTO categories(id,name) VALUES(?,?)").run(randomUUID(),'General');
for (const row of db.prepare('SELECT DISTINCT category FROM questions WHERE category IS NOT NULL AND category<>\'\'').all() as {category:string}[]) {
  const known=db.prepare('SELECT name FROM categories WHERE lower(name)=lower(?)').get(row.category) as {name:string}|undefined;
  if(known){if(known.name!==row.category)db.prepare('UPDATE questions SET category=? WHERE lower(category)=lower(?)').run(known.name,row.category);}
  else db.prepare('INSERT INTO categories(id,name) VALUES(?,?)').run(randomUUID(),row.category);
}
function logSecurityEvent(event:string,req:Request,userId:string|null=null,details:string|null=null){try{db.prepare('INSERT INTO security_events(id,user_id,event,ip,details) VALUES(?,?,?,?,?)').run(randomUUID(),userId,event,req.ip||null,details?.slice(0,300)||null)}catch{}}
function rateLimit(limit:number,windowMs:number){
  const hits=new Map<string,{count:number;resetAt:number}>();
  return (req:Request,res:Response,next:NextFunction)=>{
    const now=Date.now(),key=req.ip||'unknown',bucket=hits.get(key);
    if(!bucket||now>=bucket.resetAt){hits.set(key,{count:1,resetAt:now+windowMs});return next()}
    if(bucket.count>=limit){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((bucket.resetAt-now)/1000))));logSecurityEvent('rate_limit',req,null,req.path);return res.status(429).json({error:'Too many requests. Please wait and try again.'})}
    bucket.count++;if(hits.size>10000)for(const [ip,entry] of hits)if(now>=entry.resetAt)hits.delete(ip);
    next();
  };
}
db.prepare("UPDATE payments SET currency=? WHERE currency IS NULL OR currency=''").run((db.prepare("SELECT value FROM settings WHERE key='currency'").get() as {value:string}).value);
const seedQuestions = [
  ['q1','Who built an ark at God’s command?',['Abraham','Noah','Moses','David'],1],
  ['q2','In which town was Jesus born?',['Nazareth','Jerusalem','Bethlehem','Capernaum'],2],
  ['q3','Who led the Israelites out of Egypt?',['Joshua','Aaron','Moses','Joseph'],2],
  ['q4','What is the first book of the New Testament?',['Acts','Matthew','Romans','Mark'],1],
  ['q5','How many days and nights did it rain during the flood?',['7','12','40','70'],2],
  ['q6','Who was swallowed by a great fish?',['Jonah','Peter','Elijah','Paul'],0],
  ['q7','What did David use to defeat Goliath?',['A sword','A sling and a stone','A spear','A bow'],1],
  ['q8','Which disciple denied Jesus three times?',['John','Thomas','Peter','Andrew'],2]
];
const seedQuestion = db.prepare('INSERT OR IGNORE INTO questions(id,prompt,options,correct_index,points) VALUES(?,?,?,?,1)');
for (const [id,prompt,options,correct] of seedQuestions) seedQuestion.run(id,prompt,JSON.stringify(options),correct);
db.prepare("UPDATE questions SET english_question=prompt WHERE english_question='' OR english_question IS NULL").run();
db.prepare("UPDATE questions SET english_options=options WHERE english_options='[]' OR english_options='' OR english_options IS NULL").run();
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
if (adminEmail && adminPassword && !db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(adminEmail.toLowerCase())) {
  db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)').run(randomUUID(),'Competition Admin',adminEmail.toLowerCase(),bcrypt.hashSync(adminPassword,12),'admin');
}

app.use((_req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');next()});
app.use(cors({ origin: (process.env.APP_URL || 'http://localhost:5173').split(',').map(s=>s.trim()), credentials: false }));
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req,res) => {
  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecret || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe webhook not configured');
  const stripe = new Stripe(stripeSecret);
  let event: Stripe.Event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', process.env.STRIPE_WEBHOOK_SECRET); }
  catch { logSecurityEvent('stripe_webhook_signature_rejected',req);return res.status(400).send('Invalid webhook signature'); }
  if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.userId;
    const paymentId = session.metadata?.paymentId;
    if (userId && paymentId && session.payment_status === 'paid') {
      const paymentIntent=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
      const issued=issueCode(userId,paymentId,'stripe',session.id,paymentIntent,session.amount_total,session.currency);
      if(issued&&(issued.newlyPaid||issued.newCodeCreated)) await sendTransactionalEmail(userId,'payment',paymentId,'payment:'+paymentId);
    }
  } else if (event.type === 'checkout.session.async_payment_failed' || event.type === 'checkout.session.expired') {
    const session=event.data.object as Stripe.Checkout.Session;
    if(session.metadata?.userId&&session.metadata.paymentId) markPaymentFailed(session.metadata.paymentId,session.metadata.userId);
  } else if (event.type === 'payment_intent.payment_failed') {
    const intent=event.data.object as Stripe.PaymentIntent;
    if(intent.metadata?.userId&&intent.metadata.paymentId)markPaymentFailed(intent.metadata.paymentId,intent.metadata.userId);
  } else if (event.type === 'charge.refunded') {
    const charge=event.data.object as Stripe.Charge;
    const paymentIntent=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
    if(charge.refunded&&paymentIntent) markPaymentRefunded(paymentIntent);
  }
  res.json({ received: true });
});
app.use(express.json({ limit: '8mb' }));
type User = { id: string; name: string; email: string; role: string; preferred_language?: string; competition_language?: string };
type AuthedRequest = Request & { user?: User };
type LocaleCode = 'en' | 'kck' | 'ta';
type LocalizedQuestion = { prompt: string; options: string[] };
const supportedLanguages: LocaleCode[] = ['en', 'kck', 'ta'];
function normalizeLanguage(input: unknown): LocaleCode | null {
  if(typeof input!=='string')return null;
  const value=input.trim().toLowerCase();
  const aliases:Record<string,LocaleCode>={english:'en',kuki:'kck',tamil:'ta'};
  const language=aliases[value]||value;
  return supportedLanguages.includes(language as LocaleCode)?language as LocaleCode:null;
}
function languageSlug(input:unknown):'english'|'kuki'|'tamil'{const language=normalizeLanguage(input)||'en';return language==='kck'?'kuki':language==='ta'?'tamil':'english'}
function parsedOptions(raw: unknown): string[] {
  try { const options = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(options) ? options.map(value => String(value ?? '')) : []; }
  catch { return []; }
}
function questionVersions(question: any): Record<LocaleCode, LocalizedQuestion> {
  const englishPrompt=String(question.english_question||question.prompt||''),englishOptions=parsedOptions(question.english_options||question.options);
  return {
    en:{prompt:englishPrompt,options:englishOptions},
    kck:{prompt:String(question.kuki_question||''),options:parsedOptions(question.kuki_options)},
    ta:{prompt:String(question.tamil_question||''),options:parsedOptions(question.tamil_options)},
  };
}
function localizeQuestionRows(questions: any[], language: LocaleCode) {
  return questions.map(question => {
    const versions=questionVersions(question),english=versions.en,selected=versions[language];
    return {id:question.id,prompt:language==='en'?english.prompt:selected.prompt.trim()||english.prompt,options:english.options.map((option,index)=>language!=='en'?selected.options[index]?.trim()||option:option),points:question.points,custom_points:question.custom_points,category:question.category,difficulty:question.difficulty};
  });
}
function questionRowsWithTranslations(questions: any[]) {
  return questions.map(question => ({...question,options:parsedOptions(question.english_options||question.options),translations:questionVersions(question)}));
}
function normalizeTranslationDraft(input: any, optionCount: number): Record<'kck' | 'ta', LocalizedQuestion> | null {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return null;
  const result = {} as Record<'kck' | 'ta', LocalizedQuestion>;
  for (const language of ['kck', 'ta'] as const) {
    const source = input?.[language] ?? {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    if (source.prompt !== undefined && typeof source.prompt !== 'string') return null;
    if (source.options !== undefined && (!Array.isArray(source.options) || source.options.length > optionCount || source.options.some((option: unknown) => typeof option !== 'string'))) return null;
    const prompt = String(source.prompt ?? '').trim();
    const options = Array.from({ length: optionCount }, (_, index) => String(source.options?.[index] ?? '').trim());
    if (prompt.length > 500 || options.some(option => option.length > 250)) return null;
    result[language] = { prompt, options };
  }
  return result;
}
function auth(req: AuthedRequest,res: Response,next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({ error:'Sign in required' });
  try { const payload=jwt.verify(token,jwtSecret) as User;const current=db.prepare('SELECT role,active FROM users WHERE id=?').get(payload.id) as {role:string;active:number}|undefined;if(!current||!current.active){logSecurityEvent('disabled_or_missing_account_access',req,payload.id);return res.status(403).json({error:'This account is disabled or no longer active.'})}req.user={...payload,role:current.role};next(); } catch { return res.status(401).json({ error:'Session expired; sign in again' }); }
}
function admin(req: AuthedRequest,res: Response,next: NextFunction) { if (req.user?.role !== 'admin'){logSecurityEvent('admin_access_denied',req,req.user?.id||null,req.path);return res.status(403).json({error:'Admin permission required'})}next(); }
function issueCode(userId:string,paymentId:string,provider:string,providerRef=paymentId,providerTxn?:string,providerAmount?:number|null,providerCurrency?:string|null) {
  const tx = db.transaction(() => {
    const payment=db.prepare('SELECT id,status,provider,provider_ref,amount,currency,competition_id,language FROM payments WHERE id=? AND user_id=?').get(paymentId,userId) as {id:string;status:string;provider:string;provider_ref:string|null;amount:number;currency:string|null;competition_id:string|null;language:string|null}|undefined;
    if(!payment||payment.provider!==provider||payment.status==='refunded')return null;
    if(payment.competition_id!==value('competition_id'))return null;
    if(provider==='stripe'&&(payment.provider_ref!==providerRef||providerAmount!==payment.amount*100||providerCurrency?.toLowerCase()!==payment.currency?.toLowerCase()))return null;
    const newlyPaid=payment.status!=='paid';
    const paidAt=new Date().toISOString();
    db.prepare("UPDATE payments SET status='paid',provider_ref=?,provider_txn=COALESCE(?,provider_txn),paid_at=COALESCE(paid_at,?),updated_at=? WHERE id=? AND user_id=? AND status<>'refunded'").run(providerRef,providerTxn||null,paidAt,paidAt,paymentId,userId);
    const language=payment.language||languageSlug((db.prepare('SELECT preferred_language FROM users WHERE id=?').get(userId) as {preferred_language:string}|undefined)?.preferred_language);
    let existing=db.prepare('SELECT ac.code,ac.payment_id,p.status FROM access_codes ac JOIN payments p ON p.id=ac.payment_id WHERE ac.user_id=?').get(userId) as {code:string;payment_id:string;status:string}|undefined;
    let newCodeCreated=false;
    if(existing&&(existing.status!=='paid'||existing.payment_id!==paymentId)){
      let nextCode='';do{nextCode='VER-'+randomBytes(16).toString('hex').toUpperCase()}while(db.prepare('SELECT 1 FROM access_codes WHERE code=?').get(nextCode));
      db.prepare("UPDATE access_codes SET code=?,payment_id=?,competition_id=?,language=?,payment_status='paid',used=0,used_status=0 WHERE user_id=?").run(nextCode,paymentId,payment.competition_id,language,userId);existing={code:nextCode,payment_id:paymentId,status:'paid'};newCodeCreated=true;
    } else if(!existing) {
      let code='';do{code='VER-'+randomBytes(16).toString('hex').toUpperCase()}while(db.prepare('SELECT 1 FROM access_codes WHERE code=?').get(code));
      db.prepare("INSERT INTO access_codes(code,user_id,payment_id,competition_id,language,payment_status,used,used_status) VALUES(?,?,?,?,?,'paid',0,0)").run(code,userId,paymentId,payment.competition_id,language);existing={code,payment_id:paymentId,status:'paid'};newCodeCreated=true;
    } else if(existing.payment_id===paymentId) {
      db.prepare("UPDATE access_codes SET competition_id=?,language=?,payment_status='paid' WHERE user_id=?").run(payment.competition_id,language,userId);
    }
    db.prepare("UPDATE users SET preferred_language=CASE ? WHEN 'kuki' THEN 'kck' WHEN 'tamil' THEN 'ta' ELSE 'en' END,competition_language=? WHERE id=?").run(language,language,userId);
    db.prepare('INSERT OR IGNORE INTO submissions(id,user_id) VALUES(?,?)').run(randomUUID(),userId);
    return {code:existing.code,newlyPaid,newCodeCreated,paymentId};
  });
  return tx();
}
function markPaymentFailed(paymentId:string,userId:string){const now=new Date().toISOString();db.transaction(()=>{db.prepare("UPDATE payments SET status='failed',updated_at=? WHERE id=? AND user_id=? AND provider='stripe' AND status='pending'").run(now,paymentId,userId);db.prepare("UPDATE access_codes SET payment_status='failed' WHERE payment_id=? AND user_id=?").run(paymentId,userId)})()}
function markPaymentRefunded(providerTxn:string){const now=new Date().toISOString();db.transaction(()=>{db.prepare("UPDATE payments SET status='refunded',refunded_at=COALESCE(refunded_at,?),updated_at=? WHERE provider='stripe' AND provider_txn=? AND status='paid'").run(now,now,providerTxn);db.prepare("UPDATE access_codes SET payment_status='refunded' WHERE payment_id IN (SELECT id FROM payments WHERE provider='stripe' AND provider_txn=? AND status='refunded')").run(providerTxn)})()}
async function sendTransactionalEmail(userId:string,kind:EmailTemplateKind,paymentId:string|null,dedupeKey:string){
  const participant=db.prepare('SELECT name,email FROM users WHERE id=?').get(userId) as {name:string;email:string}|undefined;
  if(!participant)return {status:'failed'};
  const previous=db.prepare('SELECT id,status FROM email_deliveries WHERE dedupe_key=?').get(dedupeKey) as {id:string;status:string}|undefined;
  if(previous)return previous;
  const payment=paymentId?db.prepare("SELECT p.status,ac.code FROM payments p LEFT JOIN access_codes ac ON ac.payment_id=p.id WHERE p.id=? AND p.user_id=?").get(paymentId,userId) as {status:string;code:string|null}|undefined:undefined;
  if((kind==='payment'||kind==='access_code')&&(!payment||payment.status!=='paid'||!payment.code))return {status:'failed'};
  const config=renderEmailTemplate(kind,{
    participantName:participant.name,competitionName:value('competition_title'),accessCode:payment?.code||undefined,
    score:(db.prepare('SELECT score FROM submissions WHERE user_id=?').get(userId) as {score:number}|undefined)?.score,
    competitionDate:value('competition_date'),competitionEnd:value('competition_end'),appUrl:process.env.APP_URL||'http://localhost:5173'
  });
  const deliveryId=randomUUID();
  db.prepare('INSERT INTO email_deliveries(id,user_id,payment_id,type,to_email,subject,status,dedupe_key) VALUES(?,?,?,?,?,?,?,?)').run(deliveryId,userId,paymentId,kind,participant.email,config.subject,'pending',dedupeKey);
  const apiKey=process.env.RESEND_API_KEY,from=process.env.EMAIL_FROM;
  if(!apiKey||!from){db.prepare("UPDATE email_deliveries SET status='failed',error=?,updated_at=? WHERE id=?").run('Email is not configured (set RESEND_API_KEY and EMAIL_FROM).',new Date().toISOString(),deliveryId);return {id:deliveryId,status:'failed'};}
  try{
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json','Idempotency-Key':dedupeKey},body:JSON.stringify({from,to:[participant.email],subject:config.subject,html:config.html,text:config.text}),signal:AbortSignal.timeout(10000)});
    const result=await response.json().catch(()=>({})) as {id?:string;message?:string};
    if(!response.ok)throw new Error(result.message||'Email provider rejected the message.');
    db.prepare("UPDATE email_deliveries SET status='sent',provider_ref=?,error=NULL,updated_at=? WHERE id=?").run(result.id||null,new Date().toISOString(),deliveryId);
    return {id:deliveryId,status:'sent'};
  }catch(error){
    db.prepare("UPDATE email_deliveries SET status='failed',error=?,updated_at=? WHERE id=?").run(String(error).slice(0,500),new Date().toISOString(),deliveryId);
    return {id:deliveryId,status:'failed'};
  }
}
async function sendSubmissionEmail(userId:string){
  const attempt=db.prepare('SELECT started_at FROM submissions WHERE user_id=?').get(userId) as {started_at:string|null}|undefined;
  if(!attempt?.started_at)return {status:'failed'};
  return sendTransactionalEmail(userId,'submission',null,'submission:'+userId+':'+attempt.started_at);
}
function value(key:string) { return (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value ?? ''; }
function validateProfileDetails(input:any){
  if(!input||typeof input!=='object')return null;
  const cleanText=(value:unknown)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim():'';
  const name=cleanText(input.name);
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  const phone=cleanText(input.phone);
  const church=cleanText(input.church);
  const district=cleanText(input.district);
  const state=cleanText(input.state);
  const preferred_language=normalizeLanguage(input.preferred_language??input.competition_language??'en');
  if(name.length<2||name.length>80||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\d{10,15}$/.test(phone)||!church||church.length>100||!district||district.length>100||!state||state.length>100||!preferred_language)return null;
  return {name,email,phone,church,district,state,preferred_language,competition_language:languageSlug(preferred_language)};
}
function participantSnapshot(userId:string){
  const participant=db.prepare('SELECT id,name,email,role,phone,church,district,state,created_at,preferred_language,competition_language FROM users WHERE id=?').get(userId);
  const payment=db.prepare('SELECT id,status,amount,currency,provider,competition_id,language,created_at,paid_at,refunded_at FROM payments WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(userId) as any;
  const code=db.prepare("SELECT ac.code,ac.competition_id,ac.language,ac.payment_status,ac.used_status FROM access_codes ac JOIN payments p ON p.id=ac.payment_id WHERE ac.user_id=? AND ac.competition_id=? AND ac.payment_status='paid' AND p.status='paid'").get(userId,value('competition_id')) as any;
  const emails=db.prepare('SELECT type,status,created_at,updated_at FROM email_deliveries WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 12').all(userId);
  return {user:participant,code:code||null,payment:payment||null,emails};
}
app.get('/api/config',(_req,res)=>res.json({ title:value('competition_title'), date:value('competition_date'), end:value('competition_end'), fee:Number(value('entry_fee')), currency:value('currency'), registrationOpen:value('registration_open')==='true', demo:process.env.DEMO_MODE==='true', stripeReady:Boolean(process.env.STRIPE_SECRET_KEY), questionCount:(db.prepare('SELECT count(*) as n FROM questions').get() as {n:number}).n }));
db.prepare("DELETE FROM language_selections WHERE created_at < datetime('now','-1 day')").run();
app.post('/api/language-selection',rateLimit(20,60*1000),(req,res)=>{
  const preferredLanguage=normalizeLanguage(req.body?.preferred_language??req.body?.competition_language);
  if(!preferredLanguage)return res.status(400).json({error:'Choose English, Kuki, or Tamil.'});
  const selectionId=randomUUID();
  db.prepare('INSERT INTO language_selections(id,preferred_language) VALUES(?,?)').run(selectionId,preferredLanguage);
  res.status(201).json({selectionId,preferred_language:preferredLanguage});
});
app.post('/api/auth/register',rateLimit(8,15*60*1000), async (req,res) => {
  const {name,email,password,phone,church,district,state,preferred_language,competition_language,language_selection_id} = req.body ?? {};
  if (value('registration_open') !== 'true') return res.status(403).json({error:'Registration is currently closed.'});
  const selection=typeof language_selection_id==='string'?(db.prepare("SELECT preferred_language FROM language_selections WHERE id=? AND created_at>=datetime('now','-1 day')").get(language_selection_id) as {preferred_language:string}|undefined):undefined;
  if(language_selection_id&&!selection)return res.status(400).json({error:'Your language selection expired. Please choose a language again.'});
  const profile=validateProfileDetails({name,email,phone,church,district,state,preferred_language:selection?.preferred_language??preferred_language??competition_language??'en'});
  if(!profile||typeof password!=='string'||password.length<10||password.length>128){logSecurityEvent('registration_validation_failed',req,null);return res.status(400).json({error:'Enter a valid name, email, 10–15 digit phone number, church, district, state, and password (at least 10 characters).'})}
  if(db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(profile.email))return res.status(409).json({error:'An account with that email already exists.'});
  try {
    const id=randomUUID(); db.prepare('INSERT INTO users(id,name,email,password_hash,phone,church,district,state,preferred_language,competition_language) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,profile.name,profile.email,await bcrypt.hash(password,12),profile.phone,profile.church,profile.district,profile.state,profile.preferred_language,profile.competition_language);
    if(typeof language_selection_id==='string')db.prepare('DELETE FROM language_selections WHERE id=?').run(language_selection_id);
    const emailResult=await sendTransactionalEmail(id,'registration',null,'registration:'+id);
    res.status(201).json({token:jwt.sign({id,name:profile.name,email:profile.email,role:'participant'},jwtSecret,{expiresIn:'12h'}),user:{id,...profile,role:'participant'},emailStatus:emailResult.status});
  } catch { res.status(409).json({error:'An account with that email already exists.'}); }
});
app.post('/api/auth/login',rateLimit(12,15*60*1000), async (req,res) => {
  const {email,password}=req.body??{};
  const user=db.prepare('SELECT id,name,email,password_hash,role,active,preferred_language,competition_language FROM users WHERE lower(email)=?').get(String(email||'').trim().toLowerCase()) as (User&{password_hash:string;active:number})|undefined;
  if(!user||!user.active||typeof password!=='string'||!await bcrypt.compare(password,user.password_hash)){logSecurityEvent('login_failed',req,user?.id||null);return res.status(401).json({error:'Email or password is incorrect.'})}
  const {password_hash:_,active:__,...safe}=user;
  res.json({token:jwt.sign(safe,jwtSecret,{expiresIn:'12h'}),user:safe});
});
app.get('/api/me',auth,(req:AuthedRequest,res)=>res.json(participantSnapshot(req.user!.id)));
app.put('/api/profile',auth,(req:AuthedRequest,res)=>{
  const current=db.prepare('SELECT preferred_language FROM users WHERE id=?').get(req.user!.id) as {preferred_language:string}|undefined;
  const requestedLanguage=req.body?.preferred_language??req.body?.competition_language??current?.preferred_language??'en';
  const profile=validateProfileDetails({...req.body,preferred_language:requestedLanguage});
  if(!profile)return res.status(400).json({error:'Enter a valid name, email, 10–15 digit phone number, church, district, and state.'});
  if(db.prepare('SELECT 1 FROM access_codes WHERE user_id=?').get(req.user!.id)&&profile.preferred_language!==normalizeLanguage(current?.preferred_language))return res.status(409).json({error:'Competition language is locked after payment and access code generation.'});
  if(db.prepare('SELECT 1 FROM users WHERE lower(email)=? AND id<>?').get(profile.email,req.user!.id))return res.status(409).json({error:'That email address is already used by another account.'});
  try{db.transaction(()=>{db.prepare('UPDATE users SET name=?,email=?,phone=?,church=?,district=?,state=?,preferred_language=?,competition_language=? WHERE id=?').run(profile.name,profile.email,profile.phone,profile.church,profile.district,profile.state,profile.preferred_language,profile.competition_language,req.user!.id);db.prepare("UPDATE payments SET language=?,competition_id=?,updated_at=? WHERE user_id=? AND status IN ('pending','failed')").run(profile.competition_language,value('competition_id'),new Date().toISOString(),req.user!.id)})()}catch{return res.status(409).json({error:'That email address is already used by another account.'})}
  res.json(participantSnapshot(req.user!.id));
});
app.put('/api/profile/language',auth,(req:AuthedRequest,res)=>{
  const preferredLanguage=normalizeLanguage(req.body?.preferred_language??req.body?.competition_language);
  if(!preferredLanguage)return res.status(400).json({error:'Choose English, Kuki, or Tamil.'});
  if(db.prepare('SELECT 1 FROM access_codes WHERE user_id=?').get(req.user!.id))return res.status(409).json({error:'Competition language is locked after payment and access code generation.'});
  db.transaction(()=>{db.prepare('UPDATE users SET preferred_language=?,competition_language=? WHERE id=?').run(preferredLanguage,languageSlug(preferredLanguage),req.user!.id);db.prepare("UPDATE payments SET language=?,competition_id=?,updated_at=? WHERE user_id=? AND status IN ('pending','failed')").run(languageSlug(preferredLanguage),value('competition_id'),new Date().toISOString(),req.user!.id)})();
  res.json(participantSnapshot(req.user!.id));
});
function parseAnswers(raw:string):Record<string,number|null> {
  try { const value=JSON.parse(raw); return value&&typeof value==='object'&&!Array.isArray(value)?value:{}; } catch { return {}; }
}
function roundScore(score:number){return Number.isFinite(score)?Math.max(-100000,Math.min(100000,Math.round((score+Number.EPSILON)*100)/100)):0}
function scoringRules(){
  const parse=(key:string,fallback:number)=>{const n=Number(value(key));return Number.isFinite(n)&&n>=0&&n<=100?n:fallback};
  return {correctAnswerPoints:parse('correct_answer_points',1),wrongAnswerPenalty:parse('wrong_answer_penalty',0.25),unansweredPenalty:parse('unanswered_penalty',0)};
}
function scoreAnswers(answers:Record<string,number|null>,questions:{id:string;prompt:string;correct_index:number;points:number;custom_points?:number;category?:string;difficulty?:string;options?:string|string[]}[]){
  const rules=scoringRules();let total=0,correct=0,wrong=0,unanswered=0;
  const breakdown=questions.map(question=>{
    const selected=answers[question.id],isAnswered=selected!==undefined&&selected!==null,isCorrect=isAnswered&&selected===question.correct_index;
    const base=question.custom_points?question.points:rules.correctAnswerPoints;
    const delta=isCorrect?base:isAnswered?-rules.wrongAnswerPenalty:-rules.unansweredPenalty;
    if(isCorrect)correct++;else if(isAnswered)wrong++;else unanswered++;
    total+=delta;
    let options:string[]=[];try{options=Array.isArray(question.options)?question.options:JSON.parse(question.options||'[]')}catch{}
    return {questionId:question.id,prompt:question.prompt,category:question.category||'General',difficulty:question.difficulty||'medium',options,selectedAnswer:isAnswered&&typeof selected==='number'?selected:null,correctAnswer:question.correct_index,result:isCorrect?'correct':isAnswered?'wrong':'unanswered',points:roundScore(delta)};
  });
  return {score:roundScore(total),correct,wrong,unanswered,rules,breakdown};
}
function normalizeCategory(input:unknown){const name=typeof input==='string'?input.trim().replace(/\s+/g,' '):'';return name.length>0&&name.length<=60&&/^[\p{L}\p{N}][\p{L}\p{N} &'’()-]*$/u.test(name)?name:null}
function ensureCategory(name:string){const existing=db.prepare('SELECT id FROM categories WHERE lower(name)=lower(?)').get(name) as {id:string}|undefined;if(existing)return existing.id;const id=randomUUID();db.prepare('INSERT INTO categories(id,name) VALUES(?,?)').run(id,name);return id}
function normalizedHeader(value:string){return value.toLowerCase().replace(/[^a-z]/g,'')}
function parseQuestionRows(rows:{rowNumber:number;cells:string[]}[]){
  if(rows.length<2)throw new Error('Import file must have a header row and at least one question row.');
  const headerMap=new Map<string,number>();
  rows[0].cells.forEach((header,index)=>{const key=normalizedHeader(header||'');if(key)headerMap.set(key,index)});
  const aliases:Record<string,string[]>={question:['questionenglish','questionen','question','questiontext'],questionKck:['questionkuki','questionkck'],questionTa:['questiontamil','questionta'],optionA:['optionaenglish','optionaen','optiona','a'],optionAKck:['optionakuki','optionakck'],optionATa:['optionatamil','optionata'],optionB:['optionbenglish','optionben','optionb','b'],optionBKck:['optionbkuki','optionbkck'],optionBTa:['optionbtamil','optionbta'],optionC:['optioncenglish','optioncen','optionc','c'],optionCKck:['optionckuki','optionckck'],optionCTa:['optionctamil','optioncta'],optionD:['optiondenglish','optionden','optiond','d'],optionDKck:['optiondkuki','optiondkck'],optionDTa:['optiondtamil','optiondta'],correctIndex:['correctindex'],correctAnswer:['correctanswer','correctoption','answer'],category:['category'],difficulty:['difficulty'],points:['points']};
  const columns:Record<string,number>={};for(const [field,names] of Object.entries(aliases)){const found=names.find(name=>headerMap.has(name));if(found)columns[field]=headerMap.get(found)!;}
  const required=['question','optionA','optionB','optionC','optionD','category','difficulty','points'];
  const missing=required.filter(field=>columns[field]===undefined);
  if(columns.correctIndex===undefined&&columns.correctAnswer===undefined)missing.push('correct_index');
  if(missing.length)throw new Error('Missing required column headers: '+missing.join(', ')+'.');
  const records=[];
  for(const row of rows.slice(1)){
    const cell=(key:string)=>String(columns[key]===undefined?'':row.cells[columns[key]]??'').trim();
    const prompt=cell('question'),options=[cell('optionA'),cell('optionB'),cell('optionC'),cell('optionD')],answer=cell('correctAnswer'),category=normalizeCategory(cell('category')),difficulty=cell('difficulty').toLowerCase(),pointsText=cell('points');
    const translations={en:{prompt,options},kck:{prompt:cell('questionKck'),options:[cell('optionAKck'),cell('optionBKck'),cell('optionCKck'),cell('optionDKck')]},ta:{prompt:cell('questionTa'),options:[cell('optionATa'),cell('optionBTa'),cell('optionCTa'),cell('optionDTa')]}};
    const problems:string[]=[];
    if(prompt.length<5||prompt.length>500)problems.push('Question must be 5–500 characters.');
    if(options.some(option=>!option||option.length>250))problems.push('All four options are required and must be 250 characters or fewer.');
    for(const language of ['kck','ta'] as const)if(translations[language].prompt.length>500||translations[language].options.some(option=>option.length>250))problems.push(`${language.toUpperCase()} translations exceed the allowed length.`);
    if(!category)problems.push('Category is required and must be 1–60 valid characters.');
    if(!['easy','medium','hard'].includes(difficulty))problems.push('Difficulty must be Easy, Medium, or Hard.');
    const points=pointsText===''?0:Number(pointsText);
    if(!Number.isInteger(points)||points<0||points>100)problems.push('Points must be a whole number from 0 to 100; use 0 to apply the global correct-answer score.');
    const trimmedAnswer=answer.trim(),letter=trimmedAnswer.match(/^(?:option\s*)?([a-d])$/i)?.[1]?.toUpperCase();
    const numeric=trimmedAnswer.match(/^[1-4]$/)?Number(trimmedAnswer):null;
    const legacyAnswerIndex=letter?letter.charCodeAt(0)-65:numeric!==null?numeric-1:options.findIndex(option=>option.toLowerCase()===trimmedAnswer.toLowerCase());
    const correctIndexText=cell('correctIndex'),answerIndex=columns.correctIndex===undefined?legacyAnswerIndex:correctIndexText===''?-1:Number(correctIndexText);
    if(!Number.isInteger(answerIndex)||answerIndex<0||answerIndex>3)problems.push(columns.correctIndex===undefined?'Correct Answer must be A–D, 1–4, or match an option exactly.':'correct_index must be an integer from 0 to 3.');
    records.push({rowNumber:row.rowNumber,prompt,options,translations,answerIndex,category,difficulty,points,problems});
  }
  return records;
}
function finalizeSubmission(userId:string) {
  return db.transaction(()=>{
    const submission=db.prepare('SELECT answers,submitted_at,score FROM submissions WHERE user_id=?').get(userId) as {answers:string;submitted_at:string|null;score:number}|undefined;
    if(!submission) return {score:0,newlySubmitted:false,submittedAt:null as string|null};
    if(submission.submitted_at) return {score:submission.score,newlySubmitted:false,submittedAt:submission.submitted_at,scoreBreakdown:null};
    const answers=parseAnswers(submission.answers);
    const rows=db.prepare('SELECT id,prompt,options,correct_index,points,custom_points,category,difficulty FROM questions ORDER BY id LIMIT 1000').all() as {id:string;prompt:string;options:string;correct_index:number;points:number;custom_points:number;category:string;difficulty:string}[];
    const calculation=scoreAnswers(answers,rows),score=calculation.score;
    const submittedAt=new Date().toISOString();
    const update=db.prepare('UPDATE submissions SET score=?,score_breakdown=?,submitted_at=? WHERE user_id=? AND submitted_at IS NULL').run(score,JSON.stringify(calculation),submittedAt,userId);
    if(!update.changes){const latest=db.prepare('SELECT score,submitted_at FROM submissions WHERE user_id=?').get(userId) as {score:number;submitted_at:string|null};return {score:latest.score,newlySubmitted:false,submittedAt:latest.submitted_at,scoreBreakdown:null};}
    return {score,newlySubmitted:true,submittedAt,scoreBreakdown:calculation};
  })();
}
async function finalizeAndNotify(userId:string){const result=finalizeSubmission(userId);if(result.newlySubmitted)await sendSubmissionEmail(userId);return result}
const endConditionTimer=setInterval(()=>{
  if(Date.now()<new Date(value('competition_end')).getTime()) return;
  const unfinished=db.prepare('SELECT user_id FROM submissions WHERE started_at IS NOT NULL AND submitted_at IS NULL').all() as {user_id:string}[];
  for(const row of unfinished) void finalizeAndNotify(row.user_id).catch(()=>{});
},5000);
endConditionTimer.unref();
function quizState(userId:string) {
  const submission=db.prepare('SELECT answers,answers_updated_at,submitted_at,score,quiz_order,current_question_index,question_started_at,started_at,question_language,warning_count FROM submissions WHERE user_id=?').get(userId) as {answers:string;answers_updated_at:string|null;submitted_at:string|null;score:number;quiz_order:string|null;current_question_index:number;question_started_at:string|null;started_at:string|null;question_language:string|null;warning_count:number}|undefined;
  if (!submission) return {started:false,submitted:false,answers:{},answersUpdatedAt:null,order:[],currentQuestionIndex:0,questionStartedAt:null,startedAt:null,submittedAt:null,warningCount:0,score:0,language:'en',competitionLanguage:'english'};
  const latest=db.prepare('SELECT submitted_at,score FROM submissions WHERE user_id=?').get(userId) as {submitted_at:string|null;score:number};
  let order:string[]=[]; try { order=JSON.parse(submission.quiz_order||'[]'); } catch {}
  const language=normalizeLanguage(submission.question_language)||'en';
  return {started:Boolean(submission.started_at),submitted:Boolean(latest.submitted_at),answers:parseAnswers(submission.answers),answersUpdatedAt:submission.answers_updated_at,order,currentQuestionIndex:submission.current_question_index,questionStartedAt:submission.question_started_at,startedAt:submission.started_at,submittedAt:latest.submitted_at,warningCount:submission.warning_count,score:latest.score,language,competitionLanguage:languageSlug(language)};
}
function validAccessCode(userId:string,code:unknown) {
  if(typeof code!=='string')return null;
  const record=db.prepare("SELECT ac.code,ac.competition_id,ac.language,ac.payment_status,ac.used_status,p.status paid_status,p.competition_id payment_competition_id,p.language payment_language FROM access_codes ac JOIN payments p ON p.id=ac.payment_id WHERE ac.user_id=? AND ac.code=? AND ac.competition_id=? AND ac.payment_status='paid' AND p.status='paid' AND p.competition_id=ac.competition_id AND p.language=ac.language").get(userId,code,value('competition_id')) as {code:string;competition_id:string;language:string;payment_status:string;used_status:number;paid_status:string;payment_competition_id:string;payment_language:string}|undefined;
  return record&&normalizeLanguage(record.language)?record:null;
}
function verifiedCode(userId:string,code:unknown) { return Boolean(validAccessCode(userId,code)); }
function cleanAnswers(input:unknown) {
  if(!input||typeof input!=='object'||Array.isArray(input)) return null;
  const allowed=new Set((db.prepare('SELECT id FROM questions').all() as {id:string}[]).map(q=>q.id));
  const safe:Record<string,number|null>={};
  for(const [id,choice] of Object.entries(input)) if(allowed.has(id)&&(choice===null||typeof choice==='number'&&Number.isInteger(choice)&&choice>=0&&choice<8)) safe[id]=choice as number|null;
  return safe;
}
function analyticsSnapshot(){
  const participantCount=(db.prepare("SELECT count(*) n FROM users WHERE role='participant'").get() as {n:number}).n;
  const paidCount=(db.prepare("SELECT count(DISTINCT p.user_id) n FROM payments p JOIN users u ON u.id=p.user_id WHERE p.status='paid' AND u.role='participant'").get() as {n:number}).n;
  const submissions=db.prepare('SELECT answers,score,started_at,submitted_at FROM submissions WHERE submitted_at IS NOT NULL').all() as {answers:string;score:number;started_at:string|null;submitted_at:string}[];
  const scores=submissions.map(row=>Number(row.score)).filter(Number.isFinite);
  const durations=submissions.map(row=>row.started_at?Math.max(0,(new Date(row.submitted_at).getTime()-new Date(row.started_at).getTime())/1000):NaN).filter(Number.isFinite);
  const questions=db.prepare('SELECT id,prompt,category,difficulty,correct_index FROM questions ORDER BY id').all() as {id:string;prompt:string;category:string;difficulty:string;correct_index:number}[];
  const questionStats=new Map(questions.map(question=>[question.id,{...question,correct:0,wrong:0,skipped:0}]));
  const difficultyStats=new Map<string,{difficulty:string;questions:number;correct:number;wrong:number;skipped:number}>();
  const categoryStats=new Map<string,{category:string;questions:number;correct:number;wrong:number;skipped:number}>();
  for(const question of questions){const difficulty=question.difficulty||'medium',category=question.category||'General';if(!difficultyStats.has(difficulty))difficultyStats.set(difficulty,{difficulty,questions:0,correct:0,wrong:0,skipped:0});if(!categoryStats.has(category))categoryStats.set(category,{category,questions:0,correct:0,wrong:0,skipped:0});difficultyStats.get(difficulty)!.questions++;categoryStats.get(category)!.questions++;}
  for(const submission of submissions){
    const answers=parseAnswers(submission.answers);
    for(const [questionId,answer] of Object.entries(answers)){
      const question=questionStats.get(questionId);if(!question)continue;
      const difficulty=difficultyStats.get(question.difficulty||'medium')!,category=categoryStats.get(question.category||'General')!;
      if(answer===undefined||answer===null){question.skipped++;difficulty.skipped++;category.skipped++;}
      else if(answer===question.correct_index){question.correct++;difficulty.correct++;category.correct++;}
      else{question.wrong++;difficulty.wrong++;category.wrong++;}
    }
  }
  for(const question of questionStats.values())question.skipped=Math.max(0,submissions.length-question.correct-question.wrong);
  for(const stat of difficultyStats.values())stat.skipped=Math.max(0,submissions.length*stat.questions-stat.correct-stat.wrong);
  for(const stat of categoryStats.values())stat.skipped=Math.max(0,submissions.length*stat.questions-stat.correct-stat.wrong);
  const withAccuracy=(stat:any)=>({...stat,accuracyPercent:submissions.length&&stat.questions?roundScore(stat.correct/(submissions.length*stat.questions)*100):0});
  const ranked=[...questionStats.values()];
  const questionSummary=(field:'correct'|'wrong'|'skipped')=>ranked.filter(q=>q[field]>0).sort((a,b)=>b[field]-a[field]).slice(0,5).map(q=>({id:q.id,prompt:q.prompt,category:q.category||'General',count:q[field]}));
  return {totalParticipants:participantCount,totalSubmissions:submissions.length,averageScore:scores.length?roundScore(scores.reduce((sum,n)=>sum+n,0)/scores.length):0,highestScore:scores.reduce((max,n)=>Math.max(max,n),0),lowestScore:scores.length?scores.reduce((min,n)=>Math.min(min,n),Infinity):0,averageCompletionSeconds:durations.length?roundScore(durations.reduce((sum,n)=>sum+n,0)/durations.length):0,paidParticipants:paidCount,unpaidParticipants:Math.max(0,participantCount-paidCount),difficultyAnalysis:[...difficultyStats.values()].map(withAccuracy),categoryPerformance:[...categoryStats.values()].map(withAccuracy).sort((a,b)=>b.accuracyPercent-a.accuracyPercent),mostCorrectlyAnswered:questionSummary('correct'),mostIncorrectlyAnswered:questionSummary('wrong'),mostSkipped:questionSummary('skipped')};
}
app.get('/api/questions',auth,(req:AuthedRequest,res)=>{
  const codeRecord=req.user!.role!=='admin'?validAccessCode(req.user!.id,req.query.code):null;
  if(req.user!.role!=='admin'&&!codeRecord) return res.status(403).json({error:'A valid paid access code is required to view competition questions.'});
  const sub=db.prepare('SELECT quiz_order,question_language,started_at FROM submissions WHERE user_id=?').get(req.user!.id) as {quiz_order:string|null;question_language:string|null;started_at:string|null}|undefined;
  if(req.user!.role!=='admin'&&!sub?.started_at)return res.status(409).json({error:'Start the live competition before loading questions.'});
  let rows=db.prepare('SELECT id,prompt,options,english_question,kuki_question,tamil_question,english_options,kuki_options,tamil_options,points,custom_points,category,difficulty FROM questions ORDER BY id LIMIT 1000').all() as any[];
  const language=req.user!.role==='admin'?normalizeLanguage(req.query.language)||'en':normalizeLanguage(sub?.question_language)||normalizeLanguage(codeRecord?.language)||'en';
  if(sub?.quiz_order) { try { const order=JSON.parse(sub.quiz_order) as string[]; const byId=new Map(rows.map(q=>[q.id,q])); rows=order.map(id=>byId.get(id)).filter(Boolean); } catch {} }
  const rules=scoringRules();
  res.json({language,competitionLanguage:languageSlug(language),questions:localizeQuestionRows(rows,language).map((q:any)=>({...q,points:q.custom_points?q.points:rules.correctAnswerPoints}))});
});
app.post('/api/payments/checkout',rateLimit(8,60*1000),auth,async(req:AuthedRequest,res)=>{
  const user=req.user!;
  const found=db.prepare("SELECT ac.code,p.id,p.status,p.paid_at FROM access_codes ac JOIN payments p ON p.id=ac.payment_id WHERE ac.user_id=? AND ac.competition_id=? AND ac.payment_status='paid' AND p.status='paid'").get(user.id,value('competition_id')) as {code:string;id:string;status:string;paid_at:string}|undefined;
  const participantLanguage=(db.prepare('SELECT competition_language FROM users WHERE id=?').get(user.id) as {competition_language:string}|undefined)?.competition_language||'english';
  const competitionId=value('competition_id');
  if(found)return res.json({paid:true,code:found.code,payment:participantSnapshot(user.id).payment});
  if(process.env.DEMO_MODE==='true') {
    const amount=Number(value('entry_fee')),currency=value('currency').toUpperCase();
    if(!Number.isSafeInteger(amount)||amount<=0||!/^[A-Z]{3}$/.test(currency))return res.status(400).json({error:'The entry fee or currency is invalid. Please contact the organizer.'});
    const paymentId=randomUUID();
    db.prepare("INSERT INTO payments(id,user_id,provider,status,amount,currency,competition_id,language) VALUES(?,?,'demo','pending',?,?,?,?)").run(paymentId,user.id,amount,currency,competitionId,participantLanguage);
    const issued=issueCode(user.id,paymentId,'demo');
    if(!issued)return res.status(500).json({error:'Could not confirm the demo payment.'});
    const emailResult=await sendTransactionalEmail(user.id,'payment',paymentId,'payment:'+paymentId);
    return res.json({paid:true,code:issued.code,demo:true,emailStatus:emailResult.status,payment:participantSnapshot(user.id).payment});
  }
  if(!process.env.STRIPE_SECRET_KEY) return res.status(503).json({error:'Payments are not configured. Please contact the organizer.'});
  const amount=Number(value('entry_fee')),currency=value('currency').toUpperCase();
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(amount*100)||!/^[A-Z]{3}$/.test(currency))return res.status(400).json({error:'The entry fee or currency is invalid. Please contact the organizer.'});
  const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
  const pending=db.prepare("SELECT id,provider_ref FROM payments WHERE user_id=? AND provider='stripe' AND status='pending' ORDER BY created_at DESC LIMIT 1").get(user.id) as {id:string;provider_ref:string|null}|undefined;
  if(pending?.provider_ref){
    try{const session=await stripe.checkout.sessions.retrieve(pending.provider_ref);if(session.status==='open'&&session.url)return res.json({url:session.url,paymentId:pending.id,status:'pending'});if(session.status==='complete')return res.status(202).json({paymentId:pending.id,status:'pending'}) ;if(session.status==='expired')markPaymentFailed(pending.id,user.id);else return res.status(409).json({error:'The payment is still processing. Please refresh your dashboard shortly.'})}catch{return res.status(503).json({error:'Could not check the existing payment session. Please try again shortly.'})}
  }else if(pending){return res.status(409).json({error:'A payment session is already being created. Please try again shortly.'})}
  try {
    const paymentId=randomUUID();
    db.prepare('INSERT INTO payments(id,user_id,provider,status,amount,currency,competition_id,language) VALUES(?,?,?,?,?,?,?,?)').run(paymentId,user.id,'stripe','pending',amount,currency,competitionId,participantLanguage);
    const session=await stripe.checkout.sessions.create({mode:'payment',customer_email:user.email,success_url:(process.env.APP_URL||'http://localhost:5173')+'/?payment=success',cancel_url:(process.env.APP_URL||'http://localhost:5173')+'/?payment=cancelled',line_items:[{price_data:{currency:currency.toLowerCase(),unit_amount:amount*100,product_data:{name:value('competition_title')+' entry'}},quantity:1}],metadata:{userId:user.id,paymentId},payment_intent_data:{metadata:{userId:user.id,paymentId}}});
    db.prepare('UPDATE payments SET provider_ref=?,updated_at=? WHERE id=?').run(session.id,new Date().toISOString(),paymentId);
    res.json({url:session.url,paymentId,status:'pending'});
  } catch {const failed=db.prepare("SELECT id FROM payments WHERE user_id=? AND provider='stripe' AND status='pending' ORDER BY created_at DESC LIMIT 1").get(user.id) as {id:string}|undefined;if(failed)markPaymentFailed(failed.id,user.id);res.status(502).json({error:'Could not start checkout. Please try again.'});}
});
app.post('/api/competition/start',auth,(req:AuthedRequest,res)=>{
  const {code}=req.body??{},codeRecord=validAccessCode(req.user!.id,code); if(!codeRecord) return res.status(403).json({error:'That access code is not valid for this account or competition.'});
  const now=Date.now(), start=new Date(value('competition_date')).getTime(), end=new Date(value('competition_end')).getTime();
  if(now<start) return res.status(403).json({error:'The competition has not started yet.'});
  if(now>end) return res.status(403).json({error:'The competition has ended.'});
  const sub=db.prepare('SELECT submitted_at,started_at FROM submissions WHERE user_id=?').get(req.user!.id) as {submitted_at:string|null;started_at:string|null}|undefined;
  if(sub?.submitted_at) return res.status(409).json({error:'Your submission is already complete.'});
  if(!sub) return res.status(409).json({error:'Your participant record is unavailable. Please contact the organizer.'});
  if(!sub.started_at) {
    const order=(db.prepare('SELECT id FROM questions ORDER BY id LIMIT 1000').all() as {id:string}[]).map(q=>q.id);
    for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
    if(!order.length) return res.status(409).json({error:'No questions are available yet. Please contact the organizer.'});
    const startedAt=new Date().toISOString();
    const language=normalizeLanguage(codeRecord.language)||'en';
    db.prepare("UPDATE submissions SET quiz_order=?,question_language=?,current_question_index=0,question_started_at=?,started_at=?,answers_updated_at=COALESCE(answers_updated_at,?) WHERE user_id=? AND started_at IS NULL").run(JSON.stringify(order),language,startedAt,startedAt,startedAt,req.user!.id);
    db.prepare('UPDATE access_codes SET used=1,used_status=1 WHERE code=? AND user_id=?').run(code,req.user!.id);
  }
  const state=quizState(req.user!.id);res.json({...state,language:state.language||normalizeLanguage(codeRecord.language)||'en',competitionLanguage:languageSlug(state.language||codeRecord.language)});
});
app.get('/api/competition/state',auth,(req:AuthedRequest,res)=>{
  const code=req.query.code,record=validAccessCode(req.user!.id,code); if(!record) return res.status(403).json({error:'Valid access code required.'});
  const state=quizState(req.user!.id);res.json({...state,language:state.started?state.language:normalizeLanguage(record.language)||'en',competitionLanguage:record.language});
});
app.put('/api/competition/answers',auth,(req:AuthedRequest,res)=>{
  const {answers,code}=req.body??{};
  if(!verifiedCode(req.user!.id,code)) return res.status(403).json({error:'Valid access code required.'});
  const safe=cleanAnswers(answers); if(!safe) return res.status(400).json({error:'Invalid answers.'});
  const row=db.prepare('SELECT answers,started_at,submitted_at FROM submissions WHERE user_id=?').get(req.user!.id) as {answers:string;started_at:string|null;submitted_at:string|null}|undefined;
  if(!row?.started_at) return res.status(409).json({error:'Start the competition before saving answers.'});
  if(row.submitted_at) return res.status(409).json({error:'Your submission is already complete.'});
  const merged={...parseAnswers(row.answers),...safe};
  db.prepare('UPDATE submissions SET answers=?,answers_updated_at=? WHERE user_id=? AND submitted_at IS NULL').run(JSON.stringify(merged),new Date().toISOString(),req.user!.id);
  res.json({saved:true});
});
app.post('/api/competition/advance',auth,async(req:AuthedRequest,res)=>{
  const {code,questionIndex}=req.body??{}; if(!verifiedCode(req.user!.id,code)) return res.status(403).json({error:'Valid access code required.'});
  const sub=db.prepare('SELECT answers,quiz_order,current_question_index,question_started_at,submitted_at,started_at FROM submissions WHERE user_id=?').get(req.user!.id) as {answers:string;quiz_order:string|null;current_question_index:number;question_started_at:string|null;submitted_at:string|null;started_at:string|null}|undefined;
  if(!sub?.started_at||!sub.quiz_order) return res.status(409).json({error:'The competition has not started.'});
  if(sub.submitted_at) return res.json(quizState(req.user!.id));
  if(Date.now()>=new Date(value('competition_end')).getTime()){const result=await finalizeAndNotify(req.user!.id);return res.json({...quizState(req.user!.id),score:result.score})}
  if(questionIndex!==sub.current_question_index) return res.json(quizState(req.user!.id));
  if(sub.question_started_at&&Date.now()-new Date(sub.question_started_at).getTime()<15000) return res.status(409).json({error:'This question timer is still running.'});
   const order=JSON.parse(sub.quiz_order) as string[], answers=parseAnswers(sub.answers), questionId=order[sub.current_question_index],answersUpdatedAt=new Date().toISOString();
  if(questionId&&answers[questionId]===undefined) answers[questionId]=null;
  if(sub.current_question_index+1>=order.length) {
    db.prepare('UPDATE submissions SET answers=?,answers_updated_at=? WHERE user_id=? AND submitted_at IS NULL').run(JSON.stringify(answers),answersUpdatedAt,req.user!.id);
    const result=await finalizeAndNotify(req.user!.id); return res.json({...quizState(req.user!.id),score:result.score});
  }
  const questionStartedAt=new Date().toISOString();
   db.prepare('UPDATE submissions SET answers=?,answers_updated_at=?,current_question_index=current_question_index+1,question_started_at=? WHERE user_id=? AND submitted_at IS NULL').run(JSON.stringify(answers),answersUpdatedAt,questionStartedAt,req.user!.id);
  res.json(quizState(req.user!.id));
});
app.post('/api/competition/warning',auth,async(req:AuthedRequest,res)=>{
  const {code,eventId}=req.body??{}; if(!verifiedCode(req.user!.id,code)) return res.status(403).json({error:'Valid access code required.'});
  if(typeof eventId!=='string'||eventId.length<1||eventId.length>100) return res.status(400).json({error:'A warning event id is required.'});
  const current=db.prepare('SELECT started_at,submitted_at,score,warning_count FROM submissions WHERE user_id=?').get(req.user!.id) as {started_at:string|null;submitted_at:string|null;score:number;warning_count:number}|undefined;
  if(!current?.started_at)return res.status(409).json({error:'The competition has not started.'});
  if(current.submitted_at)return res.json({warningCount:current.warning_count,submitted:true,score:current.score});
  const outcome=db.transaction(()=>{
    const row=db.prepare('SELECT warning_count,warning_events,submitted_at,score FROM submissions WHERE user_id=?').get(req.user!.id) as {warning_count:number;warning_events:string;submitted_at:string|null;score:number};
    if(row.submitted_at)return {warningCount:row.warning_count,submitted:true,score:row.score};
    let events:string[]=[]; try { events=JSON.parse(row.warning_events||'[]'); } catch {}
    if(!events.includes(eventId)){events.push(eventId);db.prepare('UPDATE submissions SET warning_count=warning_count+1,warning_events=? WHERE user_id=? AND submitted_at IS NULL').run(JSON.stringify(events.slice(-20)),req.user!.id);}
    const warningCount=(db.prepare('SELECT warning_count FROM submissions WHERE user_id=?').get(req.user!.id) as {warning_count:number}).warning_count;
    return {warningCount,submitted:warningCount>=3,score:null as number|null};
  })();
  if(outcome.submitted&&!current.submitted_at){const result=await finalizeAndNotify(req.user!.id);return res.json({warningCount:outcome.warningCount,submitted:true,score:result.score})}
  res.json(outcome);
});
app.post('/api/competition/submit',auth,async(req:AuthedRequest,res)=>{
  const {code,answers}=req.body??{}; if(!verifiedCode(req.user!.id,code)) return res.status(403).json({error:'Valid access code required.'});
  const submission=db.prepare('SELECT started_at,submitted_at FROM submissions WHERE user_id=?').get(req.user!.id) as {started_at:string|null;submitted_at:string|null}|undefined;
  if(!submission?.started_at) return res.status(409).json({error:'The competition has not started.'});
  if(submission.submitted_at) return res.status(409).json({error:'Submission is already complete.'});
  if(answers!==undefined){const safe=cleanAnswers(answers);if(!safe)return res.status(400).json({error:'Invalid answers.'});db.prepare('UPDATE submissions SET answers=?,answers_updated_at=? WHERE user_id=? AND submitted_at IS NULL').run(JSON.stringify(safe),new Date().toISOString(),req.user!.id);}
  const result=await finalizeAndNotify(req.user!.id);
  res.json({submitted:true,score:result.score,submittedAt:result.submittedAt});
});
app.get('/api/leaderboard',(_req,res)=>{
  const rows=db.prepare(`SELECT u.name,s.score,s.submitted_at FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.submitted_at IS NOT NULL ORDER BY s.score DESC,s.submitted_at ASC LIMIT 50`).all();
  res.json({leaderboard:rows});
});
app.get('/api/admin/overview',auth,admin,(_req,res)=>{
  const participantsList=db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.church,u.district,u.state,u.preferred_language,u.competition_language,u.created_at registration_date,
    u.active,COALESCE(p.status,'unpaid') payment,p.id payment_id,p.amount payment_amount,p.currency payment_currency,p.created_at payment_created_at,p.paid_at payment_paid_at,ac.code,ac.language access_language,ac.payment_status access_payment_status,ac.used_status access_used_status,
    (SELECT e.status FROM email_deliveries e WHERE e.user_id=u.id AND e.type='registration' ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1) registration_email_status,
    (SELECT e.status FROM email_deliveries e WHERE e.user_id=u.id AND e.payment_id=p.id AND e.type IN ('payment','access_code') ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1) payment_email_status,
    (SELECT e.status FROM email_deliveries e WHERE e.user_id=u.id AND e.type='submission' ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1) submission_email_status,
    s.score,s.started_at,s.submitted_at,s.warning_count
    FROM users u LEFT JOIN payments p ON p.id=(SELECT p2.id FROM payments p2 WHERE p2.user_id=u.id ORDER BY p2.created_at DESC,p2.rowid DESC LIMIT 1)
    LEFT JOIN access_codes ac ON ac.user_id=u.id LEFT JOIN submissions s ON s.user_id=u.id
    WHERE u.role='participant' ORDER BY u.created_at DESC`).all();
  const rules=scoringRules(),questionsList=questionRowsWithTranslations(db.prepare('SELECT id,prompt,options,english_question,kuki_question,tamil_question,english_options,kuki_options,tamil_options,correct_index,points,custom_points,category,difficulty FROM questions ORDER BY id').all()).map((q:any)=>({...q,effective_points:q.custom_points?q.points:rules.correctAnswerPoints}));
  res.json({participants:db.prepare("SELECT count(*) n FROM users WHERE role='participant'").get(),paid:db.prepare("SELECT count(DISTINCT user_id) n FROM payments WHERE status='paid'").get(),questions:db.prepare('SELECT count(*) n FROM questions').get(),submitted:db.prepare('SELECT count(*) n FROM submissions WHERE submitted_at IS NOT NULL').get(),settings:Object.fromEntries(['competition_title','competition_date','competition_end','entry_fee','currency','access_code','registration_open','correct_answer_points','wrong_answer_penalty','unanswered_penalty'].map(k=>[k,value(k)])),participantsList,questionsList,categories:db.prepare('SELECT id,name FROM categories ORDER BY name COLLATE NOCASE').all(),analytics:analyticsSnapshot(),scoring:rules});
});
app.get('/api/admin/participants/:id',auth,admin,(req,res)=>{
  const participantId=String(req.params.id),participant=db.prepare("SELECT id,name,email,phone,church,district,state,preferred_language,competition_language,created_at,active FROM users WHERE id=? AND role='participant'").get(participantId);
  if(!participant)return res.status(404).json({error:'Participant not found.'});
  const payment=db.prepare('SELECT id,status,amount,currency,provider,created_at,paid_at,refunded_at FROM payments WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(participantId);
  const code=db.prepare('SELECT ac.code,ac.competition_id,ac.language,ac.payment_status status,ac.used_status,p.status payment_status FROM access_codes ac JOIN payments p ON p.id=ac.payment_id WHERE ac.user_id=?').get(participantId);
  const submission=db.prepare('SELECT answers,score,score_breakdown,started_at,submitted_at,warning_count,question_language FROM submissions WHERE user_id=?').get(participantId) as {answers:string;score:number;score_breakdown:string|null;started_at:string|null;submitted_at:string|null;warning_count:number;question_language:string|null}|undefined;
  let answerResults:any[]=[];
  if(submission){const questions=db.prepare('SELECT id,prompt,options,correct_index,points,custom_points,category,difficulty FROM questions ORDER BY id').all() as any[];let calculation:any=null;try{calculation=submission.score_breakdown?JSON.parse(submission.score_breakdown):null}catch{}if(!calculation)calculation=scoreAnswers(parseAnswers(submission.answers),questions);answerResults=calculation.breakdown.map((row:any)=>({...row,options:row.options||JSON.parse(questions.find(q=>q.id===row.questionId)?.options||'[]')}));}
  res.json({participant,payment:payment||null,accessCode:code||null,emails:db.prepare('SELECT type,status,to_email,created_at,updated_at,error FROM email_deliveries WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(participantId),submission:submission?{score:submission.score,startedAt:submission.started_at,submittedAt:submission.submitted_at,warningCount:submission.warning_count,questionLanguage:submission.question_language,answers:answerResults}:null});
});
app.post('/api/admin/participants/:id/resend-email',auth,admin,async(req,res)=>{
  const participantId=String(req.params.id);
  const {type}=req.body??{};
  if(type!=='payment'&&type!=='access_code')return res.status(400).json({error:'Choose a payment confirmation or access code email.'});
  const participant=db.prepare("SELECT ac.payment_id FROM access_codes ac JOIN payments p ON p.id=ac.payment_id WHERE ac.user_id=? AND p.status='paid'").get(participantId) as {payment_id:string}|undefined;
  if(!participant)return res.status(409).json({error:'This participant has no active paid entry.'});
  if(!db.prepare("SELECT 1 FROM users WHERE id=? AND role='participant'").get(participantId))return res.status(404).json({error:'Participant not found.'});
  const result=await sendTransactionalEmail(participantId,type,participant.payment_id,'admin-resend:'+randomUUID());
  res.json({status:result.status});
});
app.put('/api/admin/participants/:id/status',auth,admin,(req:AuthedRequest,res)=>{
  const participantId=String(req.params.id);
  const active=req.body?.active;if(typeof active!=='boolean')return res.status(400).json({error:'Choose whether the participant is enabled or disabled.'});
  const result=db.prepare("UPDATE users SET active=? WHERE id=? AND role='participant'").run(active?1:0,participantId);
  if(!result.changes)return res.status(404).json({error:'Participant not found.'});
  logSecurityEvent(active?'participant_enabled':'participant_disabled',req,participantId);res.json({active});
});
app.post('/api/admin/participants/:id/reset',auth,admin,(req:AuthedRequest,res)=>{
  const participantId=String(req.params.id);
  if(!db.prepare("SELECT 1 FROM users WHERE id=? AND role='participant'").get(participantId))return res.status(404).json({error:'Participant not found.'});
  db.prepare("INSERT OR IGNORE INTO submissions(id,user_id) VALUES(?,?)").run(randomUUID(),participantId);
  db.prepare("UPDATE submissions SET answers='{}',answers_updated_at=NULL,score=0,score_breakdown=NULL,submitted_at=NULL,quiz_order=NULL,question_language=NULL,current_question_index=0,question_started_at=NULL,started_at=NULL,warning_count=0,warning_events='[]' WHERE user_id=?").run(participantId);
  logSecurityEvent('participant_attempt_reset',req,participantId);res.json({reset:true});
});
app.delete('/api/admin/participants/:id',auth,admin,(req:AuthedRequest,res)=>{
  const participantId=String(req.params.id);
  if(!db.prepare("SELECT 1 FROM users WHERE id=? AND role='participant'").get(participantId))return res.status(404).json({error:'Participant not found.'});
  db.transaction(()=>{db.prepare('DELETE FROM email_deliveries WHERE user_id=?').run(participantId);db.prepare('DELETE FROM access_codes WHERE user_id=?').run(participantId);db.prepare('DELETE FROM submissions WHERE user_id=?').run(participantId);db.prepare('DELETE FROM payments WHERE user_id=?').run(participantId);db.prepare("DELETE FROM users WHERE id=? AND role='participant'").run(participantId)})();
  logSecurityEvent('participant_deleted',req,participantId);res.json({deleted:true});
});
app.post('/api/admin/categories',auth,admin,(req,res)=>{
  const name=normalizeCategory(req.body?.name);if(!name)return res.status(400).json({error:'Category names must be 1–60 letters, numbers, spaces, or simple punctuation.'});
  if(db.prepare('SELECT 1 FROM categories WHERE lower(name)=lower(?)').get(name))return res.status(409).json({error:'That category already exists.'});
  const id=randomUUID();db.prepare('INSERT INTO categories(id,name) VALUES(?,?)').run(id,name);res.status(201).json({id,name});
});
app.put('/api/admin/categories/:id',auth,admin,(req,res)=>{
  const name=normalizeCategory(req.body?.name);if(!name)return res.status(400).json({error:'Category names must be 1–60 letters, numbers, spaces, or simple punctuation.'});
  const category=db.prepare('SELECT id,name FROM categories WHERE id=?').get(req.params.id) as {id:string;name:string}|undefined;
  if(!category)return res.status(404).json({error:'Category not found.'});
  if(category.name.toLowerCase()==='general')return res.status(409).json({error:'The General category is reserved.'});
  if(db.prepare('SELECT 1 FROM categories WHERE lower(name)=lower(?) AND id<>?').get(name,req.params.id))return res.status(409).json({error:'That category already exists.'});
  db.transaction(()=>{db.prepare('UPDATE questions SET category=? WHERE category=?').run(name,category.name);db.prepare('UPDATE categories SET name=? WHERE id=?').run(name,req.params.id)})();res.json({id:req.params.id,name});
});
app.delete('/api/admin/categories/:id',auth,admin,(req,res)=>{
  const category=db.prepare('SELECT id,name FROM categories WHERE id=?').get(req.params.id) as {id:string;name:string}|undefined;
  if(!category)return res.status(404).json({error:'Category not found.'});if(category.name.toLowerCase()==='general')return res.status(409).json({error:'The General category cannot be deleted.'});
  db.transaction(()=>{db.prepare("UPDATE questions SET category='General' WHERE category=?").run(category.name);db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id)})();res.json({deleted:true});
});
app.put('/api/admin/settings',auth,admin,(req,res)=>{
  const allowed=['competition_title','competition_date','competition_end','entry_fee','currency','access_code','registration_open','correct_answer_points','wrong_answer_penalty','unanswered_penalty'];
  const body=req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
  const entries:[string,string][]=Object.entries(body).filter(([k,v])=>allowed.includes(k)&&(typeof v==='string'||typeof v==='number'||typeof v==='boolean')&&String(v).length<200).map(([k,v])=>[k,String(v)]);
  for(const key of ['correct_answer_points','wrong_answer_penalty','unanswered_penalty'])if(body[key]!==undefined){const n=Number(body[key]);if(!Number.isFinite(n)||n<0||n>100||Math.round(n*100)!==n*100)return res.status(400).json({error:'Scoring values must be between 0 and 100 with at most two decimal places.'})}
  if(body.entry_fee!==undefined&&(!['string','number'].includes(typeof body.entry_fee)||!Number.isSafeInteger(Number(body.entry_fee))||Number(body.entry_fee)<=0))return res.status(400).json({error:'Entry fee must be a positive whole number.'});
  if(body.currency!==undefined&&!/^[A-Za-z]{3}$/.test(String(body.currency)))return res.status(400).json({error:'Currency must be a three-letter code.'});
  if(body.competition_title!==undefined&&String(body.competition_title).trim().length<2)return res.status(400).json({error:'Competition title must contain at least two characters.'});
  if(body.registration_open!==undefined&&![true,false,'true','false'].includes(body.registration_open))return res.status(400).json({error:'Registration status must be true or false.'});
  if(body.registration_open!==undefined&&typeof body.registration_open!=='boolean'&&typeof body.registration_open!=='string')return res.status(400).json({error:'Registration status must be true or false.'});
  const start=new Date(String(body.competition_date??value('competition_date'))).getTime(),end=new Date(String(body.competition_end??value('competition_end'))).getTime();
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return res.status(400).json({error:'Competition end time must be after its start time.'});
  const tx=db.transaction(()=>entries.forEach(([k,v])=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v as string))); tx();
  res.json({saved:true});
});
app.post('/api/admin/questions',auth,admin,(req,res)=>{
  const {id,prompt,options,correct_index,points}=req.body??{};const rawCategory=req.body?.category,category=rawCategory===undefined?'General':normalizeCategory(rawCategory),difficulty=String(req.body?.difficulty||'medium').toLowerCase();
  if(typeof prompt!=='string'||prompt.trim().length<5||prompt.trim().length>500||!Array.isArray(options)||options.length<2||options.length>8||options.some((s:unknown)=>typeof s!=='string'||!s.trim()||s.length>250)||!Number.isInteger(correct_index)||correct_index<0||correct_index>=options.length||!Number.isInteger(points)||points<0||points>100||!['easy','medium','hard'].includes(difficulty)||!category||!db.prepare('SELECT 1 FROM categories WHERE lower(name)=lower(?)').get(category)) return res.status(400).json({error:'Provide a question, 2–8 valid options, a category, difficulty, correct option, and points from 0–100.'});
  const translations=normalizeTranslationDraft(req.body?.translations,options.length);
  if(!translations)return res.status(400).json({error:'Kuki and Tamil translations must have valid text and option fields.'});
  const questionId=typeof id==='string'&&id? id:randomUUID();
  if(!db.prepare('SELECT 1 FROM questions WHERE id=?').get(questionId)&&(db.prepare('SELECT count(*) n FROM questions').get() as {n:number}).n>=1000) return res.status(409).json({error:'The question bank is limited to 1,000 questions.'});
  const kukiPrompt=translations.kck.prompt,kukiOptions=JSON.stringify(translations.kck.options),tamilPrompt=translations.ta.prompt,tamilOptions=JSON.stringify(translations.ta.options),englishOptions=JSON.stringify(options),englishPrompt=prompt.trim();
  db.transaction(()=>{
    db.prepare(`INSERT INTO questions(id,prompt,options,english_question,kuki_question,tamil_question,english_options,kuki_options,tamil_options,correct_index,points,custom_points,category,difficulty)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,options=excluded.options,english_question=excluded.english_question,kuki_question=excluded.kuki_question,tamil_question=excluded.tamil_question,english_options=excluded.english_options,kuki_options=excluded.kuki_options,tamil_options=excluded.tamil_options,correct_index=excluded.correct_index,points=excluded.points,custom_points=excluded.custom_points,category=excluded.category,difficulty=excluded.difficulty`)
      .run(questionId,englishPrompt,englishOptions,englishPrompt,kukiPrompt,tamilPrompt,englishOptions,kukiOptions,tamilOptions,correct_index,points,points>0?1:0,category,difficulty);
  })();
  res.json({saved:true,id:questionId});
});
app.post('/api/admin/questions/import',rateLimit(6,60*1000),auth,admin,(req:AuthedRequest,res)=>{
  const fileName=req.body?.fileName,content=req.body?.content;
  if(typeof fileName!=='string'||typeof content!=='string')return res.status(400).json({error:'Upload a CSV or .xlsx file.'});
  let records:any[];
  try{records=parseQuestionRows(parseQuestionImport(fileName,content))}catch(error){logSecurityEvent('question_import_rejected',req,req.user!.id,String(error));return res.status(400).json({error:(error as Error).message||'Could not read this import file.'})}
  const prompts=new Set((db.prepare('SELECT prompt FROM questions').all() as {prompt:string}[]).map(row=>row.prompt.trim().toLowerCase()));
  const knownCategories=new Map((db.prepare('SELECT name FROM categories').all() as {name:string}[]).map(row=>[row.name.toLowerCase(),row.name]));
  for(const row of records){if(!row.problems.length){const key=row.prompt.toLowerCase();if(prompts.has(key))row.problems.push('This question duplicates an existing or earlier imported question.');else prompts.add(key);if(row.category){const categoryKey=row.category.toLowerCase();row.category=knownCategories.get(categoryKey)||row.category;knownCategories.set(categoryKey,row.category)}}}
  const slots=Math.max(0,1000-(db.prepare('SELECT count(*) n FROM questions').get() as {n:number}).n);
  const accepted=records.filter(row=>row.problems.length===0);for(const row of accepted.slice(slots))row.problems.push('The 1,000-question bank limit has been reached.');
  const valid=records.filter(row=>row.problems.length===0);
  const tx=db.transaction(()=>{for(const row of valid){ensureCategory(row.category);const questionId=randomUUID(),englishOptions=JSON.stringify(row.options),kukiOptions=JSON.stringify(row.translations.kck.options),tamilOptions=JSON.stringify(row.translations.ta.options);db.prepare('INSERT INTO questions(id,prompt,options,english_question,kuki_question,tamil_question,english_options,kuki_options,tamil_options,correct_index,points,custom_points,category,difficulty) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(questionId,row.prompt,englishOptions,row.prompt,row.translations.kck.prompt,row.translations.ta.prompt,englishOptions,kukiOptions,tamilOptions,row.answerIndex,row.points,row.points>0?1:0,row.category,row.difficulty)}});tx();
  const failedRows=records.filter(row=>row.problems.length).map(row=>({rowNumber:row.rowNumber,errors:row.problems}));
  logSecurityEvent('question_import_completed',req,req.user!.id,`imported=${valid.length};failed=${failedRows.length}`);
  res.json({totalRows:records.length,imported:valid.length,failed:failedRows.length,failedRows});
});
app.delete('/api/admin/questions/:id',auth,admin,(req,res)=>{db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);res.json({deleted:true});});
app.listen(port,()=>console.log(`Bible Challenge API listening on http://localhost:${port}`));
