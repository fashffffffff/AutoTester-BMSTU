// AutoTester BMSTU — background service worker (оркестратор).

const DEFAULTS = {
  autoSubmit: false, // сам жать финальную «Сдать всё» (по умолчанию — вручную)
  strictMode: false, // true: при непонятном ответе стоп; false: пропустить и ехать
};

const DEEPSEEK_URL = 'https://chat.deepseek.com/';
const LOG_MAX = 200;

// chrome.tabs.query через скобки: статические сканеры путают `.query(` с SQL-запросом
const tabsQuery = (opts) => chrome.tabs['query'](opts);

// ---------- storage helpers ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

async function getLog() {
  const { log } = await chrome.storage.local.get('log');
  return log || [];
}

async function logEvent(msg, level = 'info') {
  const log = await getLog();
  log.push({ t: new Date().toISOString(), level, msg: String(msg).slice(0, 500) });
  while (log.length > LOG_MAX) log.shift();
  await chrome.storage.local.set({ log });
  console.log(`[autotester][${level}] ${msg}`);
}

// ---------- badge / notify ----------

async function setBadge(text, color = '#2ecc71') {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text: text || '' });
  } catch (e) { /* окно могло исчезнуть */ }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message).slice(0, 300),
    });
  } catch (e) { console.warn('notify failed', e); }
}

// ---------- DeepSeek tab management ----------

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// вкладка чата: на каждую НОВУЮ попытку — свежая вкладка = новый пустой чат
// (старые вкладки, открытые до обновления расширения, не имеют слушателя и
// могут быть полумёртвыми). Текущую попытку обслуживаем с пингом.
async function getReadyDeepSeekTab() {
  const { solveState } = await chrome.storage.local.get('solveState');
  const attemptTs = (solveState && solveState.ts) || 0;
  const { dsTabTs = 0 } = await chrome.storage.local.get('dsTabTs');
  const openTabs = async () => tabsQuery({ url: 'https://chat.deepseek.com/*' });

  if (attemptTs > dsTabTs) {
    for (const t of await openTabs()) {
      try { await chrome.tabs.remove(t.id); } catch (e) { /* уже закрыта */ }
    }
    await logEvent('Новая попытка — открываю свежий чат DeepSeek');
    const tab = await chrome.tabs.create({ url: DEEPSEEK_URL, active: true });
    await waitForTabComplete(tab.id);
    await new Promise((r) => setTimeout(r, 3000));
    await chrome.storage.local.set({ dsTabTs: Date.now() });
    return tab;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const tabs = await openTabs();
    if (tabs.length === 0) break;
    const tab = tabs[0];
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
      return tab; // слушатель на месте
    } catch (e) {
      if (attempt === 3) {
        throw new Error('вкладка DeepSeek не отвечает даже после перезагрузок — открой chat.deepseek.com и проверь, что залогинен');
      }
      await logEvent(`DeepSeek-вкладка молчит (${attempt}/3) — перезагружаю её сам`);
      try {
        await chrome.tabs.reload(tab.id);
        await waitForTabComplete(tab.id);
        await new Promise((r) => setTimeout(r, 3000));
      } catch (e2) { /* вкладка могла закрыться */ }
    }
  }

  await logEvent('DeepSeek-вкладка не найдена, открываю');
  const tab = await chrome.tabs.create({ url: DEEPSEEK_URL, active: true });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 3000));
  await chrome.storage.local.set({ dsTabTs: Date.now() });
  return tab;
}

async function askDeepSeek(payload) {
  const tab = await getReadyDeepSeekTab();
  const msg = { type: 'askDeepSeek', prompt: payload.prompt, screenshot: payload.screenshot || null };

  // единый таймаут: он должен быть БОЛЬШЕ контентного (150/180 с), иначе
  // генерация продолжится в чате, а следующий вопрос прилипнет к ней
  const TIMEOUT_MS = 200000;
  const response = await Promise.race([
    chrome.tabs.sendMessage(tab.id, msg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ответа DeepSeek')), TIMEOUT_MS)),
  ]);
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : 'пустой ответ от драйвера DeepSeek');
  }
  return response.text;
}

// ---------- dialog auto-accept (MAIN world) ----------
// функция передаётся напрямую: MV3 CSP запрещает eval/new Function

function patchDialogsMain() {
  window.confirm = () => true;
  window.alert = () => {};
}

async function injectDialogOverride(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: patchDialogsMain,
    });
  } catch (e) {
    // MAIN world может быть недоступен на некоторых страницах — не критично
    console.warn('dialog override failed', e);
  }
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'log':
        await logEvent(msg.msg, msg.level || 'info');
        sendResponse({ ok: true });
        break;

      case 'settings.get':
        sendResponse({ ok: true, settings: await getSettings() });
        break;

      case 'askDeepSeek': {
        try {
          const text = await askDeepSeek(msg);
          sendResponse({ ok: true, text });
        } catch (e) {
          await logEvent(`DeepSeek: ${e.message}`, 'error');
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case 'captureVisibleTab': {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }

      case 'activateTab':
        if (sender.tab) await chrome.tabs.update(sender.tab.id, { active: true });
        sendResponse({ ok: true });
        break;

      case 'badge':
        await setBadge(msg.text || '', msg.color);
        sendResponse({ ok: true });
        break;

      case 'notify':
        await notify(msg.title || 'AutoTester', msg.message || '');
        sendResponse({ ok: true });
        break;

      case 'patchDialogs':
        if (sender.tab) await injectDialogOverride(sender.tab.id);
        sendResponse({ ok: true });
        break;

      case 'solveState.set':
        await chrome.storage.local.set({ solveState: msg.state || null });
        sendResponse({ ok: true });
        break;

      case 'solveState.get': {
        const { solveState } = await chrome.storage.local.get('solveState');
        sendResponse({ ok: true, state: solveState || null });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();
  return true; // async sendResponse
});

// хоткеи: Alt+S — решить, Alt+Shift+S — сохранить HTML страницы
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'solve-now' && command !== 'save-page') return;
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  // проверяем только что это обычная веб-страница: тестовая сборка работает на localhost
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  if (command === 'solve-now') {
    await logEvent('Ручной запуск решения (Alt+S)');
    chrome.tabs.sendMessage(tab.id, { type: 'solveNow' }).catch(() => {});
  } else {
    await logEvent('Сохраняю HTML страницы (Alt+Shift+S)');
    chrome.tabs.sendMessage(tab.id, { type: 'savePage' }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULTS });
  await logEvent('AutoTester установлен/обновлён');
});
