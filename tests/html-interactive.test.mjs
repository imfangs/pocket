import test from 'node:test';import assert from 'node:assert/strict';
import {parse} from 'parse5';import {renderInteractiveHtmlPreview,renderHtmlPreview} from '../shared/html-preview.mjs';
function all(html){const out=[],pending=[parse(html,{scriptingEnabled:true})];while(pending.length){const n=pending.pop();out.push(n);if(n.content)pending.push(n.content);pending.push(...n.childNodes||[]);}return out;}
const attr=(n,k)=>n.attrs?.find(a=>a.name===k)?.value;
test('interactive documents retain authored scripts, events, controls and HTTPS web resources',()=>{
 const source='<style>@import url(https://assets.example/style.css)</style><link rel="stylesheet" href="https://assets.example/extra.css"><script src="https://assets.example/chart.js"></script><script>window.boot=1</script><input id="search"><button onclick="window.boot++">Go</button><a href="https://example.com">Source</a>';
 const doc=renderInteractiveHtmlPreview(source),nodes=all(doc);
 assert.equal(nodes.filter(n=>n.tagName==='script').length,2);assert.match(doc,/window.boot=1/);
 assert.match(doc,/onclick="window.boot\+\+"/);assert.ok(nodes.filter(n=>['input','button'].includes(n.tagName)).every(n=>attr(n,'disabled')===undefined));
 assert.match(doc,/https:\/\/assets.example\/chart.js/);assert.match(doc,/https:\/\/assets.example\/extra.css/);assert.match(doc,/https:\/\/example.com/);
 assert.doesNotMatch(doc,/script-src &#39;none&#39;|http-equiv="Content-Security-Policy"/);
});
test('interactive image mapping changes only approved local image transport, not original source',()=>{
 const original='<img src="raw/a.png" srcset="raw/high.png 2x" onerror="fallback()"><img src="https://assets.example/photo.jpg"><input type="checkbox">';
 const mapped=renderInteractiveHtmlPreview(original,{'raw/a.png':'data:image/png;base64,YQ=='});const images=all(mapped).filter(n=>n.tagName==='img').reverse();
 assert.equal(attr(images[0],'src'),'data:image/png;base64,YQ==');assert.equal(attr(images[0],'srcset'),undefined);assert.equal(attr(images[0],'onerror'),'fallback()');assert.equal(attr(images[1],'src'),'https://assets.example/photo.jpg');
 assert.ok(original.includes('raw/a.png'));assert.doesNotMatch(mapped,/disabled/);
});
test('interactive parsing matches normal scripting and removes stale file policies or shell reload',()=>{
 const doc=renderInteractiveHtmlPreview('<meta http-equiv="refresh" content="0"><meta http-equiv="Content-Security-Policy" content="script-src none"><noscript><img src="fallback.jpg"></noscript><script>var example="<b>literal</b>";</script>');
 assert.ok(all(doc).filter(n=>n.tagName==='meta').length===0);assert.equal(all(doc).filter(n=>n.tagName==='noscript')[0].childNodes[0].nodeName,'#text');assert.match(doc,/var example="<b>literal<\/b>"/);
});
test('legacy static rendering remains inert and excessive interactive structure is explicit',()=>{
 assert.doesNotMatch(renderHtmlPreview('<script>boot()</script><input>'),/<script>/);
 assert.throws(()=>renderInteractiveHtmlPreview('<div>'.repeat(270)+'x'+'</div>'.repeat(270)),e=>e.code==='html_preview_complex');
});

test("serialization expansion cannot silently exceed the runtime projection budget",()=>{
 const image="data:image/png;base64,"+Buffer.alloc(2*1024*1024).toString("base64");
 const body="<div title='"+"\"".repeat(1048000)+"'></div>"+Array.from({length:4},(_,i)=>`<img src="${i}.png">`).join("");
 const images=Object.fromEntries(Array.from({length:4},(_,i)=>[`${i}.png`,image]));
 assert.ok(Buffer.byteLength(body)<=1024*1024);
 assert.throws(()=>renderInteractiveHtmlPreview(body,images),error=>error.code==="html_preview_complex");
});

test('links and forms open a new browsing context rather than replacing Pocket',()=>{
 const doc=renderInteractiveHtmlPreview('<a href="https://example.com" target="_top">External</a><form target="_parent"><button formtarget="_TOP">Submit</button></form>');
 for(const node of all(doc))for(const attribute of node.attrs||[])if(['target','formtarget'].includes(attribute.name))assert.equal(attribute.value,'_blank');
 assert.match(doc,/https:\/\/example.com/);
});
