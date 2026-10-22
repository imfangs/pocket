import test from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkError, readableRequestError } from '../src/requestError.ts';
test('WebKit and other network messages have one readable presentation',()=>{
 for(const value of ['Load failed','Fetch is aborted','Failed to fetch','Network request failed',new DOMException('The operation was aborted.','AbortError')]){
  assert.equal(isNetworkError(value),true);assert.equal(readableRequestError(value),'连接暂时中断，请重试。');
 }
 assert.equal(readableRequestError('连接 Mac 较慢，正在自动重试。'),'连接较慢，请重试。');
 assert.equal(readableRequestError('当前离线，联网后会自动恢复。'),'当前离线，联网后会恢复。');
});
test('display formatting never changes receipt status, code or cancellation semantics',()=>{
 const error=Object.assign(new Error('Load failed'),{status:503,code:'native_unknown'});
 readableRequestError(error);
 assert.equal(error.message,'Load failed');assert.equal(error.status,503);assert.equal(error.code,'native_unknown');
 const validation='附件已失效，请重新添加。';assert.equal(isNetworkError(validation),false);assert.equal(readableRequestError(validation),validation);
 assert.equal(readableRequestError(new Error('unknown internal error'),'暂时无法核对。'),'暂时无法核对。');
});
