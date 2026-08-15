import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalLink } from 'lucide-react';
import '../drawer/styles.css';

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
      if (tab?.id === undefined) throw new Error('未找到当前标签页');
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (openError) {
      setClosing(false);
      setError(openError instanceof Error ? openError.message : '无法打开侧边分析面板');
    }
  };
  return (
    <main className={`popup-shell${closing ? ' is-closing' : ''}`}>
      <header>
        <div>
          <span className="eyebrow">K LINE ANALYZER</span>
          <h1>量价分析器</h1>
        </div>
      </header>
      <button className="primary" disabled={closing} onClick={() => void open()}>
        <ExternalLink />
        {closing ? '正在打开…' : '打开侧边分析面板'}
      </button>
      {error && <p className="error popup-error">{error}</p>}
      <p className="warning">分析结果仅供技术研究，不构成投资建议。</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
