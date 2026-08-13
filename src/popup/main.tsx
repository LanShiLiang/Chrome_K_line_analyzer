import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalLink, Settings } from 'lucide-react';
import '../drawer/styles.css';

// Popup 仅提供扩展入口，核心行情与分析交互统一留在 Side Panel。
function App() {
  const open = () =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId !== undefined) chrome.sidePanel.open({ tabId });
    });
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">K LINE ANALYZER</span>
          <h1>量价分析器</h1>
        </div>
      </header>
      <button className="primary" onClick={open}>
        <ExternalLink />
        打开侧边分析面板
      </button>
      <button onClick={() => chrome.runtime.openOptionsPage()}>
        <Settings />
        设置
      </button>
      <p className="warning">分析结果仅供技术研究，不构成投资建议。</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
