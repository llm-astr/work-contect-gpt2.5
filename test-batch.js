import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
test('eight POSTs start before any response, reverse completion preserves input order and partial success', async t => {
 const options = await fixture(t); const releases = []; let ready;
 const started = new Promise(resolve => { ready = resolve; });
 globalThis.fetch = (_url, init) => new Promise(resolve => { releases.push({ resolve, prompt: JSON.parse(init.body).prompt }); if(releases.length === 8) ready(); });
 const resultPromise = run('generate_images', { tasks: Array.from({length:8}, (_,i)=>({ prompt: `photo${i}`, output_mode:'file' })) }, options);
 await Promise.race([started, new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('requests were serialized')),1500);timer.unref();})]);
 assert.deepEqual(releases.map(r=>r.prompt), Array.from({length:8}, (_,i)=>`photo${i}`));
 for(let i=7;i>=0;i--) releases[i].resolve(i===2?new Response('',{status:429}):Response.json({data:[{b64_json:png}]}));
 const result=await resultPromise;const text=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 assert.match(text,/成功7项，失败1项/);assert.match(text,/任务1：成功[\s\S]*任务2：成功[\s\S]*任务3：失败[\s\S]*任务4：成功[\s\S]*任务5：成功/);assert.equal(releases.length,8);
});
test('batch edits submit every reference before any response', async t => {
 const options=await fixture(t);await Promise.all(Array.from({length:4},(_,i)=>writeFile(path.join(options.workspace,`source${i}.png`),Buffer.from(png,'base64'))));
 const releases=[];let ready;const started=new Promise(resolve=>{ready=resolve});
 globalThis.fetch=(url,init)=>new Promise(resolve=>{assert.equal(url,'https://api.yomiapi.com/v1/images/edits');releases.push({resolve,body:init.body});if(releases.length===4)ready()});
 const resultPromise=run('edit_images',{tasks:Array.from({length:4},(_,i)=>({prompt:`same style ${i}`,image_paths:[`source${i}.png`],output_mode:'file'}))},options);
 await Promise.race([started,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('edit requests were serialized')),1500);timer.unref()})]);
 assert.ok(releases.every(r=>r.body instanceof FormData));assert.deepEqual(releases.map(r=>r.body.get('prompt')),Array.from({length:4},(_,i)=>`same style ${i}`));
 for(let i=3;i>=0;i--)releases[i].resolve(Response.json({data:[{b64_json:png}]}));
 const result=await resultPromise;assert.match(result.content[0].text,/批量编辑：共4项，成功4项/);assert.equal(releases.length,4);
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[{b64_json:png}]})};
 await assert.rejects(run('edit_images',{tasks:[{prompt:'valid',image_paths:['source0.png']},{prompt:'missing',image_paths:['missing.png']}]},options));assert.equal(calls,0);
});

test('whole batch validates before fetch and aggregate approval gates every POST', async t=>{
 const options=await fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[{b64_json:png}]})};
 for(const tasks of [[],[{prompt:'ok'},{prompt:''}]]) await assert.rejects(run('generate_images',{tasks},options));
 assert.equal(calls,0);
 const tasks=[{prompt:'regular',output_mode:'file'},{prompt:'4K',output_mode:'file'}];
 await assert.rejects(run('generate_images',{tasks},{...options,approve:()=>false}),/批准/);assert.equal(calls,0);
 let approvals=0;
 await run('generate_images',{tasks},{...options,approve:request=>{approvals++;assert.equal(calls,0);assert.equal(request.tasks.length,2);assert.equal(request.tasks[1].model,'gpt-image-2.5-sunburst');return true;}});
 assert.equal(approvals,1);assert.equal(calls,2);
});
