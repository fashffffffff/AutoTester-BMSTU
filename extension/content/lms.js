// AutoTester — content script для страниц тестов LMS.
// Решает попытку только после ручного запуска (кнопка «Решить» или Alt+S).

(() => {
  'use strict';

  const PAGE = location.pathname;
  const BG = (msg) => chrome.runtime.sendMessage(msg);
  const log = (msg, level = 'info') => BG({ type: 'log', msg, level });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // таймеры через Web Worker: в скрытом/свёрнутом окне Chrome тормозит
  // setTimeout самой вкладки (до 1 раза в минуту), а тики воркера не троттлятся.
  // Все sleep() идут через него, если воркер создался
  let __ticker = null;
  const __sleeps = new Map();
  let __sleepSeq = 0;
  try {
    // воркер из файлов расширения: CSP страницы blob: не пускает, а свой — можно
    __ticker = new Worker(chrome.runtime.getURL('worker.js'));
    __ticker.onmessage = () => {
      const now = Date.now();
      for (const [id, s] of __sleeps) {
        if (now >= s.at) { __sleeps.delete(id); s.resolve(); }
      }
    };
  } catch (e) { /* воркер недоступен — останется обычный setTimeout */ }

  const wsleep = (ms) => {
    if (!__ticker) return sleep(ms);
    return new Promise((resolve) => {
      __sleeps.set(++__sleepSeq, { at: Date.now() + ms, resolve });
      setTimeout(resolve, ms + 5000); // страховка, если воркер умрёт
    });
  };

  // джиттер без Math.random
  const jitterMs = (base, spread) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return base + (buf[0] / 4294967296) * spread;
  };

  async function getSettings() {
    const r = await BG({ type: 'settings.get' });
    return (r && r.settings) || {};
  }

  // ---------- оверлей-статус ----------

  let overlay = null;
  let stopped = false;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'at-overlay';
    overlay.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:#1e273c', 'color:#ecf0f5', 'padding:10px 14px', 'border-radius:10px',
      'font:13px/1.4 -apple-system,Segoe UI,sans-serif', 'box-shadow:0 4px 18px rgba(0,0,0,.4)',
      'max-width:320px', 'display:none',
    ].join(';');
    const text = document.createElement('div');
    text.id = 'at-overlay-text';
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Стоп';
    stopBtn.style.cssText = 'margin-top:6px;background:#e74c3c;border:0;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px';
    stopBtn.addEventListener('click', () => { stopped = true; setStatus('Остановлено пользователем', 'error'); });
    overlay.append(text, stopBtn);
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function setStatus(text, kind = 'info') {
    ensureOverlay();
    overlay.style.display = 'block';
    const t = overlay.querySelector('#at-overlay-text');
    t.textContent = text;
    overlay.style.background = kind === 'error' ? '#7c1f1f' : kind === 'ok' ? '#1d5c34' : '#1e273c';
  }

  async function hideOverlayLater() {
    await sleep(4000);
    if (overlay) overlay.style.display = 'none';
  }

  // ---------- утилиты DOM ----------

  function waitFor(selector, timeoutMs = 15000, root = document) {
    return new Promise((resolve) => {
      const el = root.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const el2 = root.querySelector(selector);
        if (el2) { obs.disconnect(); clearTimeout(timer); resolve(el2); }
      });
      obs.observe(root, { childList: true, subtree: true });
      const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function findByText(selectors, re, root = document) {
    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        if (re.test((el.textContent || '').trim()) && !el.disabled) return el;
      }
    }
    return null;
  }

  function clickEl(el) {
    el.scrollIntoView({ block: 'center' });
    return wsleep(jitterMs(120, 250)).then(() => el.click());
  }

  // ---------- стартовая страница квиза ----------

  async function startQuiz() {
    await BG({ type: 'patchDialogs' });
    const startBtn =
      document.querySelector('button.quizstartbutton') ||
      document.querySelector('form[action*="startattempt.php"] button[type="submit"], form[action*="startattempt.php"] input[type="submit"]') ||
      findByText(['button', 'a.btn'], /начать попытку|пройти тест|start attempt/i) ||
      [...document.querySelectorAll('input[type="submit"]')].find((i) => /начать попытку|пройти тест|start attempt/i.test(i.value || ''));
    if (!startBtn) {
      // может, попытка уже начата?
      const cont =
        document.querySelector('a[href*="/mod/quiz/attempt.php"]') ||
        [...document.querySelectorAll('form[action*="attempt.php"] input[type="submit"], form[action*="attempt.php"] button[type="submit"]')]
          .find((b) => /продолжить|continue/i.test((b.value || '') + ' ' + (b.textContent || ''))) ||
        findByText(['button', 'a'], /продолжить попытку|continue attempt/i);
      if (cont) {
        setStatus('Продолжаю начатую попытку…');
        await log('Квиз: продолжаю попытку');
        await wsleep(jitterMs(800, 800));
        await clickEl(cont);
        return;
      }
      await log('Квиз: не нашёл кнопку старта — нужен HTML страницы view.php', 'warn');
      setStatus('Не нашёл кнопку старта попытки', 'error');
      return;
    }

    setStatus('Начинаю попытку…');
    await log(`Квиз: нажимаю «${(startBtn.textContent || startBtn.value || 'старт').trim().slice(0, 40)}»`);
    // фиксируем попытку в состоянии: страницы попытки продолжат решение сами
    const cmid = (location.search.match(/id=(\d+)/) || [])[1] || '0';
    await BG({ type: 'solveState.set', state: { active: true, cmid, ts: Date.now() } });
    await wsleep(jitterMs(1500, 1500));
    await clickEl(startBtn);

    // Moodle с таймером показывает модалку подтверждения. Тема может как
    // угодно называть её классы, поэтому ищем ЛЮБУЮ видимую кнопку
    // «Начать попытку», кроме той, что уже нажали
    const t0 = Date.now();
    let confirmClicks = 0;
    while (Date.now() - t0 < 12000) {
      await wsleep(500);
      if (!/^\/mod\/quiz\/view\.php/.test(PAGE)) break; // уже перешли на попытку
      const confirmBtn = [...document.querySelectorAll('button, [role="button"], a.btn, input[type="submit"]')]
        .find((b) => {
          if (b === startBtn || b.disabled || b.offsetParent === null) return false;
          const t = ((b.textContent || '') + ' ' + (b.value || '')).trim();
          return /начать попытку|пройти тест|start attempt/i.test(t);
        });
      if (confirmBtn && confirmClicks < 2) {
        confirmClicks++;
        await log(`Квиз: подтверждаю старт в модалке (клик ${confirmClicks})`);
        await clickEl(confirmBtn);
      }
    }
  }

  // ---------- извлечение вопросов ----------

  // текст варианта из контейнера: предпочитаем .flex-fill (без номера-буквы),
  // иначе весь текст контейнера минус answernumber
  function optionText(container) {
    if (!container) return '';
    const flex = container.querySelector('.flex-fill');
    if (flex) return flex.textContent;
    const clone = container.cloneNode(true);
    clone.querySelectorAll('.answernumber').forEach((n) => n.remove());
    return clone.textContent;
  }

  function extractQuestions() {
    const form = document.querySelector('#responseform') || document.querySelector('form[action*="attempt.php"]');
    if (!form) return { form: null, questions: [] };
    const questions = [...form.querySelectorAll('.que')].map((q) => {
      const isMulti = q.querySelector('.answer input[type="checkbox"]') !== null;
      const isRadio = q.querySelector('.answer input[type="radio"]') !== null;
      const inputs = [...q.querySelectorAll('.answer input[type="radio"], .answer input[type="checkbox"]')];
      const options = inputs.map((inp) => {
        let text = '';
        let container = null;
        // Moodle 4.5+ (Bootstrap): текст связан через aria-labelledby — это НЕ <label>,
        // и id содержит двоеточие, поэтому только getElementById
        const labelledby = inp.getAttribute('aria-labelledby');
        if (labelledby) {
          container = document.getElementById(labelledby);
          text = optionText(container);
        }
        if (!text.trim()) {
          // классический Moodle: <label> вокруг инпута или label[for]
          container = inp.closest('label') || document.querySelector(`label[for="${inp.id}"]`);
          if (container) text = optionText(container);
        }
        if (!text.trim()) {
          // последний рубеж: текст строки-родителя минус номер и инпуты
          container = inp.closest('div') || inp.parentElement;
          text = optionText(container);
        }
        text = text.trim().replace(/\s+/g, ' ');
        const row = inp.closest('div') || inp.parentElement;
        const isImg = !text && !!(container?.querySelector('img') || row?.querySelector('img'));
        if (isImg) text = '[вариант-картинка]';
        return { input: inp, text, isImg };
      });
      const qtextEl = q.querySelector('.qtext');
      const qtext = qtextEl ? qtextEl.innerText.trim() : (q.querySelector('.content')?.innerText || '').trim();
      const hasMedia = !!q.querySelector('.qtext img, .answer img, .qtext canvas') || options.some((o) => o.isImg);
      const answered = inputs.some((i) => i.checked);
      const qno = parseInt((q.querySelector('.qno')?.textContent || '').trim(), 10) || 0;
      return { el: q, qno, qtext, options, isMulti, isRadio, hasMedia, answered };
    });
    return { form, questions };
  }

  // ---------- промпт и разбор ответа ----------

  const LETTERS = {
    'а': 1, 'б': 2, 'в': 3, 'г': 4, 'д': 5, 'е': 6,   // кириллица
    'a': 1, 'b': 2, 'c': 3, 'd': 4, 'e': 5,            // латиница (буквы на странице)
  };

  function buildPrompt(q, screenshotMode) {
    if (screenshotMode) {
      // тексты вариантов не вытащились из DOM — просим прочитать их с картинки
      return [
        'К сообщению приложен скриншот страницы теста. На нём виден вопрос и варианты ответов (чекбоксы/радиокнопки).',
        `Мысленно пронумеруй варианты сверху вниз от 1 до ${q.options.length} (буквы a, b, c на странице — НЕ нумерация, отвечай цифрами).`,
        'Ответь СТРОГО одной строкой: только номера правильных вариантов через запятую (например: 2 или 1,3). Без пояснений и слов, только цифры.',
      ].join('\n');
    }
    const lines = q.options.map((o, i) => `${i + 1}) ${o.text}`);
    return [
      'Тебе дан вопрос теста. Ответь максимально точно.',
      '',
      'Вопрос:',
      q.qtext,
      '',
      'Варианты:',
      ...lines,
      '',
      'Ответь СТРОГО одной строкой: только номера правильных вариантов через запятую (например: 2 или 1,3). Никаких пояснений и слов, только цифры.',
    ].join('\n');
  }

  function toIndices(tokens, optionCount, isMulti) {
    const nums = tokens.map((t) => parseInt(t, 10)).filter((n) => !isNaN(n) && n >= 1 && n <= optionCount);
    const uniq = [...new Set(nums)];
    // одиночный выбор: первый номер, остальное считаем шумом
    return isMulti ? uniq : uniq.slice(0, 1);
  }

  // ДипСик иногда отвечает текстом варианта («do-while и while») — ищем их в ответе
  function matchByText(text, q) {
    const t = String(text).toLowerCase();
    const hits = [];
    q.options.forEach((o, i) => {
      const ot = (o.text || '').toLowerCase().trim();
      if (ot.length >= 4 && t.includes(ot)) hits.push(i + 1);
    });
    return q.isMulti ? hits : hits.slice(0, 1);
  }

  function parseAnswer(text, optionCount, isMulti) {
    const lines = String(text).trim().split('\n');
    // 1) последняя строка, состоящая только из номеров: «2», «1, 3»
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].trim().match(/^([0-9]+(?:\s*[,;]\s*[0-9]+)*)\.?\s*$/);
      if (m) return toIndices(m[1].split(/\s*[,;]\s*/), optionCount, isMulti);
      // 2) строка из букв (a, b / б, в) — страница нумерует варианты буквами
      const l = lines[i].trim().match(/^([a-zа-д])(?:\s*[,;]\s*([a-zа-д]))?\.?\s*$/i);
      if (l) {
        return toIndices(
          l.slice(1).filter(Boolean).map((ch) => String(LETTERS[ch.toLowerCase()])),
          optionCount, isMulti,
        );
      }
    }
    // 3) список номеров после слова «ответ/вариант» — включая «Ответы: 2 и 4»
    const m2 = String(text).match(/(?:ответ\w*|answer|вариант\w*)[^0-9]{0,20}([0-9]+(?:\s*(?:,|;|и|and)\s*[0-9]+)*)/i);
    if (m2) return toIndices(m2[1].split(/\s*(?:,|;|и|and)\s*/), optionCount, isMulti);
    // голые числа из середины текста не доверяем: лучше переспросить или пропустить,
    // чем кликнуть вариант, «угаданный» из сложности O(n^2)
    return [];
  }

  async function capturePage() {
    await BG({ type: 'activateTab' }); // captureVisibleTab снимает только активную вкладку
    await wsleep(400);
    const r = await BG({ type: 'captureVisibleTab' });
    return r && r.ok ? r.dataUrl : null;
  }

  async function askDeepSeek(q, screenshot, attemptNo, screenshotMode) {
    let prompt = buildPrompt(q, screenshotMode);
    if (attemptNo > 1) {
      prompt += '\n\n(Предыдущий ответ не удалось разобрать. Отвечай ТОЛЬКО цифрами — номерами вариантов, без слов.)';
    }
    if (attemptNo > 2) {
      prompt += '\n(Это последняя попытка. Обязательно выбери самый вероятный вариант и ответь только его номером. Не отказывайся и не проси уточнений.)';
    }
    const r = await BG({ type: 'askDeepSeek', prompt, screenshot: screenshot || null });
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'нет ответа от DeepSeek');
    return r.text;
  }

  // ---------- решатель попытки ----------

  let solvingNow = false;

  async function solveAttemptPage(settings) {
    if (solvingNow) return;
    solvingNow = true;
    try {
      stopped = false;
      const { form, questions } = extractQuestions();
      if (!form || questions.length === 0) {
        setStatus('Не нашёл вопросов на странице — нужен HTML этой страницы для калибровки', 'error');
        await log('Решатель: не нашёл вопросов на attempt-странице', 'warn');
        return;
      }

      await BG({ type: 'patchDialogs' });
      const cmid = (location.search.match(/cmid=(\d+)/) || [])[1] || '0';
      const prevState = (await BG({ type: 'solveState.get' })).state;
      // ts попытки фиксируется на первой странице: по нему background понимает,
      // что началась НОВАЯ попытка, и заводит свежий чат DeepSeek
      await BG({ type: 'solveState.set', state: { active: true, cmid, ts: (prevState && prevState.ts) || Date.now() } });
      await BG({ type: 'badge', text: '…' });

      const totalQ = document.querySelectorAll('.qnbutton').length;
      const pageNeedsShot = questions.some((q) => q.hasMedia || !q.qtext || q.options.every((o) => !o.text));
      const screenshot = pageNeedsShot ? await capturePage() : null;

      let solved = 0, skipped = 0;
      let lastReason = '';
      for (let i = 0; i < questions.length; i++) {
        if (stopped) return;
        const q = questions[i];
        const label = `Вопрос ${q.qno || i + 1}${totalQ ? ` из ${totalQ}` : ''}`;
        if (q.answered) { await log(`${label}: уже отвечен, пропускаю`); continue; }
        if (!q.isRadio && !q.isMulti) {
          skipped++;
          lastReason = 'тип вопроса не радиокнопки/чекбоксы (ввод текста, сопоставление)';
          await log(`${label}: ${lastReason} — пропускаю`, 'warn');
          continue;
        }
        if (q.options.length === 0) {
          skipped++;
          lastReason = 'варианты не найдены в DOM';
          await log(`${label}: ${lastReason} — нужен HTML страницы`, 'warn');
          continue;
        }
        if (!q.qtext && !screenshot) {
          skipped++;
          lastReason = 'не вытащен текст вопроса и нет скриншота';
          await log(`${label}: ${lastReason}`, 'warn');
          continue;
        }
        // если тексты вариантов пусты — ДипСик прочитает их со скриншота
        const textsMissing = q.options.every((o) => !o.text);

        setStatus(`${label}: спрашиваю DeepSeek…`);
        let answer = null;
        try {
          const raw1 = await askDeepSeek(q, screenshot, 1, textsMissing);
          let parsed = parseAnswer(raw1, q.options.length, q.isMulti);
          if (parsed.length === 0) parsed = matchByText(raw1, q);
          if (parsed.length === 0) {
            const raw2 = await askDeepSeek(q, screenshot, 2, textsMissing);
            parsed = parseAnswer(raw2, q.options.length, q.isMulti);
            if (parsed.length === 0) parsed = matchByText(raw2, q);
          }
          if (parsed.length === 0) {
            // третий заход: заставляем выбрать наиболее вероятный вариант
            const raw3 = await askDeepSeek(q, screenshot, 3, textsMissing);
            parsed = parseAnswer(raw3, q.options.length, q.isMulti);
            if (parsed.length === 0) parsed = matchByText(raw3, q);
          }
          if (parsed.length === 0) throw new Error(`непонятный ответ: ${String(raw1).slice(0, 80)}`);
          answer = parsed;
        } catch (e) {
          lastReason = `DeepSeek: ${e.message}`;
          await log(`${label}: ${lastReason}`, 'error');
          if (settings.strictMode) {
            setStatus(`${label}: ошибка — стоп (строгий режим)`, 'error');
            await BG({ type: 'notify', title: 'AutoTester — стоп', message: `${label}: ${e.message}` });
            await BG({ type: 'solveState.set', state: null });
            return;
          }
          skipped++;
          continue;
        }

        setStatus(`${label}: отвечаю (вариант ${answer.join(', ')})`);
        for (const n of answer) {
          if (stopped) return;
          await clickEl(q.options[n - 1].input);
        }
        solved++;
        await log(`${label}: выбран ${answer.join(', ')} — ${q.qtext.slice(0, 60)}`);
        // пауза нужна только когда на странице несколько вопросов; при переходе
        // на следующую страницу естественную паузу даёт сама загрузка
        await wsleep(jitterMs(questions.length > 1 ? 1000 : 300, questions.length > 1 ? 1500 : 400));
      }

      await BG({ type: 'badge', text: `${solved}` });

      // гвардия: ни одного осмысленного ответа — останавливаемся и НЕ жжём попытку
      if (solved === 0 && skipped > 0) {
        setStatus(`Ни один вопрос не решён — стоп. Причина: ${lastReason || 'неизвестна'}`, 'error');
        await log(`Решатель: все ${skipped} вопросов пропущены — стоп без навигации. Причина: ${lastReason}`, 'error');
        await BG({ type: 'notify', title: 'AutoTester — стоп', message: `Ни один вопрос не решён. Причина: ${lastReason}. Попытка НЕ сдана.` });
        await BG({ type: 'solveState.set', state: null });
        return;
      }

      setStatus(`Заполнено ${solved}, пропущено ${skipped}. Ищу кнопку «Далее»…`);
      if (skipped > 0) {
        await BG({ type: 'notify', title: 'AutoTester', message: `Вопросов пропущено: ${skipped}. Автосабмит для этой попытки отключён.` });
      }

      if (stopped) return;

      // свежее чтение: за время решения ts попытки уже зафиксирован стартовым блоком
      const freshState = (await BG({ type: 'solveState.get' })).state;
      const prevSkipped = (freshState && freshState.skipped) || 0;
      await BG({ type: 'solveState.set', state: { active: true, cmid, ts: (freshState && freshState.ts) || Date.now(), skipped: prevSkipped + skipped } });

      // навигация к следующей странице (в Moodle это input[name="next"])
      const next =
        form.querySelector('input[name="next"], button[name="next"]') ||
        document.querySelector('a.mod-quiz-next-nav') ||
        findByText(['button[type="submit"]', 'a.btn'], /далее|следующая|next page|закончить попытку|^next$/i, form) ||
        [...form.querySelectorAll('input[type="submit"]')].find((i) => /далее|следующ|закончить|next/i.test(i.value || '')) ||
        form.querySelector('button[type="submit"]');
      if (next) {
        await log('Нажимаю «Далее», жду следующую страницу');
        await clickEl(next);
        // страница перезагрузится; дальше вступит авто-продолжение при загрузке
      } else {
        await log('Кнопка «Далее» не найдена — нужен HTML страницы', 'warn');
        setStatus('Кнопка «Далее» не найдена. Жми сам и снова Alt+S', 'error');
      }
    } finally {
      solvingNow = false;
    }
  }

  // ---------- summary / confirm / review ----------

  async function handleSummary(settings) {
    setStatus('Страница предпросмотра.');
    const r = await BG({ type: 'solveState.get' });
    const st = r && r.state;
    const skipped = (st && st.skipped) || 0;

    if (!settings.autoSubmit || skipped > 0) {
      const why = !settings.autoSubmit ? 'автосабмит выключен' : `пропущено вопросов: ${skipped}`;
      setStatus(`Заполнено. Финальный сабмит — за тобой (${why}).`, 'ok');
      await log(`Summary: не сабмичу — ${why}`);
      await BG({ type: 'notify', title: 'AutoTester', message: `Тест заполнен, проверь и сдай вручную (${why}).` });
      await BG({ type: 'solveState.set', state: st ? { ...st, finished: true, ts: Date.now() } : null });
      return;
    }

    await BG({ type: 'patchDialogs' });
    // порядок: стабильные атрибуты Moodle → форма processattempt → текст последним
    const submit =
      document.querySelector('input[name="finishattempt"], button[name="finishattempt"]') ||
      document.querySelector('form[action*="processattempt.php"] button[type="submit"], form[action*="processattempt.php"] input[type="submit"]') ||
      findByText(['button[type="submit"]', 'input[type="submit"]', 'a.btn', 'a'], /завершить все|завершить попытку|сдать все|submit all/i);
    if (submit) {
      await log('Summary: жму финальную кнопку сдачи');
      await clickEl(submit);
      // дальше — отдельная страница подтверждения, её подхватит main() при перезагрузке
    } else {
      await log('Summary: не нашёл кнопку сдачи', 'warn');
      setStatus('Не нашёл кнопку завершения — сдай вручную', 'error');
    }
    await BG({ type: 'solveState.set', state: st ? { ...st, finished: true, ts: Date.now() } : null });
  }

  async function handleConfirmPage(settings) {
    const btn = document.querySelector('form#frm-confirm button[type="submit"], form#frm-confirm input[type="submit"]');
    if (settings.autoSubmit && btn) {
      await BG({ type: 'patchDialogs' });
      await log('Confirm: подтверждаю завершение попытки');
      await wsleep(jitterMs(800, 800));
      await clickEl(btn);
    } else {
      setStatus('Подтверди завершение попытки руками (автосабмит выключен).', 'ok');
      await log('Confirm: автосабмит выключен, жду человека');
    }
  }

  async function handleReview() {
    await BG({ type: 'solveState.set', state: null });
    await BG({ type: 'badge', text: 'OK' });
    setStatus('Попытка завершена ✔', 'ok');
    await log('Review: попытка завершена');
    await BG({ type: 'notify', title: 'AutoTester', message: 'Попытка завершена и сдана.' });
    hideOverlayLater();
  }

  // ---------- точка входа ----------

  async function main() {
    const settings = await getSettings();

    // страница подтверждения завершения попытки — DOM-признак надёжнее URL
    if (document.querySelector('form#frm-confirm')) {
      await handleConfirmPage(settings);
      return;
    }

    if (/^\/mod\/quiz\/attempt\.php/.test(PAGE)) {
      const r = await BG({ type: 'solveState.get' });
      const active = r && r.state && r.state.active;
      if (active) {
        // продолжаем начатое вручную решение на следующих страницах
        await solveAttemptPage(settings);
      } else {
        setStatus('Тест открыт. Нажми «Решить» в попапе или Alt+S.', 'info');
        hideOverlayLater();
      }
      return;
    }

    if (/^\/mod\/quiz\/summary\.php/.test(PAGE)) {
      await handleSummary(settings);
      return;
    }

    if (/^\/mod\/quiz\/review\.php/.test(PAGE)) {
      await handleReview();
      return;
    }
  }

  // ручной запуск (Alt+S / кнопка попапа) и сохранение HTML (Alt+Shift+S)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'savePage') {
      try {
        // снимок живого DOM: браузер сам скачает файл, никакого правого клика
        // и буфера обмена не нужно
        const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        const blob = new Blob([html], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `autotester-${location.hostname}${location.pathname.replace(/\//g, '_')}-${Date.now()}.html`;
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        log('HTML страницы сохранён в загрузки');
      } catch (e) {
        log('Не смог сохранить HTML: ' + e.message, 'error');
      }
      return;
    }
    if (msg && msg.type === 'solveNow') {
      log('Ручной запуск решения');
      getSettings().then((s) => {
        if (/^\/mod\/quiz\/view\.php/.test(PAGE)) startQuiz();
        else if (/^\/mod\/quiz\/attempt\.php/.test(PAGE)) solveAttemptPage(s);
        else setStatus('Открой страницу теста, затем нажми «Решить»', 'error');
      });
    }
  });

  main();
})();
