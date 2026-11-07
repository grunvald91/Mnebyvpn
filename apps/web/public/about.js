/* Accessible, optional project information dialog; no personal data is read. */
(() => {
  'use strict';
  const dialog = document.getElementById('about-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const tabs = Array.from(dialog.querySelectorAll('[data-about-tab]'));
  const panels = Array.from(dialog.querySelectorAll('[data-about-panel]'));
  const names = new Set(['about', 'security', 'bonus', 'roadmap']);
  function selectTab(name, focus = false) {
    if (!names.has(name)) return;
    tabs.forEach(tab => {
      const selected = tab.dataset.aboutTab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    panels.forEach(panel => { panel.hidden = panel.dataset.aboutPanel !== name; });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.aboutTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 :
        event.key === 'End' ? tabs.length - 1 :
          (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[target].dataset.aboutTab, true);
    });
  });
  document.querySelectorAll('[data-about-open]').forEach(button => {
    button.addEventListener('click', () => {
      selectTab(button.dataset.aboutOpen || 'about');
      if (!dialog.open) dialog.showModal();
    });
  });
  dialog.querySelector('[data-about-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-about-close-link]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
})();
