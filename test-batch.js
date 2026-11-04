import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from './image-core.js';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
async function fixture(t) {
 const workspace = await mkdtemp(path.join(tmpdir(), 'yomi-batch-'));
 const original = globalThis.fetch;
 t.after(async () => { globalThis.fetch = original; assert.ok(path.basename(workspace).startsWith('yomi-batch-')); await rm(workspace, { recursive: true, force: true }); });
 return { workspace, apiKey: 'fake-test-key' };
}
test('five POSTs start before any response, reverse completion preserves input order and partial success', async t => {
 const options = await fixture(t); const releases = []; let ready;
 const started = new Promise(resolve => { ready = resolve; });
 globalThis.fetch = (_url, init) => new Promise(resolve => { releases.push({ resolve, prompt: JSON.parse(init.body).prompt }); if(releases.length === 5) ready(); });
 const resultPromise = run('generate_images', { tasks: Array.from({length:5}, (_,i)=>({ prompt: `photo${i}`, output_mode:'file' })) }, options);
 await Promise.race([started, new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('requests were serialized')),1500);timer.unref();})]);
 assert.deepEqual(releases.map(r=>r.prompt), ['photo0','photo1','photo2','photo3','photo4']);
 for(let i=4;i>=0;i--) releases[i].resolve(i===2?new Response('',{status:429}):Response.json({data:[{b64_json:png}]}));
 const result=await resultPromise;const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 assert.match(text,/成功4项，失败1项/);assert.match(text,/任务1：成功[\s\S]*任务2：成功[\s\S]*任务3：失败[\s\S]*任务4：成功[\s\S]*任务5：成功/);assert.equal(releases.length,5);
});
test('whole batch validates before fetch and aggregate approval gates every POST', async t=>{
 const options=await fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[{b64_json:png}]})};
 for(const tasks of [[],Array(6).fill({prompt:'x'}),[{prompt:'ok'},{prompt:''}]]) await assert.rejects(run('generate_images',{tasks},options));
 assert.equal(calls,0);
 const tasks=[{prompt:'regular',output_mode:'file'},{prompt:'4K',output_mode:'file'}];
 await assert.rejects(run('generate_images',{tasks},{...options,approve:()=>false}),/批准/);assert.equal(calls,0);
 let approvals=0;
 await run('generate_images',{tasks},{...options,approve:request=>{approvals++;assert.equal(calls,0);assert.equal(request.tasks.length,2);assert.equal(request.tasks[1].model,'gpt-image-2.5-sunburst');return true;}});
 assert.equal(approvals,1);assert.equal(calls,2);
});
