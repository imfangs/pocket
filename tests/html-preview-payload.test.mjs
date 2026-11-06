import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtmlPreviewPayload } from '../src/htmlPreviewPayload.ts';
const name='report.html';
const source=Buffer.from('\ufeff<html><body>Original source</body></html>');
const payload=()=>({schemaVersion:1,name,sourceBase64:source.toString('base64'),images:{},omittedImages:0});
test('HTML preview decodes the exact original file bytes and separates approved images',async()=>{
 const data=payload();data.images['nested/image.png']={type:'image/png',base64:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
 const result=decodeHtmlPreviewPayload(data,name);
 assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),source);
 assert.equal(result.images['nested/image.png'],'data:image/png;base64,iVBORw0KGgo=');
 assert.equal(Object.getPrototypeOf(result.images),null);assert.equal(result.imagesAvailable,true);
});
test('malformed HTML preview responses never become a document or path request',()=>{
 for(const data of [null,[],{...payload(),schemaVersion:2},{...payload(),name:'other.html'},
 {...payload(),sourceBase64:'a==='},{...payload(),sourceBase64:'AB=='},{...payload(),sourceBase64:'!bad'},
 {...payload(),omittedImages:-1},{...payload(),omittedImages:0.5},{...payload(),images:[]},
 {...payload(),images:{x:{type:'text/html',base64:'AAAA'}}},
 {...payload(),images:{x:{type:'image/svg+xml',base64:'AAAA'}}},
 {...payload(),images:{x:{type:'image/png',base64:'AAAA\n'}}}])assert.throws(()=>decodeHtmlPreviewPayload(data,name),/HTML 预览读取未完成/);
});
test('HTML preview enforces source, image, aggregate and manifest budgets before rendering',()=>{
 const b64=bytes=>Buffer.alloc(bytes).toString('base64');
 assert.throws(()=>decodeHtmlPreviewPayload({...payload(),sourceBase64:b64(1024*1024+1)},name));
 assert.throws(()=>decodeHtmlPreviewPayload({...payload(),images:{x:{type:'image/png',base64:b64(2*1024*1024+1)}}},name));
 assert.throws(()=>decodeHtmlPreviewPayload({...payload(),images:Object.fromEntries(Array.from({length:33},(_,i)=>[String(i),{type:'image/png',base64:'AAAA'}]))},name));
 assert.throws(()=>decodeHtmlPreviewPayload({...payload(),images:Object.fromEntries(Array.from({length:5},(_,i)=>[String(i),{type:'image/png',base64:b64(2*1024*1024)}]))},name));
});
