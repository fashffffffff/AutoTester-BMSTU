// AutoTester BMSTU — options page.

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  autoSubmit: false,
  strictMode: false,
};

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...settings };
  $('autoSubmit').checked = s.autoSubmit;
  $('strictMode').checked = s.strictMode;
}

$('save').addEventListener('click', async () => {
  const settings = {
    autoSubmit: $('autoSubmit').checked,
    strictMode: $('strictMode').checked,
  };
  await chrome.storage.local.set({ settings });
  const saved = $('saved');
  saved.style.opacity = 1;
  setTimeout(() => { saved.style.opacity = 0; }, 1500);
});

load();
