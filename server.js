import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, cleanupExpiredSessions, databasePath } from './src/db.js';
import { CATEGORIES, addDaysISO, attributeGain, levelFromXp, localDateISO, progression, rewardForDifficulty } from './src/game.js';

const scryptAsync = promisify(scrypt);
const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const publicDir = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';
const trustProxy = process.env.TRUST_PROXY === '1';
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;
const rateBuckets = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

function securityHeaders(contentType = 'text/plain; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(isProduction ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    'Cache-Control': contentType.includes('text/html') ? 'no-cache' : 'public, max-age=3600'
  };
}
function send(res, status, body = '', headers = {}) {
  const contentType = headers['Content-Type'] || 'text/plain; charset=utf-8';
  res.writeHead(status, { ...securityHeaders(contentType), ...headers }); res.end(body);
}
function json(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
function error(res, status, message, code = 'REQUEST_ERROR') { json(res, status, { ok: false, error: { code, message } }); }

function parseCookies(req) {
  const cookies = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('='); if (i < 0) continue;
    const key = pair.slice(0, i).trim(); const value = pair.slice(i + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}
function sessionCookie(sessionId, maxAge = sessionMaxAgeSeconds) {
  const secure = isProduction || trustProxy ? '; Secure' : '';
  return `lrpg_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function getIp(req) {
  if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(req, key, max, windowMs) {
  const now = Date.now(); const bucketKey = `${key}:${getIp(req)}`; const previous = rateBuckets.get(bucketKey);
  if (!previous || previous.resetAt <= now) { rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs }); return true; }
  if (previous.count >= max) return false; previous.count += 1; return true;
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new Error('PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_JSON'); }
}
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function cleanText(value, max = 120) { return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max); }
function validTimeZone(value) {
  const candidate = String(value || 'UTC').slice(0, 80);
  try { Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(); return candidate; } catch { return 'UTC'; }
}
async function hashPassword(password) {
  const salt = randomBytes(16); const derived = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${Buffer.from(derived).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':'); if (!saltHex || !hashHex) return false;
  const actual = Buffer.from(await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64)); const expected = Buffer.from(hashHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function createSession(userId) {
  const id = randomBytes(32).toString('hex'); const csrfToken = randomBytes(24).toString('hex');
  const createdAt = new Date(); const expiresAt = new Date(createdAt.getTime() + sessionMaxAgeSeconds * 1000);
  db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, csrfToken, expiresAt.toISOString(), createdAt.toISOString());
  return { id, csrfToken, expiresAt };
}
function getSession(req) {
  const id = parseCookies(req).lrpg_session; if (!id) return null;
  return db.prepare(`SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?`)
    .get(id, new Date().toISOString()) || null;
}
function requireSession(req, res) { const s = getSession(req); if (!s) { error(res, 401, 'Sign in to continue.', 'AUTH_REQUIRED'); return null; } return s; }
function requireCsrf(req, res, session) {
  const token = String(req.headers['x-csrf-token'] || '');
  if (!token || token !== session.csrf_token) { error(res, 403, 'Security token mismatch. Refresh and try again.', 'CSRF_MISMATCH'); return false; }
  return true;
}
function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name, timezone: user.timezone, gold: user.gold, streak: user.streak,
    lastActiveDate: user.last_active_date, equippedTheme: user.equipped_theme, equippedBadge: user.equipped_badge, ...progression(user.total_xp) };
}
function getAttributes(userId) { return db.prepare('SELECT intellect,strength,discipline,vitality FROM attributes WHERE user_id=?').get(userId); }
function getTasks(userId) {
  return db.prepare(`SELECT id,title,notes,category,difficulty,xp_reward AS xpReward,gold_reward AS goldReward,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE user_id=? ORDER BY completed_at IS NOT NULL ASC, created_at DESC`).all(userId);
}
function getShop(userId) {
  return db.prepare(`SELECT s.id,s.name,s.description,s.price,s.type,s.icon,s.key,CASE WHEN i.item_id IS NULL THEN 0 ELSE 1 END AS owned FROM shop_items s LEFT JOIN inventory i ON i.item_id=s.id AND i.user_id=? ORDER BY s.sort_order`).all(userId).map(i => ({...i, owned:Boolean(i.owned)}));
}
function getInventory(userId) {
  return db.prepare(`SELECT s.id,s.name,s.description,s.price,s.type,s.icon,s.key,i.purchased_at AS purchasedAt FROM inventory i JOIN shop_items s ON s.id=i.item_id WHERE i.user_id=? ORDER BY i.purchased_at DESC`).all(userId);
}
function getActivity(userId, limit = 8) {
  return db.prepare(`SELECT id,event_type AS eventType,message,xp_delta AS xpDelta,gold_delta AS goldDelta,attribute,attribute_delta AS attributeDelta,created_at AS createdAt FROM activity_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?`).all(userId, Math.min(30, Math.max(1, Number(limit)||8)));
}
function dashboardPayload(userId, csrfToken) {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  return { ok:true, csrfToken, user:publicUser(user), attributes:getAttributes(userId), tasks:getTasks(userId), shop:getShop(userId), inventory:getInventory(userId), activity:getActivity(userId) };
}
function logActivity({userId, taskId=null, eventType, message, xpDelta=0, goldDelta=0, attribute=null, attributeDelta=0}) {
  db.prepare(`INSERT INTO activity_logs (id,user_id,task_id,event_type,message,xp_delta,gold_delta,attribute,attribute_delta,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), userId, taskId, eventType, message, xpDelta, goldDelta, attribute, attributeDelta, new Date().toISOString());
}
function categoryIsValid(v) { return Object.hasOwn(CATEGORIES, v); }
function difficultyIsValid(v) { return ['easy','medium','hard','epic'].includes(v); }

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? join(publicDir, 'index.html') : join(publicDir, pathname); filePath = normalize(filePath);
  if (!filePath.startsWith(publicDir)) return error(res, 403, 'Forbidden.', 'FORBIDDEN');
  try {
    const stats=statSync(filePath); if (!stats.isFile()) throw new Error('NOT_FILE'); const ext=extname(filePath).toLowerCase(); let body=readFileSync(filePath);
    if (ext === '.html') {
      const buildId=createHash('sha1').update(PUBLIC_URL).digest('hex').slice(0,8);
      body=body.toString('utf8').replaceAll('__PUBLIC_URL__',PUBLIC_URL).replaceAll('__BUILD_ID__',buildId);
    }
    send(res,200,body,{'Content-Type':MIME[ext]||'application/octet-stream'});
  } catch { error(res,404,'Not found.','NOT_FOUND'); }
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (pathname === '/api/health' && req.method === 'GET') return json(res,200,{ok:true,service:'life-rpg',time:new Date().toISOString()});

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!rateLimit(req,'register',8,60000)) return error(res,429,'Too many attempts. Try again in a minute.','RATE_LIMITED');
    const body=await readJson(req); const email=normalizeEmail(body.email); const password=String(body.password||''); const displayName=cleanText(body.displayName,40); const timezone=validTimeZone(body.timezone);
    if (!displayName || displayName.length<2) return error(res,400,'Display name must be at least 2 characters.','INVALID_NAME');
    if (!validEmail(email)) return error(res,400,'Enter a valid email address.','INVALID_EMAIL');
    if (password.length<8 || password.length>128) return error(res,400,'Password must be 8–128 characters.','WEAK_PASSWORD');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return error(res,409,'An account with that email already exists.','EMAIL_EXISTS');
    const userId=randomUUID(); const passwordHash=await hashPassword(password); const now=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO users (id,email,password_hash,display_name,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(userId,email,passwordHash,displayName,timezone,now,now);
      db.prepare('INSERT INTO attributes (user_id) VALUES (?)').run(userId);
      logActivity({userId,eventType:'account_created',message:'Your campaign begins.'}); db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
    const session=createSession(userId); return json(res,201,dashboardPayload(userId,session.csrfToken),{'Set-Cookie':sessionCookie(session.id)});
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!rateLimit(req,'login',12,60000)) return error(res,429,'Too many attempts. Try again in a minute.','RATE_LIMITED');
    const body=await readJson(req); const email=normalizeEmail(body.email); const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !(await verifyPassword(String(body.password||''),user.password_hash))) return error(res,401,'Email or password is incorrect.','INVALID_CREDENTIALS');
    if (body.timezone) db.prepare('UPDATE users SET timezone=?,updated_at=? WHERE id=?').run(validTimeZone(body.timezone),new Date().toISOString(),user.id);
    const session=createSession(user.id); return json(res,200,dashboardPayload(user.id,session.csrfToken),{'Set-Cookie':sessionCookie(session.id)});
  }
  if (pathname === '/api/me' && req.method === 'GET') { const s=requireSession(req,res); if(!s)return; return json(res,200,{ok:true,csrfToken:s.csrf_token,user:publicUser(s)}); }
  if (pathname === '/api/dashboard' && req.method === 'GET') { const s=requireSession(req,res); if(!s)return; return json(res,200,dashboardPayload(s.id,s.csrf_token)); }
  if (pathname === '/api/auth/logout' && req.method === 'POST') { const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return; db.prepare('DELETE FROM sessions WHERE id=?').run(s.session_id); return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)}); }

  if (pathname === '/api/tasks' && req.method === 'POST') {
    const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return;
    const body=await readJson(req); const title=cleanText(body.title,120); const notes=cleanText(body.notes,300); const category=String(body.category||''); const difficulty=String(body.difficulty||'');
    if(!title) return error(res,400,'Quest title cannot be empty.','EMPTY_TASK');
    if(!categoryIsValid(category)) return error(res,400,'Choose a valid attribute.','INVALID_CATEGORY');
    if(!difficultyIsValid(difficulty)) return error(res,400,'Choose a valid difficulty.','INVALID_DIFFICULTY');
    const reward=rewardForDifficulty(difficulty); const id=randomUUID(); const now=new Date().toISOString();
    db.prepare('INSERT INTO tasks (id,user_id,title,notes,category,difficulty,xp_reward,gold_reward,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id,s.id,title,notes,category,difficulty,reward.xp,reward.gold,now,now);
    logActivity({userId:s.id,taskId:id,eventType:'task_created',message:`Quest added: ${title}`});
    const task=db.prepare('SELECT id,title,notes,category,difficulty,xp_reward AS xpReward,gold_reward AS goldReward,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE id=?').get(id);
    return json(res,201,{ok:true,task});
  }

  const taskMatch=pathname.match(/^\/api\/tasks\/([a-f0-9-]+)$/i);
  if(taskMatch && req.method==='PATCH') {
    const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return;
    const task=db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskMatch[1],s.id);
    if(!task) return error(res,404,'Quest not found.','TASK_NOT_FOUND');
    if(task.completed_at) return error(res,409,'Completed quests are locked to protect progression history.','TASK_LOCKED');
    const body=await readJson(req); const title=cleanText(body.title??task.title,120); const notes=cleanText(body.notes??task.notes,300); const category=String(body.category??task.category); const difficulty=String(body.difficulty??task.difficulty);
    if(!title) return error(res,400,'Quest title cannot be empty.','EMPTY_TASK');
    if(!categoryIsValid(category)) return error(res,400,'Choose a valid attribute.','INVALID_CATEGORY');
    if(!difficultyIsValid(difficulty)) return error(res,400,'Choose a valid difficulty.','INVALID_DIFFICULTY');
    const reward=rewardForDifficulty(difficulty); const now=new Date().toISOString();
    db.prepare('UPDATE tasks SET title=?,notes=?,category=?,difficulty=?,xp_reward=?,gold_reward=?,updated_at=? WHERE id=? AND user_id=?')
      .run(title,notes,category,difficulty,reward.xp,reward.gold,now,task.id,s.id);
    const updated=db.prepare('SELECT id,title,notes,category,difficulty,xp_reward AS xpReward,gold_reward AS goldReward,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE id=?').get(task.id);
    return json(res,200,{ok:true,task:updated});
  }

  if(taskMatch && req.method==='DELETE') {
    const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return;
    const task=db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(taskMatch[1],s.id);
    if(!task) return error(res,404,'Quest not found.','TASK_NOT_FOUND');
    db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(task.id,s.id);
    logActivity({userId:s.id,eventType:'task_deleted',message:`Quest removed: ${task.title}`});
    return json(res,200,{ok:true});
  }

  const completeMatch=pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/complete$/i);
  if(completeMatch && req.method==='POST') {
    const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return;
    const task=db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(completeMatch[1],s.id);
    if(!task) return error(res,404,'Quest not found.','TASK_NOT_FOUND');
    if(task.completed_at) return error(res,409,'This quest is already complete.','ALREADY_COMPLETED');
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(s.id); const oldLevel=levelFromXp(user.total_xp);
    const newXp=user.total_xp+task.xp_reward; const newGold=user.gold+task.gold_reward; const attrGain=attributeGain(task.xp_reward);
    const today=localDateISO(user.timezone); const yesterday=addDaysISO(today,-1); let newStreak=user.streak;
    if(user.last_active_date!==today) newStreak=user.last_active_date===yesterday ? user.streak+1 : 1;
    const now=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const updated=db.prepare('UPDATE tasks SET completed_at=?,updated_at=? WHERE id=? AND user_id=? AND completed_at IS NULL').run(now,now,task.id,s.id);
      if(updated.changes!==1) throw new Error('TASK_RACE');
      db.prepare('UPDATE users SET total_xp=?,gold=?,streak=?,last_active_date=?,updated_at=? WHERE id=?').run(newXp,newGold,newStreak,today,now,s.id);
      db.prepare(`UPDATE attributes SET ${task.category}=${task.category}+? WHERE user_id=?`).run(attrGain,s.id);
      logActivity({userId:s.id,taskId:task.id,eventType:'task_completed',message:`Quest cleared: ${task.title}`,xpDelta:task.xp_reward,goldDelta:task.gold_reward,attribute:task.category,attributeDelta:attrGain});
      db.exec('COMMIT');
    } catch(e) {
      db.exec('ROLLBACK'); if(e.message==='TASK_RACE') return error(res,409,'This quest was already completed.','ALREADY_COMPLETED'); throw e;
    }
    const updatedUser=db.prepare('SELECT * FROM users WHERE id=?').get(s.id); const newLevel=levelFromXp(updatedUser.total_xp);
    return json(res,200,{ok:true,reward:{xp:task.xp_reward,gold:task.gold_reward,attribute:task.category,attributeGain:attrGain,leveledUp:newLevel>oldLevel,oldLevel,newLevel},data:dashboardPayload(s.id,s.csrf_token)});
  }

  if(pathname==='/api/shop' && req.method==='GET') { const s=requireSession(req,res); if(!s)return; return json(res,200,{ok:true,shop:getShop(s.id),inventory:getInventory(s.id)}); }

  const buyMatch=pathname.match(/^\/api\/shop\/([^/]+)\/buy$/);
  if(buyMatch && req.method==='POST') {
    const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return;
    const item=db.prepare('SELECT * FROM shop_items WHERE id=?').get(decodeURIComponent(buyMatch[1]));
    if(!item) return error(res,404,'Item not found.','ITEM_NOT_FOUND');
    if(db.prepare('SELECT 1 FROM inventory WHERE user_id=? AND item_id=?').get(s.id,item.id)) return error(res,409,'You already own this item.','ALREADY_OWNED');
    const user=db.prepare('SELECT * FROM users WHERE id=?').get(s.id); if(user.gold<item.price) return error(res,409,`You need ${item.price-user.gold} more gold.`,'NOT_ENOUGH_GOLD');
    const now=new Date().toISOString(); db.exec('BEGIN IMMEDIATE');
    try {
      const debit=db.prepare('UPDATE users SET gold=gold-?,updated_at=? WHERE id=? AND gold>=?').run(item.price,now,s.id,item.price);
      if(debit.changes!==1) throw new Error('BALANCE_RACE');
      db.prepare('INSERT INTO inventory (user_id,item_id,purchased_at) VALUES (?,?,?)').run(s.id,item.id,now);
      logActivity({userId:s.id,eventType:'item_bought',message:`Acquired ${item.name}`,goldDelta:-item.price}); db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); if(e.message==='BALANCE_RACE') return error(res,409,'Gold balance changed. Refresh and try again.','BALANCE_CHANGED'); throw e; }
    return json(res,200,dashboardPayload(s.id,s.csrf_token));
  }

  const equipMatch=pathname.match(/^\/api\/inventory\/([^/]+)\/equip$/);
  if(equipMatch && req.method==='POST') {
    const s=requireSession(req,res); if(!s||!requireCsrf(req,res,s))return;
    const itemId=decodeURIComponent(equipMatch[1]);
    const item=db.prepare('SELECT s.* FROM inventory i JOIN shop_items s ON s.id=i.item_id WHERE i.user_id=? AND i.item_id=?').get(s.id,itemId);
    if(!item) return error(res,404,'Own this item before equipping it.','NOT_OWNED');
    const now=new Date().toISOString();
    if(item.type==='theme') db.prepare('UPDATE users SET equipped_theme=?,updated_at=? WHERE id=?').run(item.key,now,s.id);
    else if(item.type==='badge') db.prepare('UPDATE users SET equipped_badge=?,updated_at=? WHERE id=?').run(item.key,now,s.id);
    else return error(res,400,'Relics are collectibles and cannot be equipped.','NOT_EQUIPPABLE');
    logActivity({userId:s.id,eventType:'item_equipped',message:`Equipped ${item.name}`}); return json(res,200,dashboardPayload(s.id,s.csrf_token));
  }

  return error(res,404,'API route not found.','NOT_FOUND');
}

const server=createServer(async(req,res)=>{
  try {
    const host=req.headers.host||`localhost:${PORT}`; const protocol=trustProxy&&req.headers['x-forwarded-proto']?String(req.headers['x-forwarded-proto']):'http';
    const url=new URL(req.url||'/',`${protocol}://${host}`);
    if(url.pathname==='/robots.txt') return send(res,200,`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nSitemap: ${PUBLIC_URL}/sitemap.xml\n`,{'Content-Type':'text/plain; charset=utf-8'});
    if(url.pathname==='/sitemap.xml') {
      const updated=new Date().toISOString().slice(0,10); const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/sitemap/0.9"><url><loc>${PUBLIC_URL}/</loc><lastmod>${updated}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>`;
      return send(res,200,xml,{'Content-Type':'application/xml; charset=utf-8'});
    }
    if(url.pathname.startsWith('/api/')) return await handleApi(req,res,url);
    if(url.pathname==='/app'||url.pathname==='/app/') return serveStatic(req,res,'/app.html');
    return serveStatic(req,res,url.pathname);
  } catch(e) {
    console.error('[server error]',e);
    if(e.message==='PAYLOAD_TOO_LARGE') return error(res,413,'Request is too large.','PAYLOAD_TOO_LARGE');
    if(e.message==='INVALID_JSON') return error(res,400,'Request body must be valid JSON.','INVALID_JSON');
    return error(res,500,'The realm hit an unexpected error. Try again.','INTERNAL_ERROR');
  }
});
cleanupExpiredSessions(); setInterval(cleanupExpiredSessions,60*60*1000).unref();
server.listen(PORT,()=>{ console.log(`Life RPG ready at http://localhost:${PORT}`); console.log(`Database: ${databasePath}`); });
