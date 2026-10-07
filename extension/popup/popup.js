// AutoTester BMSTU — popup.

const $ = (id) => document.getElementById(id);

async function render() {
  const { log = [] } = await chrome.storage.local.get(['log']);
  const logBox = $('log');
  logBox.replaceChildren();
  for (const e of log.slice(-30).reverse()) {
    const d = document.createElement('div');
    if (e.level === 'error') d.className = 'err';
    d.textContent = `[${new Date(e.t).toLocaleTimeString('ru')}] ${e.msg}`;
    logBox.appendChild(d);
  }
}

$('solve').addEventListener('click', async () => {
  const [tab] = await chrome.tabs['query']({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'solveNow' }).catch(() => {});
  window.close();
});

$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
