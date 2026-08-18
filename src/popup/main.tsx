import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalLink } from 'lucide-react';
import { localizeDocument, t } from '../shared/i18n';
import '../drawer/styles.css';

localizeDocument();

// Popup 仅提供扩展入口，核心行情与分析交互统一留在 Side Panel。
function App() {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string>();
  const open = async () => {
    if (closing) return;
    setClosing(true);
    setError(undefined);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) {
        setClosing(false);
        setError(t('error_current_tab_not_found'));
        return;
      }
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (openError) {
      console.error('Unable to open the analysis side panel.', openError);
      setClosing(false);
      setError(t('error_open_side_panel'));
    }
  };
  return (
    <main className={`popup-shell${closing ? ' is-closing' : ''}`}>
      <header>
        <div>
          <span className="eyebrow">K LINE ANALYZER</span>
          <h1>{t('popup_title')}</h1>
        </div>
      </header>
      <button
        className="primary"
        data-testid="open-side-panel"
        disabled={closing}
        onClick={() => void open()}
      >
        <ExternalLink />
        {closing ? t('popup_opening') : t('popup_open_panel')}
      </button>
      {error && <p className="error popup-error">{error}</p>}
      <p className="privacy-note">{t('popup_privacy')}</p>
      <p className="warning">{t('disclaimer')}</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
