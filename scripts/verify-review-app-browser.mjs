// Optional visual/interaction check with a local simulated MCP Apps host.
// Set MEDCIUS_PLAYWRIGHT_PACKAGE to an installed Playwright package directory.
// This does not exercise Codex/ChatGPT native hosting or invoke a model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createReviewAppConfig } from '../plugins/medcius/servers/review-app/src/config.mjs';
import { runOnce } from '../plugins/medcius/servers/shared/rpc.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.MEDCIUS_PLAYWRIGHT_PACKAGE||'playwright');
const cfg=createReviewAppConfig();
const initial=await runOnce(cfg,'medcius_review_workspace',{});
const app=readFileSync(new URL('../plugins/medcius/servers/review-app/src/review.html',import.meta.url),'utf8');
const parent=`<!doctype html><html><body style="margin:0"><iframe id="app" title="模拟宿主中的合成核对工作区" style="border:0;width:100%;height:100vh"></iframe><script>
const iframe=document.getElementById('app');
window.addEventListener('message',async e=>{if(e.source!==iframe.contentWindow)return;const m=e.data;if(m.method==='ui/notifications/initialized'){iframe.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:await window.syntheticInitial()},'*');return;}if(!m.id)return;try{const result=await window.syntheticRpc(m);iframe.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},'*');}catch{iframe.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Synthetic host error'}},'*');}});
iframe.srcdoc=${JSON.stringify(app).replaceAll('<',String.fromCharCode(92)+'u003c')};
</script></body></html>`;
new vm.Script(parent.match(/<script>([\s\S]*?)<\/script>/)[1]);
const browser=await chromium.launch({headless:true,...(process.env.MEDCIUS_BROWSER_EXECUTABLE?{executablePath:process.env.MEDCIUS_BROWSER_EXECUTABLE}:{})});
const out=resolve('out/review-app');mkdirSync(out,{recursive:true});
const messages=[],errors=[];let inspectedPage;
try{
  const page=await browser.newPage({viewport:{width:1280,height:960}});inspectedPage=page;
  page.on('pageerror',e=>errors.push(e.stack));
  await page.exposeFunction('syntheticInitial',()=>initial);
  await page.exposeFunction('syntheticRpc',async m=>{
    if(m.method==='ui/initialize')return {protocolVersion:'2026-01-26',hostInfo:{name:'synthetic-test-host',version:'1'},hostCapabilities:{message:{text:{}},updateModelContext:{text:{}},experimental:{'openai/message':{}}},hostContext:{}};
    if(m.method==='tools/call')return runOnce(cfg,m.params.name,m.params.arguments);
    if(['ui/update-model-context','ui/message'].includes(m.method)){messages.push(m);return {};}
    throw Error('unsupported');
  });
  await page.route('**/*',route=>route.request().url()==='https://synthetic.medcius.invalid/'?route.fulfill({contentType:'text/html; charset=utf-8',body:parent}):route.abort());
  await page.goto('https://synthetic.medcius.invalid/');
  const frame=page.frameLocator('#app');
  await frame.getByRole('button',{name:'列入重点',exact:true}).first().waitFor();
  await frame.getByRole('button',{name:'列入重点',exact:true}).first().click();
  await frame.getByText('已选择 1 / 12 项 · 核对中',{exact:true}).waitFor();
  await frame.getByRole('button',{name:'标记存疑',exact:true}).first().click();
  await frame.locator('.tag').filter({hasText:'存疑'}).waitFor();
  await frame.locator('summary').first().click();
  await frame.getByLabel('补充问题（勿填身份信息）').fill('请核对更正前后版本及人工确认状态。');
  await frame.getByRole('button',{name:'保存问题',exact:true}).click();
  await frame.getByRole('button',{name:'预览核对请求',exact:true}).click();
  await frame.getByText('请查看预览；仅选中的条目和已保存问题会提交。',{exact:true}).waitFor();
  await page.screenshot({path:resolve(out,'desktop.png'),fullPage:true});
  await frame.getByRole('button',{name:'将所选依据放入对话上下文',exact:true}).click();
  await frame.getByText('已附加所选依据；尚未请求模型核对',{exact:true}).waitFor();
  await frame.getByRole('button',{name:'提交所选问题，请宿主核对',exact:true}).click();
  await frame.getByText('已提交宿主，等待对话中的核对结果；尚未完成复核。',{exact:true}).waitFor();
  assert.equal(messages.filter(m=>m.method==='ui/message').length,1);
  assert.equal(JSON.parse(messages.find(m=>m.method==='ui/update-model-context'&&m.params.content.length).params.content[0].text).items.length,1);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(out,'mobile.png'),fullPage:true});
  const overflow=await frame.locator('body').evaluate(el=>el.scrollWidth>el.clientWidth);assert.equal(overflow,false);
  assert.deepEqual(errors,[]);
  writeFileSync(resolve(out,'browser-check.json'),JSON.stringify({scope:'synthetic_host_simulation',desktop:true,mobile:true,selected_context:true,explicit_message:true,horizontal_overflow:false,page_errors:errors,native_host_acceptance:'NOT_RUN',clinical_evidence:'NOT_ESTABLISHED'},null,2));
  console.log('ALL MCP REVIEW BROWSER SIMULATION CHECKS PASSED; native_host_acceptance=NOT_RUN');
}catch(error){
  console.error(JSON.stringify({errors,frames:await Promise.all(inspectedPage.frames().map(async frame=>({url:frame.url(),body:(await frame.locator('body').innerText({timeout:1000}).catch(()=>'' )).slice(0,500)})))}));
  throw error;
}finally{await browser.close();}
