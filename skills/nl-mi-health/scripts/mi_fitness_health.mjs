#!/usr/bin/env node
/**
 * Standalone Xiaomi Mi Fitness health synchronizer.
 *
 * This program contains its own Passport authorization capture, encrypted
 * health requests, SQLite storage, and reporting. It never imports or runs
 * Mi-Fitness-Sync. Portions are adapted from its MIT-licensed implementation;
 * see ../LICENSE.mi-fitness-sync.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(homedir(), '.nl-mi-health');
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = resolve(APP_DIR, 'health-data');
const DEFAULT_STATE_PATH = resolve(APP_DIR, 'auth', 'auth.json');
const ACCOUNT_BASE = 'https://account.xiaomi.com';
const SERVICE_ID = 'miothealth';
const SAFE_PREFIX = '&&&START&&&';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const HEALTH_ENDPOINTS = {
  sport: ['/app/v1/data/get_sport_records_by_watermark', 'sport_records'],
  fitness: ['/app/v1/data/get_fitness_data_by_watermark', 'data_list'],
};
const REGIONS = { CN: 'cn', ID: 'sg', GB: 'de', US: 'us' };
const REGION_BY_IP_ENDPOINT = 'https://region.hlth.io.mi.com/app/v1/public/user_region_by_ip';
const REGION_BY_IP_AUTH_KEY = 'rwelJuWBFJxmbMKD';
const REQUEST_TIMEOUT_MS = 30_000;
const CN = 'Asia/Shanghai';

class MiHealthError extends Error {}

function usage() {
  return `用法：node mi_fitness_health.mjs <命令> [参数]

命令：
  login [--state-path PATH] [--email LABEL] [--timeout 秒] [--browser-channel msedge] [--browser-profile PATH]
  auth-status [--state-path PATH]
  sync [--state-path PATH] [--data-dir PATH] [--country-code CN] [--page-size 20]
  query [--state-path PATH] [--data-dir PATH] [--type TYPE] [--source sport|fitness] [--since 时间] [--until 时间] [--limit 100] [--format table|json|jsonl]
  status [--state-path PATH] [--data-dir PATH]
  types [--state-path PATH] [--data-dir PATH]
  weekly-report [--state-path PATH] [--data-dir PATH] [--end 时间] [--days 7]
  summary [--state-path PATH] [--data-dir PATH] --metric overview|sleep|activity|steps|heart-rate --since 时间 [--until 时间] [--group-by day|week|month|year]`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new MiHealthError(`不支持的位置参数：${token}`);
    const [rawKey, inline] = token.slice(2).split('=', 2);
    if (!rawKey) throw new MiHealthError('参数名不能为空。');
    const key = rawKey.replaceAll('-', '_');
    if (inline !== undefined) flags[key] = inline;
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
    else flags[key] = true;
  }
  return { command, ...flags };
}

function optionNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new MiHealthError(`${name} 必须是大于 0 的数字。`);
  return result;
}

function statePath(args) { return args.state_path ? resolve(String(args.state_path)) : DEFAULT_STATE_PATH; }
function dataPath(args) { return args.data_dir ? resolve(String(args.data_dir)) : DEFAULT_DATA_DIR; }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((done) => setTimeout(done, ms)); }

function loadState(args) {
  const path = statePath(args);
  if (!existsSync(path)) return null;
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new MiHealthError(`无法读取授权文件：${error.message}`); }
  const required = ['user_id', 'c_user_id', 'service_token', 'ssecurity', 'device_id'];
  if (!state || typeof state !== 'object' || required.some((key) => !state[key])) {
    throw new MiHealthError('本地授权文件不完整，请重新登录。');
  }
  return state;
}

function saveState(state, args) {
  const path = statePath(args);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows does not provide POSIX modes. */ }
}

async function ensureLogin(args) {
  const state = loadState(args);
  if (state) return state;
  console.error('未检测到 Mi Fitness 登录状态，正在打开浏览器供你登录…');
  const authenticated = await visibleLogin(args);
  saveState(authenticated, args);
  return authenticated;
}

function parsePayload(text) {
  let raw = String(text).trim();
  if (raw.startsWith(SAFE_PREFIX)) raw = raw.slice(SAFE_PREFIX.length);
  try {
    const payload = JSON.parse(raw);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  } catch { throw new MiHealthError('小米响应不是有效 JSON。'); }
}

function parseLoginPayload(body, headers) {
  const payload = {};
  if (body && String(body).trim()) {
    try { Object.assign(payload, parsePayload(body)); } catch { /* Some Passport responses are not JSON. */ }
  }
  const extension = headers['extension-pragma'];
  if (extension) {
    try { Object.assign(payload, JSON.parse(extension)); } catch { /* Ignore invalid metadata. */ }
  }
  if (headers.location) payload.location ??= headers.location;
  return payload;
}

function mergePayload(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined && value !== '') target[key] = value;
  }
}

function isPassportUrl(url) {
  const parsed = new URL(url);
  return parsed.hostname === 'account.xiaomi.com' && parsed.pathname.startsWith('/pass/');
}

function cookieValue(cookies, ...names) {
  for (const name of names) {
    for (const cookie of [...cookies].reverse()) if (cookie.name === name && cookie.value) return cookie.value;
  }
  return null;
}

function clientSign(nonce, security) {
  return createHash('sha1').update(`nonce=${nonce}&${security}`).digest('base64');
}

function buildStsUrl(location, sign) {
  const url = new URL(location);
  url.searchParams.set('clientSign', sign);
  url.searchParams.set('_userIdNeedEncrypt', 'true');
  return url.toString();
}

function captureStsPage(captured, pages) {
  for (const page of pages) {
    const location = page.url();
    const url = new URL(location);
    if (url.hostname === 'sts-hlth.io.mi.com' && url.pathname === '/healthapp/sts') {
      captured.location ??= location;
      captured.nonce ??= url.searchParams.get('nonce') || undefined;
    }
  }
}

function buildState(payload, cookies, args, deviceId, previous) {
  const userId = payload.userId || cookieValue(cookies, 'userId');
  const cUserId = payload.cUserId || cookieValue(cookies, 'cUserId');
  const passToken = payload.passToken || cookieValue(cookies, 'passToken');
  const serviceToken = cookieValue(cookies, `${SERVICE_ID}_serviceToken`, 'serviceToken');
  const ssecurity = payload.ssecurity;
  const location = payload.location;
  if (![userId, cUserId, passToken, serviceToken, ssecurity, location].every(Boolean)) {
    throw new MiHealthError('浏览器登录完成，但未捕获完整的 Mi Fitness 授权字段。');
  }
  const timestamp = nowIso();
  return {
    email: args.email || userId, user_id: String(userId), c_user_id: String(cUserId), service_id: SERVICE_ID,
    pass_token: String(passToken), service_token: String(serviceToken), ssecurity: String(ssecurity),
    psecurity: payload.psecurity || null, auto_login_url: String(location),
    device_id: cookieValue(cookies, 'deviceId') || deviceId,
    cookies: cookies.map(({ name, value, domain, path, secure, expires }) => ({ name, value, domain, path, secure, expires })),
    created_at: previous?.created_at || timestamp, updated_at: timestamp,
  };
}

async function ensurePlaywright() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    // 首次使用：自动在脚本所在目录执行 npm install，安装成功后重试加载。
    const pkgDir = existsSync(resolve(SCRIPT_DIR, 'package.json')) ? SCRIPT_DIR : dirname(SCRIPT_DIR);
    process.stderr.write(`未检测到 Playwright，正在自动安装（${pkgDir}）……\n`);
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env, npm_config_loglevel: 'error' };
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: pkgDir, env, stdio: 'inherit' });
    if (result.status !== 0) throw new MiHealthError('自动安装 Playwright 失败，请手动在 scripts 目录执行 npm install。');
    process.stderr.write('Playwright 安装完成。\n');
    try {
      return (await import('playwright')).chromium;
    } catch {
      throw new MiHealthError('Playwright 安装后仍无法加载，请手动在 scripts 目录执行 npm install。');
    }
  }
}

async function visibleLogin(args) {
  const timeout = optionNumber(args.timeout, '--timeout', 600);
  const chromium = await ensurePlaywright();
  const previous = loadState(args);
  const deviceId = previous?.device_id || randomBytes(8).toString('hex').toUpperCase();
  const metaResponse = await fetch(`${ACCOUNT_BASE}/pass/serviceLogin?${new URLSearchParams({ sid: SERVICE_ID, _json: 'true' })}`, {
    headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': USER_AGENT, 'X-Requested-With': 'XMLHttpRequest', Cookie: `deviceId=${deviceId}; userId=${args.email || ''}` },
  });
  if (!metaResponse.ok) throw new MiHealthError(`无法获取小米登录参数：HTTP ${metaResponse.status}`);
  const meta = parsePayload(await metaResponse.text());
  if (!meta._sign || !meta.qs || !meta.callback) throw new MiHealthError('无法获取小米登录参数。');
  const serviceParam = JSON.stringify({ checkSafePhone: false, checkSafeAddress: false, lsrp_score: 0 });
  const loginUrl = `${ACCOUNT_BASE}/fe/service/login?${new URLSearchParams({ _group: 'DEFAULT', sid: SERVICE_ID, qs: meta.qs, callback: meta.callback, _sign: meta._sign, serviceParam, showActiveX: 'false', theme: '', needTheme: 'false', bizDeviceType: '', _locale: 'zh_CN' })}`;
  const captured = {};
  let browser;
  let context;
  try {
    if (args.browser_profile) {
      const profile = resolve(String(args.browser_profile));
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      context = await chromium.launchPersistentContext(profile, { channel: args.browser_channel || 'msedge', headless: false, locale: 'zh-CN' });
    } else {
      browser = await chromium.launch({ channel: args.browser_channel || 'msedge', headless: false });
      context = await browser.newContext({ locale: 'zh-CN' });
    }
    await context.addCookies([{ name: 'deviceId', value: deviceId, domain: '.account.xiaomi.com', path: '/' }]);
    const page = await context.newPage();
    page.on('response', async (response) => {
      if (!isPassportUrl(response.url())) return;
      let body = '';
      try { body = await response.text(); } catch { /* Redirected navigations can lose their body. */ }
      mergePayload(captured, parseLoginPayload(body, response.headers()));
    });
    console.log('已打开小米账号登录页面。请在浏览器中完成密码、短信、验证码或安全确认。');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + timeout * 1000;
    let attemptedLocation;
    while (Date.now() < deadline) {
      await sleep(250);
      captureStsPage(captured, context.pages());
      if (!captured.ssecurity || !captured.location) {
        try {
          const response = await context.request.get(`${ACCOUNT_BASE}/pass/serviceLogin`, { params: { sid: SERVICE_ID, _json: 'true' }, maxRedirects: 0, timeout: 30_000 });
          mergePayload(captured, parseLoginPayload(await response.text(), response.headers()));
        } catch { /* Browser can continue to login normally. */ }
      }
      if (captured.location && captured.nonce && captured.ssecurity && captured.location !== attemptedLocation) {
        attemptedLocation = captured.location;
        try { await context.request.get(buildStsUrl(captured.location, clientSign(captured.nonce, captured.ssecurity)), { timeout: 30_000, maxRedirects: 0 }); }
        catch { /* Cookie may already have been set by navigation. */ }
      }
      const cookies = await context.cookies();
      if (attemptedLocation && cookieValue(cookies, `${SERVICE_ID}_serviceToken`, 'serviceToken')) return buildState(captured, cookies, args, deviceId, previous);
    }
    throw new MiHealthError('可见浏览器登录超时，未获得 Mi Fitness 授权。');
  } catch (error) {
    if (error instanceof MiHealthError) throw error;
    throw new MiHealthError(`无法启动或操作可见浏览器：${error.message}`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

class Rc4 {
  constructor(key) {
    this.state = Array.from({ length: 256 }, (_, index) => index); let cursor = 0;
    for (let index = 0; index < 256; index += 1) {
      cursor = (cursor + this.state[index] + key[index % key.length]) & 255;
      [this.state[index], this.state[cursor]] = [this.state[cursor], this.state[index]];
    }
    this.i = 0; this.j = 0; this.apply(Buffer.alloc(1024));
  }
  apply(data) {
    const output = Buffer.from(data);
    for (let index = 0; index < output.length; index += 1) {
      this.i = (this.i + 1) & 255; const stateI = this.state[this.i];
      this.j = (this.j + stateI) & 255; [this.state[this.i], this.state[this.j]] = [this.state[this.j], this.state[this.i]];
      output[index] ^= this.state[(this.state[this.i] + stateI) & 255];
    }
    return output;
  }
}

function base64(value) { return Buffer.from(value).toString('base64'); }
function signedNonce(security, currentNonce) { return createHash('sha256').update(Buffer.concat([Buffer.from(security, 'base64'), Buffer.from(currentNonce, 'base64')])).digest('base64'); }
function nonce() { const value = Buffer.alloc(12); randomBytes(8).copy(value); value.writeInt32BE(Math.floor(Date.now() / 60_000), 8); return value.toString('base64'); }
function signature(method, path, parameters, signed) {
  const parts = [method.toUpperCase(), new URL(path, 'https://health.invalid').pathname, ...Object.keys(parameters).sort().map((key) => `${key}=${parameters[key]}`), signed];
  return createHash('sha1').update(parts.join('&')).digest('base64');
}
function encryptedParameters(path, data, security) {
  const currentNonce = nonce(); const signed = signedNonce(security, currentNonce);
  const plain = { data: JSON.stringify(data) }; plain.rc4_hash__ = signature('GET', path, plain, signed);
  const cipher = new Rc4(Buffer.from(signed, 'base64')); const encrypted = {};
  for (const key of Object.keys(plain).sort()) encrypted[key] = base64(cipher.apply(Buffer.from(plain[key])));
  encrypted.signature = signature('GET', path, encrypted, signed); encrypted._nonce = currentNonce;
  return [currentNonce, encrypted];
}

function cookieValues(state) {
  const values = {};
  for (const cookie of state.cookies || []) {
    if (cookie?.name && cookie?.value && values[cookie.name] === undefined) values[cookie.name] = String(cookie.value);
  }
  if (!values.locale && values.uLocale) values.locale = values.uLocale;
  if (!values.userId && state.user_id) values.userId = String(state.user_id);
  return values;
}

function requestCookieHeader(state) {
  const collected = cookieValues(state);
  const cookies = { serviceToken: state.service_token, cUserId: state.c_user_id };
  for (const name of ['userId', 'locale']) if (collected[name]) cookies[name] = collected[name];
  return Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
}

async function resolveRegion(state, countryCode) {
  const override = countryCode ? REGIONS[String(countryCode).toUpperCase()] : undefined;
  if (override) return override;
  try {
    const response = await fetch(REGION_BY_IP_ENDPOINT, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': USER_AGENT, Cookie: `auth_key=${REGION_BY_IP_AUTH_KEY}`, RegionTag: 'ignore' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return 'cn';
    const payload = await response.json();
    const region = payload?.result?.region;
    return typeof region === 'string' && region.trim() ? region.trim().toLowerCase() : 'cn';
  } catch {
    return 'cn';
  }
}

class HealthStore {
  constructor(path) {
    this.dataDir = path; this.rawDir = resolve(path, 'raw'); this.dbPath = resolve(path, 'health.sqlite3');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); mkdirSync(this.rawDir, { recursive: true, mode: 0o700 }); this.initialize();
  }
  open() { return new DatabaseSync(this.dbPath, { timeout: 5_000 }); }
  initialize() {
    const db = this.open();
    try { db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_state (stream TEXT PRIMARY KEY, watermark INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, last_error TEXT);
      CREATE TABLE IF NOT EXISTS records (source TEXT NOT NULL, record_id TEXT NOT NULL, data_type TEXT NOT NULL, timestamp INTEGER, deleted INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, raw_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source, record_id));
      CREATE INDEX IF NOT EXISTS idx_records_type_time ON records(data_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_records_source_time ON records(source, timestamp DESC);`); }
    finally { db.close(); }
  }
  phoneId() {
    const db = this.open();
    try { const row = db.prepare("SELECT value FROM metadata WHERE key='phone_id'").get(); if (row) return String(row.value); const value = randomUUID(); db.prepare("INSERT INTO metadata VALUES ('phone_id', ?)").run(value); return value; }
    finally { db.close(); }
  }
  watermark(source) { const db = this.open(); try { return Number(db.prepare('SELECT watermark FROM sync_state WHERE stream=?').get(source)?.watermark || 0); } finally { db.close(); } }
  setWatermark(source, value) { const db = this.open(); try { db.prepare('INSERT INTO sync_state(stream,watermark,updated_at,last_error) VALUES(?,?,?,NULL) ON CONFLICT(stream) DO UPDATE SET watermark=excluded.watermark,updated_at=excluded.updated_at,last_error=NULL').run(source, value, nowIso()); } finally { db.close(); } }
  upsert(source, records, watermark) {
    const db = this.open(); const changed = []; const timestamp = nowIso();
    try {
      const find = db.prepare('SELECT content_hash FROM records WHERE source=? AND record_id=?');
      const write = db.prepare('INSERT INTO records(source,record_id,data_type,timestamp,deleted,content_hash,raw_json,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source,record_id) DO UPDATE SET data_type=excluded.data_type,timestamp=excluded.timestamp,deleted=excluded.deleted,content_hash=excluded.content_hash,raw_json=excluded.raw_json,updated_at=excluded.updated_at');
      for (const item of records) {
        const raw = JSON.stringify(item); const digest = createHash('sha256').update(raw).digest('hex');
        const recordId = [item.sid, item.key, item.time].filter((value) => value !== undefined && value !== null && value !== '').join(':') || digest;
        if (find.get(source, recordId)?.content_hash === digest) continue;
        write.run(source, recordId, String(item.key || item.category || source), recordTimestamp(item), item.deleted === true ? 1 : 0, digest, raw, timestamp, timestamp); changed.push(item);
      }
    } finally { db.close(); }
    if (changed.length) appendFileSync(resolve(this.rawDir, `${source}.jsonl`), changed.map((record) => JSON.stringify({ captured_at: timestamp, source, watermark, record })).join('\n') + '\n', 'utf8');
    return changed.length;
  }
  rows({ since, until, source, dataType, types, limit = 1_000_000 } = {}) {
    const clauses = ['deleted=0']; const values = [];
    for (const [clause, value] of [['timestamp>=?', since], ['timestamp<=?', until], ['source=?', source], ['data_type=?', dataType]]) if (value !== undefined && value !== null) { clauses.push(clause); values.push(value); }
    if (types?.length) { clauses.push(`data_type IN (${types.map(() => '?').join(',')})`); values.push(...types); }
    values.push(limit); const db = this.open();
    try { return db.prepare(`SELECT source,record_id,data_type,timestamp,raw_json FROM records WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`).all(...values).map((row) => ({ ...row, raw: JSON.parse(row.raw_json) })); }
    finally { db.close(); }
  }
  status() { const db = this.open(); try { return { ...db.prepare('SELECT COUNT(*) AS total,MIN(timestamp) AS oldest,MAX(timestamp) AS newest FROM records WHERE deleted=0').get(), streams: db.prepare('SELECT stream,watermark,updated_at,last_error FROM sync_state ORDER BY stream').all() }; } finally { db.close(); } }
  types() { const db = this.open(); try { return db.prepare('SELECT source,data_type,COUNT(*) AS count,MIN(timestamp) AS oldest,MAX(timestamp) AS newest FROM records WHERE deleted=0 GROUP BY source,data_type ORDER BY source,data_type').all(); } finally { db.close(); } }
}

function recordTimestamp(record) { for (const key of ['time', 'timestamp', 'start_time']) { const value = Number(record[key]); if (Number.isFinite(value)) return Math.trunc(value); } return null; }
function watermarkFrom(result, records, current) { for (const key of ['watermark', 'next_watermark', 'nextWatermark', 'max_watermark']) { const value = Number(result[key]); if (Number.isFinite(value) && value >= current) return value; } return Math.max(current, ...records.map(recordTimestamp).filter((value) => value !== null)); }

async function syncHealth(state, store, args) {
  const pageSize = optionNumber(args.page_size, '--page-size', 20); const region = await resolveRegion(state, args.country_code); const cookieHeader = requestCookieHeader(state); const result = { sport: 0, fitness: 0, unchanged: 0 };
  console.error(`开始同步：区域 ${region}，每页最多 ${pageSize} 条。`);
  for (const [source, [path, responseKey]] of Object.entries(HEALTH_ENDPOINTS)) {
    let watermark = store.watermark(source); const phoneId = store.phoneId(); let pageNumber = 0;
    while (true) {
      pageNumber += 1;
      if (pageNumber === 1 || pageNumber % 100 === 0) console.error(`${source}：正在拉取第 ${pageNumber} 页（watermark ${watermark}）。`);
      const previousWatermark = watermark; const [currentNonce, parameters] = encryptedParameters(path, { phone_id: phoneId, watermark, limit: pageSize }, state.ssecurity);
      const endpoint = region === 'cn' ? `https://hlth.io.mi.com${path}` : `https://${region}.hlth.io.mi.com${path}`;
      let response;
      try { response = await fetch(`${endpoint}?${new URLSearchParams(parameters)}`, { headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': USER_AGENT, Cookie: cookieHeader, region_tag: region }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
      catch (error) { throw new MiHealthError(`${source} 同步请求失败：${error.message}`); }
      if (response.status === 401) throw new MiHealthError('小米授权已失效，请重新运行 login 后再同步。');
      if (!response.ok) throw new MiHealthError(`${source} 同步请求失败：HTTP ${response.status}`);
      let payload;
      try { payload = JSON.parse(new Rc4(Buffer.from(signedNonce(state.ssecurity, currentNonce), 'base64')).apply(Buffer.from(await response.text(), 'base64')).toString()); }
      catch { throw new MiHealthError(`无法解密 ${source} 同步响应。`); }
      if (payload.code !== 0) throw new MiHealthError(`${payload.message || `${source} 同步接口返回错误`}（接口码 ${payload.code}，区域 ${region}，watermark ${previousWatermark}）`);
      const page = payload.result && typeof payload.result === 'object' ? payload.result : {}; const records = Array.isArray(page[responseKey]) ? page[responseKey].filter((item) => item && typeof item === 'object') : [];
      const nextMark = watermarkFrom(page, records, previousWatermark); const changed = store.upsert(source, records, nextMark); result[source] += changed; result.unchanged += records.length - changed;
      if (nextMark > previousWatermark) { watermark = nextMark; store.setWatermark(source, watermark); }
      if (!records.length || page.has_more === false || (records.length < pageSize && page.has_more !== true)) break;
      if (nextMark <= previousWatermark) throw new MiHealthError(`${source} watermark 未推进，已停止以避免重复分页。`);
    }
    console.error(`${source}：完成 ${pageNumber} 页，新增或更新 ${result[source]} 条。`);
  }
  return result;
}

function parseTime(value) { if (/^\d+$/.test(String(value))) return Number(value); const normalized = String(value).endsWith('Z') || /[+-]\d\d:\d\d$/.test(String(value)) ? String(value) : `${value}T00:00:00+08:00`; const timestamp = Date.parse(normalized); if (!Number.isFinite(timestamp)) throw new MiHealthError(`无法识别时间：${value}`); return Math.floor(timestamp / 1000); }
function formatTime(value) { if (!Number.isFinite(Number(value))) return '-'; return new Intl.DateTimeFormat('sv-SE', { timeZone: CN, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Number(value) * 1000)).replace(' ', ' '); }
function localDay(timestamp) { return new Intl.DateTimeFormat('sv-SE', { timeZone: CN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp * 1000)); }
function valueOf(row) { const value = row.raw?.value; if (value && typeof value === 'object') return value; try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && typeof value !== 'boolean' ? parsed : null; }
function average(values) { return values.reduce((total, value) => total + value, 0) / values.length; }
function minutesText(value) { const rounded = Math.round(value); return rounded >= 60 ? `${Math.floor(rounded / 60)} 小时 ${rounded % 60} 分` : `${rounded} 分`; }
function activityName(value) { return ({ free_training: '自由训练', outdoor_hiking: '户外徒步', outdoor_riding: '户外骑行', outdoor_running: '户外跑步', outdoor_walking: '户外步行', strength_training: '力量训练' })[value] || value; }
function period(timestamp, groupBy) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CN, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp * 1000)); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); if (groupBy === 'day') return `${value.year}-${value.month}-${value.day}`; if (groupBy === 'month') return `${value.year}-${value.month}`; if (groupBy === 'year') return value.year; const date = new Date(`${value.year}-${value.month}-${value.day}T00:00:00Z`); const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - day); const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1)); return `${date.getUTCFullYear()}-W${String(Math.ceil((((date - first) / 86400000) + 1) / 7)).padStart(2, '0')}`; }

function reportWindow(end, days) { const local = new Intl.DateTimeFormat('en-CA', { timeZone: CN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(end * 1000)); const finish = Date.parse(`${local}T23:59:59.999+08:00`); const start = finish - (days - 1) * 86400000 - 86399999; return [Math.floor(start / 1000), Math.floor(finish / 1000)]; }
function weeklyReport(store, end, days) {
  if (!Number.isInteger(days) || days <= 0) throw new MiHealthError('--days 必须大于 0。'); const [since, until] = reportWindow(end, days);
  const rows = store.rows({ since, until, types: ['steps', 'calories', 'sleep', 'heart_rate', 'resting_heart_rate', 'training_load', 'vitality'] }); const workouts = store.rows({ since, until, source: 'sport' });
  const steps = new Map(); let calories = 0; const sleeps = []; const heartRates = []; const resting = []; let load; let vitality;
  for (const row of rows) { const value = valueOf(row); if (row.data_type === 'steps' && row.timestamp) { const amount = number(value.steps); if (amount !== null) steps.set(localDay(row.timestamp), (steps.get(localDay(row.timestamp)) || 0) + amount); } else if (row.data_type === 'calories') calories += number(value.calories) || 0; else if (row.data_type === 'sleep') { const amount = number(value.duration); if (amount !== null) sleeps.push(amount); } else if (row.data_type === 'heart_rate') { const amount = number(value.bpm); if (amount !== null) heartRates.push(amount); } else if (row.data_type === 'resting_heart_rate') { const amount = number(value.bpm); if (amount !== null) resting.push(amount); } else if (row.data_type === 'training_load') load = number(value.wtl_sum); else if (row.data_type === 'vitality') vitality = number(value.latest_accumulated_vitality); }
  const mainSleep = sleeps.filter((value) => value >= 180); const shortSleep = sleeps.filter((value) => value < 180); const duration = workouts.reduce((total, row) => total + (number(valueOf(row).duration) || 0), 0); const distance = workouts.reduce((total, row) => total + (number(valueOf(row).distance) || 0), 0); const kinds = Object.groupBy(workouts, (row) => row.data_type);
  const lines = [`健康周报（${formatTime(since).slice(0, 10)} 至 ${formatTime(until).slice(0, 10)}，中国时间）`, `数据最新时间：${formatTime(store.status().newest)}`, '', '活动', `- 步数：${Math.trunc([...steps.values()].reduce((total, value) => total + value, 0)).toLocaleString()}（有数据天数 ${steps.size} 天）`, `- 活动热量：${calories.toFixed(1)} 千卡`, `- 运动：${workouts.length} 次，累计 ${minutesText(duration / 60)}`];
  if (distance) lines.push(`- 运动距离：${(distance / 1000).toFixed(2)} 公里`); for (const [kind, values] of Object.entries(kinds)) lines.push(`  - ${activityName(kind)}：${values.length} 次`);
  if (mainSleep.length || shortSleep.length) { lines.push('', '睡眠'); if (mainSleep.length) lines.push(`- 主睡眠（≥3 小时）：${mainSleep.length} 次，平均 ${minutesText(average(mainSleep))}`); if (shortSleep.length) lines.push(`- 短时睡眠：${shortSleep.length} 次，累计 ${minutesText(shortSleep.reduce((total, value) => total + value, 0))}`); }
  if (heartRates.length || resting.length) { lines.push('', '心率'); if (heartRates.length) lines.push(`- 心率采样：${heartRates.length} 次，平均 ${average(heartRates).toFixed(0)} bpm，范围 ${Math.min(...heartRates).toFixed(0)}–${Math.max(...heartRates).toFixed(0)} bpm`); if (resting.length) lines.push(`- 静息心率：${resting.length} 次，平均 ${average(resting).toFixed(0)} bpm`); }
  if (load !== null && load !== undefined || vitality !== null && vitality !== undefined) { lines.push('', '训练指标'); if (load !== null && load !== undefined) lines.push(`- 最新训练负荷：${load}`); if (vitality !== null && vitality !== undefined) lines.push(`- 最新活力值：${vitality}`); }
  return lines.join('\n');
}

function summary(store, args) {
  const since = parseTime(args.since); const until = args.until ? parseTime(args.until) : Math.floor(Date.now() / 1000); if (since > until) throw new MiHealthError('--since 必须早于或等于 --until。'); const metric = args.metric; const groupBy = args.group_by || 'month'; if (!['overview', 'sleep', 'activity', 'steps', 'heart-rate'].includes(metric)) throw new MiHealthError('--metric 无效。'); if (!['day', 'week', 'month', 'year'].includes(groupBy)) throw new MiHealthError('--group-by 无效。'); if (metric === 'overview') return weeklyReport(store, until, Math.max(1, Math.floor((until - since) / 86400) + 1));
  const types = { sleep: ['sleep'], activity: undefined, steps: ['steps'], 'heart-rate': ['heart_rate'] }[metric]; const rows = store.rows({ since, until, source: metric === 'activity' ? 'sport' : undefined, types }); const grouped = Object.groupBy(rows.filter((row) => row.timestamp), (row) => period(row.timestamp, groupBy)); const title = { sleep: '睡眠汇总', activity: '运动汇总', steps: '步数汇总', 'heart-rate': '心率汇总' }[metric]; const label = { day: '天', week: '周', month: '月', year: '年' }[groupBy]; const lines = [`${title}（${formatTime(since).slice(0, 10)} 至 ${formatTime(until).slice(0, 10)}，按${label}）`];
  if (!Object.keys(grouped).length) return `${lines.join('\n')}\n本时间范围内没有可汇总的记录。`;
  for (const key of Object.keys(grouped).sort()) { const items = grouped[key]; const values = items.map(valueOf); let text; if (metric === 'sleep') { const durations = values.map((value) => number(value.duration)).filter((value) => value !== null); const main = durations.filter((value) => value >= 180); const short = durations.filter((value) => value < 180); text = `主睡眠 ${main.length} 次${main.length ? `，平均 ${minutesText(average(main))}` : ''}${short.length ? `；短时睡眠 ${short.length} 次，累计 ${minutesText(short.reduce((total, value) => total + value, 0))}` : ''}`; } else if (metric === 'activity') { const duration = values.reduce((total, value) => total + (number(value.duration) || 0), 0); const distance = values.reduce((total, value) => total + (number(value.distance) || 0), 0); const kinds = Object.groupBy(items, (item) => item.data_type); text = `${items.length} 次，累计 ${minutesText(duration / 60)}${distance ? `，${(distance / 1000).toFixed(2)} 公里` : ''}（${Object.entries(kinds).map(([kind, entries]) => `${activityName(kind)} ${entries.length} 次`).join('、')}）`; } else if (metric === 'steps') text = `${Math.trunc(values.reduce((total, value) => total + (number(value.steps) || 0), 0)).toLocaleString()} 步`; else { const bpms = values.map((value) => number(value.bpm)).filter((value) => value !== null); text = bpms.length ? `${bpms.length} 次，平均 ${average(bpms).toFixed(0)} bpm，范围 ${Math.min(...bpms).toFixed(0)}–${Math.max(...bpms).toFixed(0)} bpm` : '无有效心率值'; } lines.push(`- ${key}：${text}`); }
  return lines.join('\n');
}

function printQuery(store, args) { const limit = optionNumber(args.limit, '--limit', 100); const rows = store.rows({ since: args.since ? parseTime(args.since) : undefined, until: args.until ? parseTime(args.until) : undefined, source: args.source, dataType: args.type, limit }); if ((args.format || 'table') === 'json') return console.log(JSON.stringify(rows, null, 2)); if (args.format === 'jsonl') return rows.forEach((row) => console.log(JSON.stringify(row))); if (!rows.length) return console.log('没有匹配记录。'); rows.forEach((row) => console.log(`${formatTime(row.timestamp)} | ${row.source} | ${row.data_type} | ${JSON.stringify(row.raw).slice(0, 120)}`)); }
function printStatus(store) { const status = store.status(); console.log(`数据目录：${store.dataDir}\n数据库：${store.dbPath}\n记录数：${status.total}\n最早：${formatTime(status.oldest)}\n最新：${formatTime(status.newest)}`); status.streams.forEach((stream) => console.log(`${stream.stream}: watermark=${stream.watermark}，更新=${stream.updated_at}`)); }
function printTypes(store) { store.types().forEach((item) => console.log(`${item.source} | ${item.data_type} | ${item.count} | ${formatTime(item.oldest)} ~ ${formatTime(item.newest)}`)); }

async function main() {
  const args = parseArguments(process.argv.slice(2)); if (args.command === 'help') { console.log(usage()); return; }
  if (!['login', 'auth-status', 'sync', 'query', 'status', 'types', 'weekly-report', 'summary'].includes(args.command)) throw new MiHealthError(`未知命令：${args.command}\n\n${usage()}`);
  if (args.command === 'login') { saveState(await visibleLogin(args), args); console.log('可见浏览器登录成功，授权已安全保存。'); return; }
  if (args.command === 'auth-status') { const state = loadState(args); if (!state) throw new MiHealthError('未找到 Mi Fitness 本地登录状态。'); console.log(`已找到 Mi Fitness 登录状态。\n授权文件：${statePath(args)}\n用户 ID：${state.user_id || '-'}\n服务令牌：${state.service_token ? '存在' : '缺失'}\n更新时间：${state.updated_at || '-'}`); return; }
  const state = await ensureLogin(args); const store = new HealthStore(dataPath(args));
  if (args.command === 'sync') { const result = await syncHealth(state, store, args); console.log(`健康数据同步完成。\n数据目录：${store.dataDir}\n运动记录变更：${result.sport}\n健康记录变更：${result.fitness}\n未变化记录：${result.unchanged}`); return; }
  if (args.command === 'query') return printQuery(store, args);
  if (args.command === 'status') return printStatus(store);
  if (args.command === 'types') return printTypes(store);
  if (args.command === 'weekly-report') return console.log(weeklyReport(store, args.end ? parseTime(args.end) : Math.floor(Date.now() / 1000), optionNumber(args.days, '--days', 7)));
  return console.log(summary(store, args));
}

export { HealthStore, Rc4, encryptedParameters, parseTime, reportWindow, weeklyReport, summary };

function isMainEntry() {
  if (!process.argv[1]) return false;
  const argvPath = fileURLToPath(import.meta.url);
  const candidate = resolve(process.argv[1]);
  if (candidate === argvPath) return true;
  // ESM normalizes import.meta.url to the real path, but process.argv[1]
  // keeps the invocation path (often a symlink, e.g. ~/.agents -> real dir).
  // Resolve both through realpath so symlinked skill dirs still match.
  try { return realpathSync(candidate) === realpathSync(argvPath); }
  catch { return false; }
}

if (isMainEntry()) {
  main().catch((error) => { console.error(`错误：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
