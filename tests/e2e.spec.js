// End-to-end tests for Секрет за секрет. See the README for how to run them.
// They write real rows to Supabase, and each new browser context uses one anonymous sign-in
// (Supabase limits these per hour), so avoid running the whole file repeatedly.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SUPABASE_URL = html.match(/SUPABASE_URL = "([^"]+)"/)[1];
const ANON_KEY = html.match(/SUPABASE_ANON_KEY = "([^"]+)"/)[1];
const IDS_FILE = path.join(__dirname, '.game-ids.txt');
const logGame = id => fs.appendFileSync(IDS_FILE, id + '\n');

const NASTYA = { name: 'Настя', g: 'f', label: 'сон', tag: 'Н' };
const VLAD = { name: 'Влад', g: 'm', label: 'стих', tag: 'В' };
const truthOf = (p, i) => `${p.tag} правда ${i + 1}`;
const decoyOf = (p, i) => `${p.tag} ложь ${i + 1}`;
const pieceOf = (p, i) => `${p.tag} кусок ${i + 1}`;

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  return { ctx, page };
}

async function createGame(page) {
  await page.goto('/');
  await page.click('#create');
  await page.waitForURL(/#g-[a-z0-9]{12,}$/);
  await expect(page.locator('form#setup')).toBeVisible();
  const id = page.url().split('#g-')[1];
  logGame(id);
  return id;
}

async function fillSetup(page, p) {
  await page.fill('[data-k="name"]', p.name);
  await page.click(p.g === 'f' ? '#ctl-gf' : '#ctl-gm');
  await page.fill('[data-k="label"]', p.label);
  for (let i = 0; i < 5; i++) {
    await page.fill(`[data-k="t${i}"]`, p.truth ? p.truth(i) : truthOf(p, i));
    await page.fill(`[data-k="d${i}a"]`, p.decoy ? p.decoy(i) : decoyOf(p, i));
    await page.fill(`[data-k="d${i}b"]`, `${p.tag} вторая ложь ${i + 1}`);
  }
  for (let i = 0; i < 4; i++) await page.fill(`[data-k="l${i}"]`, pieceOf(p, i));
}
const submit = page => page.click('form#setup button[type=submit]');

// Two players seated in a fresh game, both on the round 1 screen.
async function seatTwo(browser, a = NASTYA, b = VLAD, optsB = {}) {
  const A = await newContext(browser);
  const B = await newContext(browser, optsB);
  const id = await createGame(A.page);
  await fillSetup(A.page, a);
  await submit(A.page);
  await expect(A.page.locator('h1')).toContainText('Ставки сделаны');
  await B.page.goto(`/#g-${id}`);
  await fillSetup(B.page, b);
  await submit(B.page);
  await expect(A.page.locator('#rtag')).toHaveText('Раунд 1/5');
  await expect(B.page.locator('#rtag')).toHaveText('Раунд 1/5');
  return { A, B, id };
}

async function setBet(page, bet) {
  const out = page.locator('.stepper output');
  for (let n = 0; n < 12; n++) {
    const cur = Number(await out.textContent());
    if (cur === bet) return;
    await page.click(cur < bet ? '#ctl-plus' : '#ctl-minus');
    await expect(out).not.toHaveText(String(cur));
  }
  throw new Error(`could not set bet ${bet}`);
}

async function play(page, i, move) {
  await expect(page.locator('#rtag')).toHaveText(`Раунд ${i + 1}/5`);
  if (move.pass) { await page.getByRole('button', { name: 'Пас', exact: true }).click(); return; }
  await page.locator('.opt[role=radio]', { hasText: move.text }).click();
  await setBet(page, move.bet);
  await page.getByRole('button', { name: /^Иду на/ }).click();
}

const chips = async page => [
  Number(await page.locator('.board .me .num').textContent()),
  Number(await page.locator('.board .them .num').textContent()),
];
const openPieces = page => page.locator('.secret .piece.open');

async function openRound(page, i) {
  await page.getByRole('button', { name: `Вскрыть раунд ${i + 1}` }).click();
  await expect(page.locator('.res-h').first()).toBeVisible();
}
const nextRound = (page, i) =>
  page.getByRole('button', { name: i === 4 ? 'К финалу' : 'Следующий раунд' }).click();

async function anon() {
  const c = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw error;
  return { c, uid: data.user.id };
}
const row = (over = {}) => ({ name: 'T', g: 'm', label: 'x', joinedAt: Date.now(), options: {}, picks: {}, truth: {}, pieces: [], surrendered: false, ...over });
const rawGameId = () => 'test' + Math.random().toString(36).slice(2, 12).padEnd(10, '0');

test.describe('4.1 smoke', () => {
  test('landing, fonts, client, sign-in, create', async ({ browser }) => {
    const { ctx, page } = await newContext(browser);
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Поиграем?');
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')));
    expect(fonts).toContain('Bricolage Grotesque');
    const id = await createGame(page);
    expect(id).toMatch(/^[a-z0-9]{12,}$/);
    const session = await page.evaluate(() => localStorage.getItem('ssz-auth'));
    expect(session).toBeTruthy();
    await page.evaluate(() => document.fonts.ready);
    expect(page.errors).toEqual([]);
    await ctx.close();
  });

  test('fonts cover Cyrillic, the language of the whole UI', async ({ browser }) => {
    const { ctx, page } = await newContext(browser);
    await page.goto('/');
    // Fetched by the browser so Google returns the same subset list a real visitor gets.
    const css = await page.evaluate(() => fetch(document.querySelector('link[rel=stylesheet]').href).then(r => r.text()));
    const subsets = family => [...css.matchAll(/\/\* ([\w-]+) \*\/\s*@font-face\s*{\s*font-family: '([^']+)'/g)].filter(m => m[2] === family).map(m => m[1]);
    expect(subsets('Bricolage Grotesque').length, 'CSS lists subsets').toBeGreaterThan(0);
    expect.soft(subsets('Bricolage Grotesque'), 'Bricolage Grotesque').toContain('cyrillic');
    expect.soft(subsets('Space Mono'), 'Space Mono').toContain('cyrillic');
    await ctx.close();
  });
});

test.describe('4.2 setup and joining', () => {
  test('validation', async ({ browser }) => {
    const { ctx, page } = await newContext(browser);
    await createGame(page);
    const err = page.locator('.err');
    const focused = () => page.evaluate(() => document.activeElement.dataset.k);
    await submit(page);
    await expect(err).toContainText('Напиши имя');
    expect(await focused()).toBe('name');
    await page.fill('[data-k="name"]', 'Настя');
    await submit(page);
    await expect(err).toContainText('он или она');
    await page.click('#ctl-gf');
    await submit(page);
    await expect(err).toContainText('Раунд 1: напиши правду');
    expect(await focused()).toBe('t0');
    await page.fill('[data-k="t0"]', 'Да');
    await submit(page);
    await expect(err).toContainText('нужен ложный ответ');
    expect(await focused()).toBe('d0a');
    await page.fill('[data-k="d0a"]', 'да');
    await submit(page);
    await expect(err).toContainText('второй ложный');
    expect(await focused()).toBe('d0b');
    await page.fill('[data-k="d0b"]', 'ДА');
    await submit(page);
    await expect(err).toContainText('должны различаться');
    await fillSetup(page, NASTYA);
    await page.fill('[data-k="l2"]', '');
    await submit(page);
    await expect(err).toContainText('кусочек 3');
    expect(await focused()).toBe('l2');
    await ctx.close();
  });

  test('waiting screen, invite link, Realtime start, third player refused', async ({ browser }) => {
    const A = await newContext(browser);
    await A.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    const B = await newContext(browser);
    const id = await createGame(A.page);
    await fillSetup(A.page, NASTYA);
    await submit(A.page);
    await expect(A.page.locator('h1')).toContainText('Ставки сделаны, Настя');
    await A.page.getByRole('button', { name: 'Скопировать ссылку' }).click();
    await expect(A.page.getByRole('button', { name: 'Скопировано' })).toBeVisible();
    const link = await A.page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain(`#g-${id}`);

    await B.page.goto(link);
    await fillSetup(B.page, VLAD);
    await submit(B.page);
    // Shorter than the 15-second poll, so only Realtime can pass this.
    await expect(A.page.locator('#rtag')).toHaveText('Раунд 1/5', { timeout: 10000 });

    const C = await newContext(browser);
    await C.page.goto(link);
    await fillSetup(C.page, { ...VLAD, name: 'Третий' });
    await submit(C.page);
    await expect(C.page.locator('.err')).toContainText('За этим столом уже сидят двое');
    const seats = await A.page.evaluate(async ([url, key, id]) => {
      const token = JSON.parse(localStorage.getItem('ssz-auth')).access_token;
      const r = await fetch(`${url}/rest/v1/ssz_players?game_id=eq.${id}&select=uid`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
      return (await r.json()).length;
    }, [SUPABASE_URL, ANON_KEY, id]);
    expect(seats).toBe(2);
    for (const x of [A, B, C]) await x.ctx.close();
  });
});

test.describe('4.3 rounds and scoring', () => {
  test('scripted full game', async ({ browser }) => {
    const { A, B } = await seatTwo(browser);
    const a = A.page, b = B.page;

    // Options on each side are the opponent's, and never your own.
    await expect(a.locator('.opt[role=radio]')).toHaveCount(3);
    await expect(a.locator('.opt[role=radio]', { hasText: truthOf(VLAD, 0) })).toHaveCount(1);
    await expect(a.locator('.opt[role=radio]', { hasText: truthOf(NASTYA, 0) })).toHaveCount(0);
    await expect(b.locator('.opt[role=radio]', { hasText: truthOf(NASTYA, 0) })).toHaveCount(1);

    // Stepper and quick buttons, round 1: limits 1 to 5.
    await a.getByRole('button', { name: 'Осторожно' }).click();
    await expect(a.locator('.stepper output')).toHaveText('1');
    await expect(a.locator('#ctl-minus')).toBeDisabled();
    await a.getByRole('button', { name: 'Половина' }).click();
    await expect(a.locator('.stepper output')).toHaveText('3');
    await a.getByRole('button', { name: 'Ва-банк' }).click();
    await expect(a.locator('.stepper output')).toHaveText('5');
    await expect(a.locator('#ctl-plus')).toBeDisabled();

    // Gendered text in the round screen.
    await expect(a.locator('.sub')).toContainText('Как ответил Влад?');
    await expect(b.locator('.sub')).toContainText('Как ответила Настя?');

    // Hand-computed. A = Настя, B = Влад. Totals are [A, B] after the round.
    const script = [
      { a: { text: truthOf(VLAD, 0), bet: 2 }, b: { text: decoyOf(NASTYA, 0), bet: 3 }, total: [17, 8], pieces: [1, 0] },
      { a: { text: decoyOf(VLAD, 1), bet: 1 }, b: { text: truthOf(NASTYA, 1), bet: 2 }, total: [17, 13], pieces: [1, 1] },
      { a: { pass: true }, b: { text: decoyOf(NASTYA, 2), bet: 5 }, total: [22, 8], pieces: [1, 1] },
      { a: { text: truthOf(VLAD, 3), bet: 5 }, b: { text: decoyOf(NASTYA, 3), bet: 1 }, total: [33, 8], pieces: [2, 1] },
      { a: { text: decoyOf(VLAD, 4), bet: 10 }, b: { text: truthOf(NASTYA, 4), bet: 8 }, total: [24, 42], pieces: [2, 4] },
    ];
    let before = [10, 10];
    for (let i = 0; i < 5; i++) {
      const r = script[i];
      if (i === 1) await expect(a.locator('.q')).toContainText('делал ради кого-то');
      if (i === 1) await expect(b.locator('.q')).toContainText('делала ради кого-то');
      if (i === 3) await expect(a.locator('.q')).toContainText('подумал, когда впервые меня увидел');
      if (i === 3) await expect(b.locator('.q')).toContainText('подумала, когда впервые меня увидела');
      if (i === 4) {
        await expect(a.locator('.q')).toContainText('сделал, если бы');
        await expect(b.locator('.q')).toContainText('сделала, если бы');
        await a.getByRole('button', { name: 'Ва-банк' }).click();
        await expect(a.locator('.stepper output')).toHaveText('10');
        await expect(a.locator('#ctl-plus')).toBeDisabled();
      }
      await play(a, i, r.a);
      await expect(a.locator('.status')).toContainText('Ждём ставку: Влад');
      await play(b, i, r.b);

      // Sealed screen: the outcome must not show before "Вскрыть".
      await expect(a.getByRole('button', { name: `Вскрыть раунд ${i + 1}` })).toBeVisible();
      await expect(b.getByRole('button', { name: `Вскрыть раунд ${i + 1}` })).toBeVisible();
      await expect(a.locator('.sealed')).toContainText('Оба хода сделаны');
      expect(await chips(a), `round ${i + 1}: scoreboard stays at the old score on the sealed screen`).toEqual(before);
      expect(await chips(b), `round ${i + 1}: same on B`).toEqual([before[1], before[0]]);
      await expect(openPieces(a)).toHaveCount(i ? script[i - 1].pieces[0] : 0);
      await expect(openPieces(b)).toHaveCount(i ? script[i - 1].pieces[1] : 0);

      await openRound(a, i);
      await openRound(b, i);
      await expect(a.locator('.card-r.truth', { hasText: truthOf(VLAD, i) })).toContainText('правда');
      await expect(a.locator('.card-r.truth', { hasText: truthOf(NASTYA, i) })).toContainText('правда');
      if (!r.a.pass) await expect(a.locator('.card-r', { hasText: r.a.text })).toContainText('твой выбор');
      await expect(a.locator('.card-r', { hasText: r.b.text })).toContainText('его выбор');
      await expect(b.locator('.card-r', { hasText: r.b.text })).toContainText('твой выбор');
      if (!r.a.pass) await expect(b.locator('.card-r', { hasText: r.a.text })).toContainText('её выбор');

      const delta = n => (n > 0 ? `+${n}` : n < 0 ? `-${-n}` : '0');
      await expect(a.locator('.delta').first()).toHaveText(`Ты ${delta(r.total[0] - before[0])}`);
      await expect(a.locator('.delta').nth(1)).toHaveText(`Влад ${delta(r.total[1] - before[1])}`);

      if (i === 0) {
        await expect(a.locator('.res-h').first()).toHaveText('Его карты. Ты угадала.');
        await expect(a.locator('.res-h').nth(1)).toHaveText('Твои карты. Влад купился на твою ложь.');
        await expect(b.locator('.res-h').first()).toHaveText('Её карты. Ты ошибся.');
        await expect(b.locator('.res-h').nth(1)).toHaveText('Твои карты. Настя угадала.');
      }
      if (i === 1) {
        await expect(a.locator('.res-h').first()).toHaveText('Его карты. Ты ошиблась.');
        await expect(b.locator('.res-h').first()).toHaveText('Её карты. Ты угадал.');
        await expect(a.locator('.res-h').nth(1)).toHaveText('Твои карты. Влад угадал.');
        await expect(b.locator('.res-h').nth(1)).toHaveText('Твои карты. Настя купилась на твою ложь.');
      }
      if (i === 2) {
        await expect(a.locator('.res-h').first()).toHaveText('Его карты. Ты спасовала.');
        await expect(b.locator('.res-h').nth(1)).toHaveText('Твои карты. Настя спасовала.');
      }

      expect(await chips(a), `round ${i + 1} on A`).toEqual(r.total);
      expect(await chips(b), `round ${i + 1} on B`).toEqual([r.total[1], r.total[0]]);
      await expect(openPieces(a)).toHaveCount(r.pieces[0]);
      await expect(openPieces(b)).toHaveCount(r.pieces[1]);
      for (let k = 0; k < r.pieces[0]; k++) await expect(openPieces(a).nth(k)).toContainText(pieceOf(VLAD, k));
      for (let k = 0; k < r.pieces[1]; k++) await expect(openPieces(b).nth(k)).toContainText(pieceOf(NASTYA, k));

      await nextRound(a, i);
      await nextRound(b, i);
      if (i === 2) await expect(a.getByRole('button', { name: 'Пас', exact: true })).toHaveCount(0);
      if (i === 2) await expect(b.getByRole('button', { name: 'Пас', exact: true })).toBeVisible();
      before = r.total;
    }

    await expect(b.locator('.verdict')).toHaveText('Ты выигрываешь стол');
    await expect(b.locator('.table')).toContainText('Настя открывает свой секрет целиком');
    await expect(a.locator('.verdict')).toHaveText('Стол за Влад');
    await expect(a.locator('.table')).toContainText('Твой секрет открывается целиком');
    expect(a.errors.concat(b.errors)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test('tie reveals both secrets', async ({ browser }) => {
    const { A, B } = await seatTwo(browser);
    for (let i = 0; i < 5; i++) {
      await play(A.page, i, { text: decoyOf(VLAD, i), bet: 1 });
      await play(B.page, i, { text: decoyOf(NASTYA, i), bet: 1 });
      for (const [p] of [[A.page], [B.page]]) { await openRound(p, i); await nextRound(p, i); }
    }
    await expect(A.page.locator('.verdict')).toHaveText('Ничья');
    await expect(B.page.locator('.verdict')).toHaveText('Ничья');
    await expect(openPieces(A.page)).toHaveCount(4);
    await expect(openPieces(B.page)).toHaveCount(4);
    await A.ctx.close(); await B.ctx.close();
  });

  test('surrender asks first, then shows all 4 pieces', async ({ browser }) => {
    const { A, B } = await seatTwo(browser);
    await A.page.setViewportSize({ width: 360, height: 740 });
    expect.soft(await A.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'normal names fit 360px').toBe(true);
    await A.page.getByRole('button', { name: 'Сдаться и открыть секрет' }).click();
    await A.page.getByRole('button', { name: 'Отмена' }).click();
    await expect(openPieces(B.page)).toHaveCount(0);
    await A.page.getByRole('button', { name: 'Сдаться и открыть секрет' }).click();
    await expect(A.page.locator('.note[role=alert]')).toContainText('Влад сразу увидит секрет целиком');
    await A.page.getByRole('button', { name: 'Открыть всё' }).click();
    await expect(openPieces(B.page)).toHaveCount(4);
    await expect(openPieces(B.page).nth(3)).toContainText(pieceOf(NASTYA, 3));
    await A.ctx.close(); await B.ctx.close();
  });
});

test.describe('4.4 resilience', () => {
  test('reload, lost vault, offline player, network drop', async ({ browser }) => {
    const { A, B } = await seatTwo(browser);
    await play(A.page, 0, { text: truthOf(VLAD, 0), bet: 2 });
    await play(B.page, 0, { text: decoyOf(NASTYA, 0), bet: 3 });
    for (const p of [A.page, B.page]) { await openRound(p, 0); await nextRound(p, 0); }

    await A.page.reload();
    await expect(A.page.locator('#rtag')).toHaveText('Раунд 2/5');
    expect(await chips(A.page)).toEqual([17, 8]);

    // Same account on a device without the vault.
    const state = await A.ctx.storageState();
    state.origins.forEach(o => { o.localStorage = o.localStorage.filter(x => !x.name.startsWith('ssz-vault-')); });
    const noVault = await newContext(browser, { storageState: state });
    await noVault.page.goto(A.page.url());
    await expect(noVault.page.locator('h1')).toHaveText('Тайник не найден');
    await noVault.ctx.close();

    // A really new browser is a new anonymous user, so it gets the setup form.
    const fresh = await newContext(browser);
    await fresh.page.goto(A.page.url());
    await expect(fresh.page.locator('form#setup')).toBeVisible();
    expect(fresh.page.errors).toEqual([]);
    await fresh.ctx.close();

    // A plays and leaves, so A's truth for this round stays unpublished.
    await play(A.page, 1, { text: decoyOf(VLAD, 1), bet: 1 });
    await expect(A.page.locator('.status')).toContainText('Ждём ставку'); // the move is saved
    const gameUrl = A.page.url();
    await A.page.close();
    await play(B.page, 1, { text: truthOf(NASTYA, 1), bet: 2 });
    await expect(B.page.locator('.status')).toContainText('Ждём вскрытия');
    const a2 = await A.ctx.newPage();
    await a2.goto(gameUrl);
    await expect(a2.getByRole('button', { name: 'Вскрыть раунд 2' })).toBeVisible();
    await expect(B.page.getByRole('button', { name: 'Вскрыть раунд 2' })).toBeVisible();
    for (const p of [a2, B.page]) { await openRound(p, 1); await nextRound(p, 1); }

    // Network drop while locking a move.
    await a2.locator('.opt[role=radio]', { hasText: truthOf(VLAD, 2) }).click();
    await A.ctx.setOffline(true);
    await a2.getByRole('button', { name: /^Иду на/ }).click();
    await expect(a2.locator('.err')).toContainText('Ход не сохранился');
    await A.ctx.setOffline(false);
    await a2.getByRole('button', { name: /^Иду на/ }).click();
    await expect(a2.locator('.status')).toContainText('Ждём ставку');
    await play(B.page, 2, { text: decoyOf(NASTYA, 2), bet: 1 });
    await expect(a2.getByRole('button', { name: 'Вскрыть раунд 3' })).toBeVisible();
    await expect(B.page.getByRole('button', { name: 'Вскрыть раунд 3' })).toBeVisible();
    const [x, y] = await chips(a2);
    expect(await chips(B.page)).toEqual([y, x]);
    await A.ctx.close(); await B.ctx.close();
  });
});

test.describe('4.5 security', () => {
  test('RLS with raw client calls', async () => {
    const [a, b, c] = [await anon(), await anon(), await anon()];
    const gid = rawGameId();
    logGame(gid);
    const players = x => x.c.from('ssz_players');
    expect((await players(a).insert({ game_id: gid, uid: a.uid, data: row({ name: 'A' }) })).error).toBeNull();
    expect((await players(b).insert({ game_id: gid, uid: b.uid, data: row({ name: 'B' }) })).error).toBeNull();

    const sel = await players(c).select('*').eq('game_id', gid);
    expect(sel.data).toEqual([]);

    const upd = await players(c).update({ data: row({ name: 'hacked' }) }).eq('game_id', gid).eq('uid', b.uid).select();
    expect(upd.data || []).toEqual([]);
    const upd2 = await players(a).update({ data: row({ name: 'hacked' }) }).eq('game_id', gid).eq('uid', b.uid).select();
    expect(upd2.data || []).toEqual([]);
    const after = await players(b).select('data').eq('game_id', gid).eq('uid', b.uid).single();
    expect(after.data.data.name).toBe('B');

    const other = rawGameId();
    logGame(other);
    expect((await players(c).insert({ game_id: other, uid: b.uid, data: row() })).error).not.toBeNull();
    expect((await players(c).insert({ game_id: gid, uid: c.uid, data: row() })).error).not.toBeNull();

    const del = await players(a).delete().eq('game_id', gid).eq('uid', a.uid).select();
    expect(del.data || []).toEqual([]);
    expect((await players(a).select('uid').eq('game_id', gid)).data).toHaveLength(2);

    const big = rawGameId();
    logGame(big);
    const huge = row({ pad: 'x'.repeat(70000) });
    expect((await players(c).insert({ game_id: big, uid: c.uid, data: huge })).error).not.toBeNull();
  });

  test('a seated player cannot read the opponent move before playing', async () => {
    const [a, b] = [await anon(), await anon()];
    const gid = rawGameId();
    logGame(gid);
    await a.c.from('ssz_players').insert({ game_id: gid, uid: a.uid, data: row({ name: 'A' }) });
    await b.c.from('ssz_players').insert({ game_id: gid, uid: b.uid, data: row({ name: 'B' }) });
    await a.c.from('ssz_players').update({ data: row({ name: 'A', picks: { 0: { idx: 1, bet: 2 } } }) }).eq('game_id', gid).eq('uid', a.uid);
    const seen = await b.c.from('ssz_players').select('data').eq('game_id', gid).eq('uid', a.uid).single();
    expect.soft(seen.data.data.truth, 'true index is hidden').toEqual({});
    expect.soft(seen.data.data.picks, 'pick is hidden').toEqual({});
  });

  test('repo and page hold no key other than the anon key', async ({ request }) => {
    const served = await (await request.get('/')).text();
    expect(served).toBe(html);
    const tokens = html.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g);
    expect(tokens).toHaveLength(1);
    const claims = JSON.parse(Buffer.from(tokens[0].split('.')[1], 'base64url').toString());
    expect(claims.role).toBe('anon');
    expect(html).not.toMatch(/service_role|sb_secret_/);
  });
});

test.describe('4.6 UX and accessibility', () => {
  const long = n => 'длинный ответ '.repeat(30).slice(0, 320) + n;
  const LONG_A = { ...NASTYA, name: 'Н'.repeat(30), label: 'с'.repeat(30), truth: i => `А${i} ${long('п')}`, decoy: i => `А${i} ${long('л')}` };
  const LONG_B = { ...VLAD, name: 'В'.repeat(30), label: 'т'.repeat(30), truth: i => `Б${i} ${long('п')}`, decoy: i => `Б${i} ${long('л')}` };

  const noScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const contrastFails = page => page.evaluate(() => {
    const parse = c => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const bgOf = el => { for (; el; el = el.parentElement) { const c = parse(getComputedStyle(el).backgroundColor); if (c.a === 1) return c; } return { r: 255, g: 255, b: 255 }; };
    const bad = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const el = walk.currentNode.parentElement;
      if (!walk.currentNode.textContent.trim() || ['SCRIPT', 'STYLE'].includes(el.tagName) || el.closest('.sr,.skip')) continue;
      const st = getComputedStyle(el), fg = parse(st.color);
      if (fg.a === 0) continue;
      const [x, y] = [lum(fg), lum(bgOf(el))].sort((p, q) => q - p);
      const ratio = (x + .05) / (y + .05);
      if (ratio < 4.5) bad.push(`${ratio.toFixed(2)} ${el.className || el.tagName}: ${walk.currentNode.textContent.trim().slice(0, 30)}`);
    }
    return bad;
  });
  const dashes = page => page.evaluate(() => (document.body.innerText.match(/[—–]/g) || []).length);

  test('360px, long text, contrast, focus, no em dashes', async ({ browser }) => {
    const { A, B } = await seatTwo(browser, LONG_A, LONG_B);
    await A.page.setViewportSize({ width: 360, height: 740 });
    await expect(A.page.locator('.opt[role=radio]')).toHaveCount(3);
    expect.soft(await noScroll(A.page), 'round screen fits 360px').toBe(true);
    expect.soft(await contrastFails(A.page), 'round screen contrast').toEqual([]);
    expect.soft(await dashes(A.page)).toBe(0);

    await A.page.locator('.opt[role=radio]').first().click();
    await A.page.getByRole('button', { name: 'Ва-банк' }).click();
    expect.soft(await noScroll(A.page), 'locked-in button fits 360px').toBe(true);

    // Options are keyboard reachable and show a focus ring.
    await A.page.locator('.opt[role=radio]').first().focus();
    await A.page.keyboard.press('Tab');
    const ring = await A.page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [document.activeElement.getAttribute('role'), s.outlineStyle, s.outlineWidth]; });
    expect.soft(ring).toEqual(['radio', 'solid', '3px']);

    await A.page.getByRole('button', { name: /^Иду на/ }).click();
    await B.page.locator('.opt[role=radio]').first().click();
    await B.page.getByRole('button', { name: /^Иду на/ }).click();
    await openRound(A.page, 0);
    expect.soft(await noScroll(A.page), 'reveal fits 360px').toBe(true);
    expect.soft(await contrastFails(A.page), 'reveal contrast').toEqual([]);
    expect.soft(await dashes(A.page)).toBe(0);
    await A.ctx.close(); await B.ctx.close();
  });

  test('waiting screen with a long name fits 360px', async ({ browser }) => {
    const { ctx, page } = await newContext(browser, { viewport: { width: 360, height: 740 } });
    await createGame(page);
    expect.soft(await noScroll(page), 'setup fits 360px').toBe(true);
    expect.soft(await contrastFails(page), 'setup contrast').toEqual([]);
    expect.soft(await dashes(page)).toBe(0);
    await fillSetup(page, LONG_A);
    await submit(page);
    await expect(page.locator('h1')).toContainText('Ставки сделаны');
    expect.soft(await noScroll(page), 'waiting screen fits 360px').toBe(true);
    await ctx.close();
  });

  test('reduced motion turns off animation and tilt', async ({ browser }) => {
    const { A, B } = await seatTwo(browser, NASTYA, VLAD, { reducedMotion: 'reduce' });
    const b = B.page;
    await expect(b.locator('.table')).toHaveCSS('transform', 'none');
    await expect(b.locator('.table')).toHaveCSS('animation-name', 'none');
    await expect(b.locator('.opt').first()).toHaveCSS('transform', 'none');
    await b.locator('#ctl-plus').click();
    expect.soft(await b.locator('.stepper output').evaluate(e => getComputedStyle(e).animationName), 'bet number').toBe('none');
    await A.ctx.close(); await B.ctx.close();
  });
});
