import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_CONFIG, type UserConfig } from '../core/model/types';
import '../drawer/styles.css';

// Options 页面将持久化配置与默认值合并，兼容后续新增策略参数。
function App() {
  const [c, setC] = useState<UserConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get('kla:userConfig', (x) => {
      const saved = x['kla:userConfig'] as Partial<UserConfig> | undefined;
      setC({ ...DEFAULT_CONFIG, ...saved });
    });
  }, []);
  const save = () => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local)
      chrome.storage.local.set({ 'kla:userConfig': c });
  };
  return (
    <main>
      <header>
        <h1>策略设置</h1>
      </header>
      {Object.entries(c).map(([k, v]) => (
        <label key={k}>
          {k}
          <input
            value={String(v)}
            type={typeof v === 'boolean' ? 'checkbox' : 'number'}
            checked={typeof v === 'boolean' ? v : undefined}
            onChange={(e) =>
              setC({
                ...c,
                [k]: typeof v === 'boolean' ? e.target.checked : Number(e.target.value),
              })
            }
          />
        </label>
      ))}
      <button className="primary" onClick={save}>
        保存设置
      </button>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
