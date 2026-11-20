(() => {
  'use strict';
  // management-polish.css hides these explanatory elements; their text becomes the
  // hover tooltip of the surrounding element so the information is still one hover away.
  const TOOLTIP_SOURCES = [
    'dashboard-module__statHint___', 'dashboard-module__sectionDescription___', 'dashboard-module__ctaDescription___',
    'dashboard-module__heroPanelMeta___', 'OAuthPage-module__featuredHint___', 'OAuthPage-module__cardHint___',
    'SectionCard-module__description___', 'Field-module__toggleDescription___', 'PluginsPage-module__description___',
    'PluginsPage-module__metaPath___', 'PluginStorePage-module__description___', 'SystemPage-module__sectionDescription___',
    'SystemPage-module__linkDesc___',
  ];
  const selector = [
    ...TOOLTIP_SOURCES.map(name => `[class*="${name}"]`),
    '[class*="Field-module__group___"] .hint',
    '[class*="statusPathValue___"]',
    '[class*="PluginStorePage-module__securityBannerText___"]',
  ].join(',');

  // Plugin Store meta rows repeat install/source labels on every card; keep version, author and license.
  const hideLabelledMeta = () => {
    for (const item of document.querySelectorAll('[class*="PluginStorePage-module__cardMeta___"] > [class*="PluginStorePage-module__metaItem___"]:not([data-dq-hide])')) {
      const own = [...item.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
      if (own.includes(':')) item.dataset.dqHide = '1';
    }
    // The first remaining item should not open with a separator dot.
    for (const meta of document.querySelectorAll('[class*="PluginStorePage-module__cardMeta___"]')) {
      const first = [...meta.children].find(item => !item.dataset.dqHide);
      const dot = first?.querySelector(':scope > [class*="PluginStorePage-module__metaDot___"]');
      if (dot && !dot.dataset.dqHide) dot.dataset.dqHide = '1';
    }
  };

  const apply = () => {
    hideLabelledMeta();
    for (const element of document.querySelectorAll(selector)) {
      const text = element.textContent.trim().replace(/\s+/g, ' ');
      if (!text || element.dataset.dqTip === text) continue;
      element.dataset.dqTip = text;
      // Visible elements (paths, the security banner) carry their own tooltip; hidden ones lend it to the parent.
      const host = getComputedStyle(element).display === 'none' ? element.parentElement : element;
      if (host && (!host.title || host.dataset.dqTipHost === '1')) {
        host.title = text;
        host.dataset.dqTipHost = '1';
      }
    }
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  };
  const start = () => {
    apply();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
