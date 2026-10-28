import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('plugin config slot supports secret save/retain/clear without reading back saved Key', async () => {
  let module, Component;
  let values = [], index = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) { const i = index++; if (!(i in values)) values[i] = initial; return [values[i], v => { values[i] = v; }]; },
  };
  vm.runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { confirm: () => true, __ModuleLoader__: { load(value) { module = value.factory(() => React); } } },
  });
  module.apply({ slots: { inject(_name, cb) { cb(); }, register(options, component) {
    assert.equal(options.key, 'dsh-yomi-image-mcp#yomi-image-mcp'); Component = component;
  } } });
  const calls = [];
  const form = { state: { status: 'ready', writable: true, revision: 1, value: { workspace: '/work' } },
    async mutate(ops, rev) { calls.push(JSON.parse(JSON.stringify(ops))); assert.equal(rev, 1); return true; } };
  const render = () => { index = 0; return Component({ view: 'page', form }); };
  const all = tree => [tree, ...tree.children.filter(x => x && typeof x === 'object').flatMap(all)];
  let tree = render();
  const input = all(tree).find(x => x.type === 'input' && x.props.type === 'password');
  assert.equal(input.props.value, '');
  input.props.onChange({ target: { value: 'new-test-key' } });
  tree = render();
  await tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls[0], [{ op: 'set', path: ['workspace'], value: '/work' }, { op: 'set', path: ['apiKey'], value: 'new-test-key' }]);
  tree = render();
  assert.equal(all(tree).find(x => x.type === 'input' && x.props.type === 'password').props.value, '');
  await tree.props.onSubmit({ preventDefault() {} });
  assert.equal(calls[1].length, 1);
  tree = render();
  await all(tree).find(x => x.type === 'button' && x.children.includes('清除 Key')).props.onClick();
  assert.deepEqual(calls[2], [{ op: 'set', path: ['apiKey'], value: '' }]);
});
