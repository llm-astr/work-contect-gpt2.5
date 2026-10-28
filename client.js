window.__ModuleLoader__.load({
  id: 'dsh-yomi-image-mcp',
  factory(require) {
    const React = require('react'), h = React.createElement;
    function Settings({ view, form }) {
      const [key, setKey] = React.useState('');
      const [workspace, setWorkspace] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      if (view !== 'page') return h('span', null, 'API Key / 工作区');
      if (!form || form.state.status !== 'ready') return h('p', null, '配置暂不可用，请确认插件已启用。');
      const value = workspace ?? form.state.value?.workspace ?? '';
      const disabled = busy || !form.state.writable;
      async function mutate(ops) {
        setBusy(true); setNotice('');
        try {
          const ok = await form.mutate(ops, form.state.revision);
          if (ok) { setKey(''); setWorkspace(null); setNotice('已保存，下次调用生效。'); }
          else setNotice('保存失败或配置已变化，请重试。');
        } catch { setNotice('保存失败，请重试。'); }
        finally { setBusy(false); }
      }
      async function save(event) {
        event.preventDefault();
        if (disabled) return;
        const ops = [{ op: 'set', path: ['workspace'], value }];
        if (key.trim()) ops.push({ op: 'set', path: ['apiKey'], value: key.trim() });
        await mutate(ops);
      }
      const inputStyle = { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 6, padding: 8, color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: 6 };
      return h('form', { onSubmit: save, style: { display: 'grid', gap: 14, maxWidth: 600, padding: 12 } },
        h('label', null, 'API Key', h('input', { type: 'password', autoComplete: 'new-password', value: key, placeholder: '输入新 Key；留空保留原值', onChange: e => setKey(e.target.value), disabled, style: inputStyle })),
        h('small', null, '输入隐藏，原值不回显。Key 保存在本机 profile 配置中，不是加密保险库。请勿分享 profile。'),
        h('label', null, '工作区目录', h('input', { type: 'text', value, onChange: e => setWorkspace(e.target.value), disabled, style: inputStyle })),
        h('small', null, '使用绝对路径；参考图须在此目录内。不自动跟随聊天会话目录。'),
        h('div', { style: { display: 'flex', gap: 12 } },
          h('button', { type: 'submit', disabled }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', disabled, onClick: async () => { if (window.confirm('清除已保存的 API Key？')) await mutate([{ op: 'set', path: ['apiKey'], value: '' }]); } }, '清除 Key')),
        h('p', { role: 'status', 'aria-live': 'polite' }, notice));
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-yomi-image-mcp#yomi-image-mcp' }, Settings));
    } };
  },
});
