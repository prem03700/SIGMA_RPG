import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const port = 4317;
const root = resolve(new URL('..', import.meta.url).pathname);
const dbPath = resolve(root, 'data', 'smoke-test.db');
const base = `http://127.0.0.1:${port}`;
const email = `smoke-${Date.now()}@example.com`;
const password = 'correct-horse-2026';
let server;
let cookie = '';
let csrf = '';

function cleanDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
}

async function stopServer() {
  if (!server || server.killed) return;
  server.kill('SIGTERM');
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => { server.kill('SIGKILL'); resolveStop(); }, 1500);
    server.once('exit', () => { clearTimeout(timer); resolveStop(); });
  });
}

async function waitForHealth() {
  let lastError;
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastError || new Error('Server did not become healthy.');
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && cookie) headers.Cookie = cookie;
  if (auth && csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await response.json();
  return { response, data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

cleanDb();
try {
  startServer();
  await waitForHealth();

  const home = await fetch(`${base}/`);
  const html = await home.text();
  assert(home.ok && html.includes('Your day is the'), 'Landing page did not render.');

  const registration = await request('/api/auth/register', {
    method: 'POST', auth: false,
    body: { displayName: 'Smoke Player', email, password, timezone: 'Asia/Kolkata' }
  });
  assert(registration.response.status === 201, `Registration failed: ${JSON.stringify(registration.data)}`);
  csrf = registration.data.csrfToken;
  assert(cookie.includes('lrpg_session='), 'Session cookie was not created.');

  const emptyTask = await request('/api/tasks', { method: 'POST', body: { title: '', category: 'intellect', difficulty: 'medium' } });
  assert(emptyTask.response.status === 400 && emptyTask.data.error.code === 'EMPTY_TASK', 'Empty-task validation failed.');

  const created = await request('/api/tasks', {
    method: 'POST',
    body: { title: 'Ship the smoke test', notes: 'Verify persistence and rewards', category: 'discipline', difficulty: 'hard' }
  });
  assert(created.response.status === 201, `Task creation failed: ${JSON.stringify(created.data)}`);
  assert(created.data.task.xpReward === 70 && created.data.task.goldReward === 25, 'Server reward calculation is incorrect.');

  const taskId = created.data.task.id;
  const completed = await request(`/api/tasks/${taskId}/complete`, { method: 'POST' });
  assert(completed.response.ok, `Task completion failed: ${JSON.stringify(completed.data)}`);
  assert(completed.data.reward.xp === 70 && completed.data.data.user.totalXp === 70, 'XP was not persisted correctly.');
  assert(completed.data.data.user.gold === 25 && completed.data.data.attributes.discipline === 35, 'Gold/attribute rewards were not persisted correctly.');
  assert(completed.data.data.user.streak === 1, 'Streak did not start after completion.');

  // Prove account isolation with a second user.
  const firstCookie = cookie;
  const firstCsrf = csrf;
  cookie = '';
  csrf = '';
  const secondRegistration = await request('/api/auth/register', {
    method: 'POST', auth: false,
    body: { displayName: 'Second Player', email: `second-${email}`, password, timezone: 'Asia/Kolkata' }
  });
  assert(secondRegistration.response.status === 201, 'Second account registration failed.');
  csrf = secondRegistration.data.csrfToken;
  const secondDashboard = await request('/api/dashboard');
  assert(secondDashboard.data.tasks.length === 0 && secondDashboard.data.user.totalXp === 0, 'User data leaked between accounts.');

  cookie = firstCookie;
  csrf = firstCsrf;
  const firstDashboard = await request('/api/dashboard');
  assert(firstDashboard.data.tasks.some((task) => task.id === taskId), 'First user lost ownership of their task.');

  await stopServer();
  cookie = '';
  csrf = '';
  startServer();
  await waitForHealth();

  const login = await request('/api/auth/login', { method: 'POST', auth: false, body: { email, password, timezone: 'Asia/Kolkata' } });
  assert(login.response.ok, `Login after restart failed: ${JSON.stringify(login.data)}`);
  csrf = login.data.csrfToken;

  const dashboard = await request('/api/dashboard');
  const persisted = dashboard.data.tasks.find((task) => task.id === taskId);
  assert(persisted?.completedAt, 'Completed task did not survive server restart.');
  assert(dashboard.data.user.totalXp === 70 && dashboard.data.user.gold === 25, 'Character progression did not survive restart.');

  console.log('✓ landing page served');
  console.log('✓ secure account/session flow works');
  console.log('✓ invalid empty quest is rejected');
  console.log('✓ server-owned quest rewards work');
  console.log('✓ XP, gold, attributes and streak persist');
  console.log('✓ user data is isolated between accounts');
  console.log('✓ SQLite data survives a server restart');
  console.log('Smoke test passed.');
} finally {
  await stopServer();
  cleanDb();
}
