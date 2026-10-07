// AutoTester BMSTU — content script для chat.deepseek.com.
// Драйвер чата: вставить вопрос (+скриншот), отправить, дождаться полного ответа.

(() => {
  'use strict';

  const BG = (msg) => chrome.runtime.sendMessage(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // таймеры через Web Worker: вкладка чата обычно фоновая, и Chrome тормозит
  // её setTimeout — тики воркера не троттлятся
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

  function waitFor(selector, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const el2 = document.querySelector(selector);
        if (el2) { obs.disconnect(); clearTimeout(timer); resolve(el2); }
      });
      obs.observe(document, { childList: true, subtree: true });
      const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function findInput() {
    return document.querySelector('textarea#chat-input') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]');
  }

  async function setInputText(input, text) {
    input.focus();
    if (input.tagName === 'TEXTAREA') {
      const proto = Object.getPrototypeOf(input);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    }
    await sleep(300);
  }

  function dataUrlToFile(dataUrl, name) {
    const [head, b64] = dataUrl.split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  function inputPreviews(input) {
    // превью картинок в зоне ввода — считаем до/после paste, чтобы не спутать
    // с картинками из истории сообщений
    const zone = input.closest('div') || input.parentElement || document;
    return zone.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
  }

  async function attachScreenshot(input, dataUrl) {
    const file = dataUrlToFile(dataUrl, 'question.png');
    const before = inputPreviews(input);
    // вариант 1: эмулируем вставку из буфера
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      input.dispatchEvent(ev);
      await sleep(1500);
      if (inputPreviews(input) > before) return true;
    } catch (e) { /* пробуем файловый инпут */ }
    // вариант 2: прямой file input
    try {
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);
        if (inputPreviews(input) > before) return true;
      }
    } catch (e) { /* нет */ }
    return false;
  }

  function findSendButton(input) {
    const scope = input.closest('form') || input.closest('div[class*="input"]') || document;
    const candidates = scope.querySelectorAll('button, div[role="button"], [class*="send"]');
    for (const el of candidates) {
      const cls = (el.className && String(el.className)) || '';
      const label = (el.getAttribute('aria-label') || '') + ' ' + cls;
      if (/send|отправ/i.test(label) && !el.disabled) return el;
    }
    const submit = scope.querySelector('button[type="submit"]');
    return submit && !submit.disabled ? submit : null;
  }

  function send(input, btn) {
    if (btn) { btn.click(); return true; }
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    input.dispatchEvent(ev);
    return false;
  }

  function isGenerating() {
    // индикаторы генерации: кнопка «стоп», спиннеры; элемент может висеть в DOM
    // скрытым — учитываем только реально видимые
    for (const el of document.querySelectorAll('[class*="stop"], [class*="loading"], [class*="typing"]')) {
      if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') return true;
    }
    return false;
  }

  function assistantTexts() {
    return [...document.querySelectorAll('.ds-markdown, [class*="markdown"]')].map((b) => (b.innerText || '').trim());
  }

  // ожидание ответа ПОСЛЕ клика по отправке; snapshotBefore — снимок чата,
  // сделанный ДО клика, иначе мгновенный ответ неотличим от предыдущего
  async function waitAnswer(snapshotBefore, timeoutMs = 150000) {
    let prev = null;
    let stable = 0;
    let sawNew = false;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await wsleep(400);
      const texts = assistantTexts();
      let cur = null;
      if (texts.length > snapshotBefore.count) {
        cur = texts[texts.length - 1];
        sawNew = true;
      } else if (texts.length > 0 && texts[texts.length - 1] !== snapshotBefore.last) {
        cur = texts[texts.length - 1];
        sawNew = true;
      }
      if (sawNew && cur) {
        if (cur === prev) stable++;
        else stable = 0;
        prev = cur;
        // ответ стабилен ~3 сек и генерация завершена
        if (stable >= 8 && !isGenerating()) return cur;
      } else {
        stable = 0;
      }
    }
    return sawNew ? prev : null;
  }

  function looksLoggedOut() {
    const body = document.body.innerText || '';
    return /log ?in|sign ?in|войти в систему/i.test(body.slice(0, 2000)) && !findInput();
  }

  // DeepThink (рассуждения) замедляет ответы и сбивает ожидание конца стрима —
  // выключаем, если нашли его переключатель в состоянии «включено».
  // Один раз на загрузку страницы
  let deepThinkChecked = false;
  async function ensureDeepThinkOff() {
    if (deepThinkChecked) return;
    deepThinkChecked = true;
    try {
      const toggles = [...document.querySelectorAll('button, div[role="button"], span[role="button"], label')]
        .filter((el) => el.offsetParent !== null &&
          /deepthink|deep think|глубокое мышление|рассужд/i.test((el.textContent || '').trim()));
      for (const el of toggles) {
        if (el.getAttribute('aria-pressed') === 'true') {
          el.click();
          await sleep(300);
          await BG({ type: 'log', msg: 'DeepSeek: выключил режим глубокого мышления' });
        }
      }
    } catch (e) { /* не нашли переключатель — не критично */ }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'askDeepSeek') return;

    (async () => {
      try {
        const input = await waitFor('textarea, [contenteditable="true"]', 20000);
        if (!input) {
          if (looksLoggedOut()) {
            await BG({ type: 'notify', title: 'AutoTester — DeepSeek', message: 'Не залогинен в chat.deepseek.com. Залогинься один раз руками.' });
            sendResponse({ ok: false, error: 'DeepSeek не залогинен' });
          } else {
            sendResponse({ ok: false, error: 'не нашёл поле ввода DeepSeek' });
          }
          return;
        }
        await ensureDeepThinkOff();

        // если чат ещё генерирует прошлый ответ — ждём освобождения, иначе
        // следующий вопрос прилипнет к предыдущей генерации
        const busyT0 = Date.now();
        while (isGenerating() && Date.now() - busyT0 < 60000) await wsleep(1000);
        if (isGenerating()) {
          sendResponse({ ok: false, error: 'чат занят генерацией предыдущего ответа' });
          return;
        }

        await setInputText(input, msg.prompt);
        if (msg.screenshot) {
          const attached = await attachScreenshot(input, msg.screenshot);
          if (!attached) await BG({ type: 'log', msg: 'Скриншот не прицепился к DeepSeek, отправляю текстом', level: 'warn' });
        }

        const btn = findSendButton(input);
        const snapshotBefore = { count: assistantTexts().length, last: assistantTexts().slice(-1)[0] || null };
        send(input, btn);
        await wsleep(1200);

        const answer = await waitAnswer(snapshotBefore, msg.screenshot ? 180000 : 150000);
        if (!answer || answer.length === 0) {
          sendResponse({ ok: false, error: 'DeepSeek не вернул ответ (таймаут)' });
          return;
        }
        sendResponse({ ok: true, text: answer });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true; // async
  });
})();
